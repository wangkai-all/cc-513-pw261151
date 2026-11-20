/**
 * HTTP layer.
 *
 * Authentication is intentionally trivial (an `X-Caller-Id` header) because the
 * interesting part of this service is the privacy policy, not the identity
 * provider. Everything downstream — authorization, budget, audit — is keyed on
 * the server-side caller record, never on anything the client sends.
 *
 * Routes
 *   GET  /api/health
 *   GET  /api/meta                      policy, dimensions, options, callers
 *   GET  /api/me                        current caller, budget, authority version
 *   GET  /api/me/history                this caller's ledger + audit entries
 *   GET  /api/me/cohorts                cohorts this caller already received
 *   POST /api/query                     run a privacy-preserving aggregate query
 *   GET  /api/admin/overview            policy, cache stats, audit chain status
 *   GET  /api/admin/audit?limit=&actor=
 *   GET  /api/admin/audit/verify        recompute the hash chain
 *   GET  /api/admin/ledger?caller=&limit=
 *   POST /api/admin/policy              update policy (audited; bumps version)
 *   POST /api/admin/cache/purge
 *   POST /api/admin/cache/purge-expired
 *   POST /api/admin/callers/:id/revoke
 *   POST /api/admin/callers/:id/restore
 *   POST /api/admin/callers/:id/permissions
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { PrivacyEngine, QueryError, OUTCOME } from './privacy.js';
import { POLICY_EDITABLE_LIMITS, METRICS, DIMENSIONS, GROUP_BY_OPTIONS } from './config.js';
import { AGE_BANDS } from './seed-data.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large', '请求体过大');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体必须是 JSON 对象');
  }
}

/** Validate an admin policy patch against POLICY_EDITABLE_LIMITS. */
export function validatePolicyPatch(patch) {
  const clean = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    const limits = POLICY_EDITABLE_LIMITS[key];
    if (!limits) throw new HttpError(400, 'unknown_policy_field', `未知策略字段: ${key}`);
    if ('boolean' in limits) {
      if (typeof value !== 'boolean') {
        throw new HttpError(400, 'invalid_policy_value', `${key} 必须是布尔值`);
      }
      clean[key] = value;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new HttpError(400, 'invalid_policy_value', `${key} 必须是数字`);
    }
    if (limits.integer && !Number.isInteger(value)) {
      throw new HttpError(400, 'invalid_policy_value', `${key} 必须是整数`);
    }
    if (value < limits.min || value > limits.max) {
      throw new HttpError(
        400,
        'invalid_policy_value',
        `${key} 必须在 ${limits.min} 到 ${limits.max} 之间`,
      );
    }
    clean[key] = value;
  }
  if (Object.keys(clean).length === 0) {
    throw new HttpError(400, 'empty_policy_patch', '没有可更新的策略字段');
  }
  return clean;
}

export function createApp({ dbPath = process.env.DB_PATH ?? ':memory:', engineOptions = {} } = {}) {
  const store = new Store(dbPath);
  const engine = new PrivacyEngine(store, engineOptions);
  return { store, engine };
}

async function serveStatic(res, pathname) {
  const clean = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const relative = clean === '/' || clean === '.' || clean === '\\' ? 'index.html' : clean;
  let filePath = resolve(join(PUBLIC_DIR, relative));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    return sendJson(res, 403, { error: { code: 'forbidden', message: '路径不允许' } });
  }
  let body;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
    body = await readFile(filePath);
  } catch {
    // No SPA fallback: the client asks for concrete asset paths. Serving
    // index.html for any miss would make traversal attempts look successful.
    return sendJson(res, 404, { error: { code: 'not_found', message: '文件不存在' } });
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
  });
  res.end(body);
}

function callerIdFrom(req) {
  const header = req.headers['x-caller-id'];
  if (typeof header !== 'string' || header.trim() === '') return null;
  return header.trim().slice(0, 64);
}

function isAdmin(req) {
  // In production this would be a real role check; here it is an explicit
  // header so the demo UI can drive the admin console from the same browser.
  return req.headers['x-admin'] === '1';
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(403, 'admin_required', '需要管理员身份');
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clampLimit(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 1000);
}

function policySnapshot(policy) {
  return {
    version: policy.version,
    k: policy.k,
    perQueryEpsilon: policy.perQueryEpsilon,
    perCallerEpsilonCap: policy.perCallerEpsilonCap,
    repeatLimit: policy.repeatLimit,
    repeatWindowMs: policy.repeatWindowMs,
    cacheTtlMs: policy.cacheTtlMs,
    complementarySuppression: policy.complementarySuppression,
    differencingProtection: policy.differencingProtection,
    showCohortSize: policy.showCohortSize,
  };
}

function requireCaller(req, store) {
  const callerId = callerIdFrom(req);
  if (!callerId) throw new HttpError(401, 'missing_caller', '缺少 X-Caller-Id');
  const caller = store.getCaller(callerId);
  if (!caller) throw new HttpError(404, 'caller_not_found', '调用方不存在');
  return caller;
}

export function requestHandler(store, engine) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method ?? 'GET';

    try {
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          employees: store.countEmployees(),
          audit: store.verifyAuditChain(),
          cache: store.cacheStats(),
        });
      }

      // ------------------------------------------------------------- public
      if (pathname === '/api/meta' && method === 'GET') {
        return sendJson(res, 200, {
          metrics: Object.values(METRICS).map((metric) => ({
            id: metric.id,
            label: metric.label,
            unit: metric.unit,
            kind: metric.kind,
            description: metric.description,
          })),
          dimensions: Object.values(DIMENSIONS).map((dimension) => ({
            id: dimension.id,
            label: dimension.label,
            values:
              dimension.id === 'ageBand' ? AGE_BANDS : store.distinctValues(dimension.column),
          })),
          groupBy: GROUP_BY_OPTIONS,
          policy: store.getPolicy(),
          callers: store.listCallers().map((caller) => ({
            callerId: caller.callerId,
            displayName: caller.displayName,
            role: caller.role,
            version: caller.version,
            active: caller.active,
            permissions: caller.permissions,
            allRegions: caller.allRegions,
          })),
        });
      }

      // ------------------------------------------------------------- caller
      if (pathname === '/api/me' && method === 'GET') {
        const caller = requireCaller(req, store);
        const policy = store.getPolicy();
        const spent = store.epsilonSpent(caller.callerId);
        return sendJson(res, 200, {
          caller,
          budget: {
            spent: round(spent, 6),
            cap: policy.perCallerEpsilonCap,
            remaining: round(Math.max(0, policy.perCallerEpsilonCap - spent), 6),
            perCell: policy.perQueryEpsilon,
            affordableCells: Math.floor(
              Math.max(0, policy.perCallerEpsilonCap - spent) / policy.perQueryEpsilon + 1e-9,
            ),
          },
          policyVersion: policy.version,
          cohortsSeen: store.listReleasedCohorts(caller.callerId).length,
          peopleSeen: store.exposedPersonCount(caller.callerId),
        });
      }

      if (pathname === '/api/me/history' && method === 'GET') {
        const caller = requireCaller(req, store);
        const limit = clampLimit(url.searchParams.get('limit'), 100);
        return sendJson(res, 200, {
          ledger: store.listLedger({ callerId: caller.callerId, limit }),
          audit: store.listAudit({ actor: caller.callerId, limit }),
        });
      }

      if (pathname === '/api/me/cohorts' && method === 'GET') {
        const caller = requireCaller(req, store);
        return sendJson(res, 200, {
          cohorts: store.listReleasedCohorts(caller.callerId).map((cohort) => ({
            cohortId: cohort.cohortId,
            size: cohort.personIds.length,
          })),
        });
      }

      // -------------------------------------------------------------- query
      if (pathname === '/api/query' && method === 'POST') {
        const body = await readJsonBody(req);
        const callerId = callerIdFrom(req) ?? (typeof body.callerId === 'string' ? body.callerId : null);
        if (!callerId) throw new HttpError(401, 'missing_caller', '缺少 X-Caller-Id');
        let result;
        try {
          result = engine.execute(body.query ?? body, callerId, {
            note: typeof body.note === 'string' ? body.note.slice(0, 200) : '',
          });
        } catch (error) {
          if (error instanceof QueryError) {
            throw new HttpError(400, 'invalid_query', error.message, { field: error.field });
          }
          throw error;
        }
        // A privacy denial is a legitimate, structured result — not an HTTP
        // error. The client renders `privacy.status` and the stated reason.
        // Only a *malformed* query (parser-level) is surfaced as 400, using the
        // outcome code the engine matched so the two views stay consistent.
        if (!result.allowed && result.outcome === OUTCOME.DENIED_INVALID) {
          return sendJson(res, 400, {
            error: {
              code: 'invalid_query',
              message: result.privacy.message,
              details: {
                field: result.privacy.details?.field ?? null,
                error: result.privacy.details?.error ?? null,
              },
            },
            result,
          });
        }
        return sendJson(res, 200, result);
      }

      // -------------------------------------------------------------- admin
      if (pathname === '/api/admin/overview' && method === 'GET') {
        requireAdmin(req);
        return sendJson(res, 200, {
          policy: store.getPolicy(),
          cache: store.cacheStats(),
          audit: store.verifyAuditChain(),
          employees: store.countEmployees(),
          callers: store.listCallers().map((caller) => ({
            ...caller,
            spent: round(store.epsilonSpent(caller.callerId), 6),
            cohortsSeen: store.listReleasedCohorts(caller.callerId).length,
          })),
        });
      }

      if (pathname === '/api/admin/audit' && method === 'GET') {
        requireAdmin(req);
        return sendJson(res, 200, {
          records: store.listAudit({
            limit: clampLimit(url.searchParams.get('limit'), 200),
            actor: url.searchParams.get('actor') || null,
          }),
        });
      }

      if (pathname === '/api/admin/audit/verify' && method === 'GET') {
        requireAdmin(req);
        return sendJson(res, 200, store.verifyAuditChain());
      }

      if (pathname === '/api/admin/ledger' && method === 'GET') {
        requireAdmin(req);
        return sendJson(res, 200, {
          entries: store.listLedger({
            callerId: url.searchParams.get('caller') || null,
            limit: clampLimit(url.searchParams.get('limit'), 200),
          }),
        });
      }

      if (pathname === '/api/admin/policy' && method === 'POST') {
        requireAdmin(req);
        const patch = validatePolicyPatch(await readJsonBody(req));
        const actor = callerIdFrom(req) ?? 'admin';
        const result = store.transaction(() => {
          const before = store.getPolicy();
          const after = store.updatePolicy(patch, actor);
          const { removedByAge, removedByVersion } = store.purgeExpiredCache(
            Date.now(),
            after.version,
          );
          store.appendAudit({
            actor,
            action: 'policy.update',
            outcome: 'applied',
            detail: {
              before: policySnapshot(before),
              after: policySnapshot(after),
              changes: patch,
              cacheEntriesInvalidated: removedByVersion,
              cacheEntriesExpired: removedByAge,
            },
          });
          return {
            policy: after,
            cacheEntriesInvalidated: removedByVersion,
            cacheEntriesExpired: removedByAge,
          };
        });
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/admin/cache/purge' && method === 'POST') {
        requireAdmin(req);
        const actor = callerIdFrom(req) ?? 'admin';
        const result = store.transaction(() => {
          const purged = store.purgeCache({ reason: 'manual' });
          store.appendAudit({ actor, action: 'cache.purge', outcome: 'applied', detail: purged });
          return purged;
        });
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/admin/cache/purge-expired' && method === 'POST') {
        requireAdmin(req);
        const actor = callerIdFrom(req) ?? 'admin';
        const result = store.transaction(() => {
          const removed = store.purgeExpiredCache(Date.now(), store.getPolicy().version);
          store.appendAudit({
            actor,
            action: 'cache.purge_expired',
            outcome: 'applied',
            detail: removed,
          });
          return removed;
        });
        return sendJson(res, 200, result);
      }

      const callerAction = pathname.match(
        /^\/api\/admin\/callers\/([^/]+)\/(revoke|restore|permissions)$/,
      );
      if (callerAction && method === 'POST') {
        requireAdmin(req);
        const targetId = decodeURIComponent(callerAction[1]);
        const action = callerAction[2];
        const actor = callerIdFrom(req) ?? 'admin';
        if (!store.getCaller(targetId)) {
          throw new HttpError(404, 'caller_not_found', '调用方不存在');
        }
        if (action === 'permissions') {
          const body = await readJsonBody(req);
          if (
            !Array.isArray(body.permissions) ||
            body.permissions.some((permission) => typeof permission !== 'string')
          ) {
            throw new HttpError(400, 'invalid_permissions', 'permissions 必须是字符串数组');
          }
          const after = store.transaction(() => {
            const before = store.getCaller(targetId);
            store.setCallerPermissions(
              targetId,
              body.permissions,
              typeof body.allRegions === 'boolean' ? body.allRegions : undefined,
            );
            const updated = store.getCaller(targetId);
            store.appendAudit({
              actor,
              action: 'caller.permissions',
              outcome: 'applied',
              detail: {
                callerId: targetId,
                before: { permissions: before.permissions, allRegions: before.allRegions },
                after: { permissions: updated.permissions, allRegions: updated.allRegions },
                version: updated.version,
              },
            });
            return updated;
          });
          return sendJson(res, 200, { caller: after });
        }
        const activate = action === 'restore';
        const caller = store.transaction(() => {
          store.setCallerActive(targetId, activate);
          const updated = store.getCaller(targetId);
          store.appendAudit({
            actor,
            action: activate ? 'caller.restore' : 'caller.revoke',
            outcome: 'applied',
            detail: { callerId: targetId, active: updated.active, version: updated.version },
          });
          return updated;
        });
        return sendJson(res, 200, { caller });
      }

      // ------------------------------------------------------------- static
      if (method === 'GET' && !pathname.startsWith('/api/')) {
        return await serveStatic(res, pathname);
      }

      throw new HttpError(404, 'not_found', '接口不存在');
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(res, error.status, {
          error: { code: error.code, message: error.message, details: error.details ?? null },
        });
      }
      // Never leak stack traces to clients; log server-side instead.
      console.error('[privacy-service] unhandled error:', error);
      return sendJson(res, 500, {
        error: { code: 'internal_error', message: '服务器内部错误' },
      });
    }
  };
}

export function createServer({ dbPath, engineOptions } = {}) {
  const { store, engine } = createApp({ dbPath, engineOptions });
  const server = http.createServer(requestHandler(store, engine));
  return { server, store, engine };
}
