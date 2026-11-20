/**
 * Privacy engine.
 *
 * Everything runs inside one SQLite `BEGIN IMMEDIATE` transaction opened by
 * `execute()`, so concurrent requests serialise: budget reads and writes cannot
 * interleave and two simultaneous queries can never both spend the last
 * remaining epsilon.
 *
 * Pipeline (checked in this order):
 *
 *   1. Request well-formed.                                    -> invalid
 *   2. Caller exists and is active.                            -> not found / inactive
 *   3. Caller holds `query:aggregate` + metric permission.     -> permission
 *   4. Echoed caller authority version matches current.        -> stale authority
 *   5. Cohort size (after region scoping) >= k.                -> k threshold
 *   6. Every non-empty group cell >= k (or suppressed).        -> complementary suppression
 *   7. Differencing guard: |new cohort Δ any previously
 *      released cohort| >= k.                                  -> differencing
 *   8. Cache lookup: identical released answer, policy version and
 *      data signature => replay for free.                      -> cached
 *   9. Repeat-query limit for the fingerprint in the window.   -> repeat limit
 *  10. Remaining budget covers the composition cost.           -> budget
 *  11. Fresh release (noise added, budget charged, cohort recorded).
 *
 * The differencing guard deliberately precedes the cache: the cache is shared
 * between callers, so a caller must be judged against their own released
 * history before any cached answer is handed to them.
 *
 * Denials are free (epsilon 0) but are still written to the ledger and the
 * audit log, so probing is visible and rate-limited.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from './store.js';
import { METRICS, DIMENSIONS } from './config.js';

export const OUTCOME = Object.freeze({
  RELEASED: 'released',
  CACHED: 'cached',
  REPLAYED: 'replayed',
  DENIED_NOT_FOUND: 'denied_caller_not_found',
  DENIED_INACTIVE: 'denied_caller_inactive',
  DENIED_PERMISSION: 'denied_permission',
  DENIED_STALE_AUTHORITY: 'denied_stale_authority',
  DENIED_REPLAY: 'denied_request_replay',
  DENIED_REPEAT: 'denied_repeat_limit',
  DENIED_THRESHOLD: 'denied_k_threshold',
  DENIED_COMPLEMENTARY: 'denied_complementary_suppression',
  DENIED_DIFFERENCING: 'denied_differencing',
  DENIED_BUDGET: 'denied_budget_exhausted',
  DENIED_INVALID: 'denied_invalid_request',
});

const DENIAL_MESSAGES = {
  [OUTCOME.DENIED_NOT_FOUND]: '调用方身份不存在。',
  [OUTCOME.DENIED_INACTIVE]: '调用方权限已被撤销，所有查询（含缓存）均被拒绝。',
  [OUTCOME.DENIED_PERMISSION]: '当前角色无权执行该指标、该分组或访问该地区。',
  [OUTCOME.DENIED_STALE_AUTHORITY]: '你的权限信息已变更，本次查询未执行，请刷新后重试。',
  [OUTCOME.DENIED_REPLAY]: '该请求编号不属于你的有效记录，不能重放。',
  [OUTCOME.DENIED_REPEAT]: '同一查询条件在重复查询窗口内的次数已达上限。',
  [OUTCOME.DENIED_THRESHOLD]: '查询覆盖的人数低于最小群体阈值，结果不返回。',
  [OUTCOME.DENIED_COMPLEMENTARY]: '结果中存在人数低于阈值的小分组，为保护小群体，整次查询不返回。',
  [OUTCOME.DENIED_DIFFERENCING]: '与历史已发布结果对比后可推断出少于阈值的人群，查询被拒绝。',
  [OUTCOME.DENIED_BUDGET]: '剩余隐私预算不足，无法返回新结果。',
  [OUTCOME.DENIED_INVALID]: '查询参数不合法。',
};

export function denialMessage(code) {
  return DENIAL_MESSAGES[code] ?? '查询被拒绝。';
}

export class QueryError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'QueryError';
    this.field = field;
  }
}

export function normalizeQuery(raw = {}) {
  const metric = String(raw.metric ?? 'count');
  if (!METRICS[metric]) throw new QueryError(`未知指标: ${metric}`, 'metric');

  const groupBy = String(raw.groupBy ?? 'none');
  if (!['none', ...Object.keys(DIMENSIONS)].includes(groupBy)) {
    throw new QueryError(`不支持的分组维度: ${groupBy}`, 'groupBy');
  }

  const filters = {};
  for (const key of Object.keys(DIMENSIONS)) {
    const value = raw.filters?.[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > 64) {
      throw new QueryError(`筛选值不合法: ${key}`, `filters.${key}`);
    }
    filters[key] = value;
  }
  if (groupBy !== 'none' && filters[groupBy]) {
    throw new QueryError('分组维度不能再作为筛选条件', `filters.${groupBy}`);
  }

  return {
    metric,
    groupBy,
    filters,
    requestId:
      raw.requestId === undefined || raw.requestId === null || raw.requestId === ''
        ? null
        : String(raw.requestId).slice(0, 128),
    callerVersion: Number.isInteger(raw.callerVersion) ? raw.callerVersion : null,
  };
}

export function publicQuery(query) {
  const normalized = normalizeSafe(query);
  return { metric: normalized.metric, groupBy: normalized.groupBy, filters: normalized.filters };
}

function normalizeSafe(query) {
  try {
    return normalizeQuery(query ?? {});
  } catch {
    return {
      metric: String(query?.metric ?? 'count'),
      groupBy: String(query?.groupBy ?? 'none'),
      filters: query?.filters && typeof query.filters === 'object' ? query.filters : {},
    };
  }
}

function requirePermission(query) {
  // `query:aggregate` gates the endpoint; counts additionally need
  // `query:count`, and salary/tenure means need `query:metric`. This lets a
  // role see headcounts without seeing compensation.
  return query.metric === 'count' ? 'query:count' : 'query:metric';
}

/**
 * Rows the caller may see. `allRegions` grants the full table; otherwise the
 * caller is limited to the regions explicitly granted. A caller with no region
 * grant sees an empty cohort — *not* the whole table. The distinction matters:
 * an intern role must not accidentally inherit organisation-wide visibility.
 */
function regionScope(caller) {
  if (caller.allRegions) return undefined;
  return caller.permissions
    .filter((permission) => permission.startsWith('region:'))
    .map((permission) => permission.slice('region:'.length));
}

/** Stable hash used as the id of a released cohort. */
export function cohortId(personIds) {
  return createHash('sha256').update([...personIds].sort().join('\n')).digest('hex');
}

export function cohortSignature(rows) {
  return createHash('sha256')
    .update(
      rows
        .map((row) =>
          [
            row.person_id,
            row.region,
            row.dept,
            row.age_band,
            row.tenure_years,
            row.salary,
          ].join('|'),
        )
        .join('\n'),
    )
    .digest('hex');
}

export function queryFingerprint(callerId, query) {
  return createHash('sha256')
    .update(
      canonicalJson({
        callerId,
        metric: query.metric,
        groupBy: query.groupBy,
        filters: query.filters,
      }),
    )
    .digest('hex');
}

/**
 * Cache key is caller-independent: the answer is a function of the data, the
 * query and the policy. Callers still pass every authority/budget/exposure
 * check before a cached payload is returned, and the cohort signature ties the
 * entry to the exact rows it was computed from.
 */
export function queryCacheKey({ query, policyVersion, cohortSig }) {
  return createHash('sha256')
    .update(
      canonicalJson({
        policyVersion,
        metric: query.metric,
        groupBy: query.groupBy,
        filters: query.filters,
        cohortSig,
      }),
    )
    .digest('hex');
}

/**
 * Coarse bucket shown to a caller whose query was refused. Withholding the
 * exact count prevents a stream of near-identical refusals from being used to
 * binary-search the size of a small group.
 */
function cohortBand(size, k) {
  if (size === 0) return 'empty';
  if (size < k) return 'below_k';
  if (size < k * 10) return 'small';
  return 'large';
}

/** Laplace(0, scale) noise via inverse CDF. */
export function laplaceNoise(scale, rng = Math.random) {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  let u = rng() - 0.5;
  if (u === 0) u = Number.EPSILON;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

/** Bounded sensitivity: counts are 1; a bounded mean moves by range / n. */
export function sensitivityFor(metricId, policy, groupSize) {
  const metric = METRICS[metricId];
  if (metric.kind === 'count') return 1;
  const range =
    metric.field === 'salary'
      ? policy.salaryMax - policy.salaryMin
      : policy.tenureMax - policy.tenureMin;
  return groupSize > 0 ? range / groupSize : range;
}

/**
 * One-sided difference sizes between two cohorts.
 *
 * Answering queries over A and B lets a caller subtract the two answers. If
 * `A \ B` is small, count(A) − count(B) isolates those few people; likewise
 * for `B \ A`. An empty side is harmless — that is just "the complement is
 * large" — so callers compare each non-empty side against k.
 */
function oneSidedDifferences(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let onlyA = 0;
  for (const id of setA) if (!setB.has(id)) onlyA += 1;
  let onlyB = 0;
  for (const id of setB) if (!setA.has(id)) onlyB += 1;
  return { onlyA, onlyB };
}

function areSameCohort(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export class PrivacyEngine {
  constructor(store, { rng = Math.random, now = () => Date.now() } = {}) {
    this.store = store;
    this.rng = rng;
    this.now = now;
    this.#serverSeq = 0;
  }

  #serverSeq;

  /**
   * Server-generated request ids must be unique even when several queries
   * arrive in the same millisecond (or with a stubbed rng in tests): the
   * ledger's UNIQUE(caller, request_id) would otherwise reject the second one.
   */
  #nextRequestId(nowMs) {
    this.#serverSeq += 1;
    const entropy = this.rng().toString(36).slice(2, 8);
    return `srv-${nowMs.toString(36)}-${this.#serverSeq.toString(36)}-${entropy}`;
  }

  execute(rawQuery, callerId, meta = {}) {
    return this.store.transaction(() =>
      this.#executeInTx(rawQuery, callerId, { note: meta.note ?? '' }),
    );
  }

  // ------------------------------------------------------------------ main

  #executeInTx(rawQuery, callerId, meta) {
    const policy = this.store.getPolicy();
    const caller = this.store.getCaller(callerId);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const rawRequestId =
      typeof rawQuery?.requestId === 'string' && rawQuery.requestId !== ''
        ? rawQuery.requestId.slice(0, 128)
        : null;
    const requestId = rawRequestId ?? this.#nextRequestId(nowMs);

    let query;
    try {
      query = normalizeQuery(rawQuery);
    } catch (error) {
      return this.#deny({
        code: OUTCOME.DENIED_INVALID,
        caller,
        callerId,
        query: normalizeSafe(rawQuery),
        policy,
        requestId,
        fingerprint: null,
        nowIso,
        meta: {
          ...meta,
          validationError: error.message,
          field: error.field ?? null,
          // Echoed to the client so a malformed request gets a specific reason
          // rather than the generic "参数不合法" sentence. Never includes data.
          publicMessage: error.message,
        },
      });
    }

    const fingerprint = queryFingerprint(callerId, query);
    // Filled in once the cohort is built; denials surface only the *band*
    // (below/at-or-above k) so a refusal cannot be used as a headcount oracle.
    let cohortInfo = { size: null, band: null };
    const deny = (code, extra = {}) =>
      this.#deny({
        code,
        caller,
        callerId,
        query,
        policy,
        requestId,
        fingerprint,
        nowIso,
        cohortInfo,
        meta: { ...meta, ...extra },
      });

    // 2–3. Identity and authority. -------------------------------------------------
    if (!caller) return deny(OUTCOME.DENIED_NOT_FOUND, { callerVersion: query.callerVersion });
    if (!caller.active) return deny(OUTCOME.DENIED_INACTIVE);

    // 4. Stale authority snapshot: the client is acting on permissions it
    //    already knows have changed. Checked before the permission test so a
    //    client that switched role/filters gets "refresh and retry" rather
    //    than a contradictory-looking permission error. Never serve, never
    //    charge.
    if (query.callerVersion !== null && query.callerVersion !== caller.version) {
      return deny(OUTCOME.DENIED_STALE_AUTHORITY, {
        clientVersion: query.callerVersion,
        serverVersion: caller.version,
      });
    }

    const permissions = [requirePermission(query), 'query:aggregate'];
    if (!permissions.every((permission) => caller.permissions.includes(permission))) {
      return deny(OUTCOME.DENIED_PERMISSION, {
        required: permissions,
        granted: caller.permissions,
      });
    }

    // 5. Region scope + cohort. ----------------------------------------------------
    // Built before idempotency/cache so that even denials can show the caller
    // the *band* of what they asked about. Member ids never leave the server.
    const scope = regionScope(caller);
    if (scope && query.filters.region && !scope.includes(query.filters.region)) {
      // Asking for a region outside your grant is a permission problem, not a
      // threshold one. Checking it explicitly also avoids revealing whether a
      // region you cannot see is empty or merely small.
      return deny(OUTCOME.DENIED_PERMISSION, {
        required: [`region:${query.filters.region}`],
        granted: caller.permissions,
      });
    }
    const rows = this.store.cohortSnapshot(query.filters, scope);
    const cohortSize = rows.length;
    const personIds = rows.map((row) => row.person_id);
    const cohortSig = cohortSignature(rows);
    cohortInfo = { size: cohortSize, band: cohortBand(cohortSize, policy.k) };

    // Idempotency: a request id is consumed at most once per caller.
    const priorEntry = query.requestId
      ? this.store.findLedgerEntry(callerId, query.requestId)
      : null;
    if (priorEntry) {
      return this.#replay({ priorEntry, caller, callerId, query, policy, cohortInfo });
    }

    if (cohortSize < policy.k) {
      // The exact size is written to the operator audit trail but not to the
      // response: a refusal must not confirm a precise headcount.
      return deny(OUTCOME.DENIED_THRESHOLD, { cohortSize, k: policy.k });
    }

    // 6. Cell-level threshold (splitting a query by group must not create a
    //    cell smaller than k). ---------------------------------------------------
    const cells = buildCells(rows, query);
    const smallCells = cells.filter((cell) => cell.count > 0 && cell.count < policy.k);
    if (smallCells.length > 0 && policy.complementarySuppression) {
      // Refusing the whole query is conservative: omitting just the small cell
      // would itself reveal that a small group exists. Labels stay in the
      // operator audit log only.
      return deny(OUTCOME.DENIED_COMPLEMENTARY, {
        cohortSize,
        k: policy.k,
        suppressedCells: smallCells.map((cell) => ({ label: cell.label, count: cell.count })),
      });
    }
    const releasedCells = cells.filter((cell) => !smallCells.includes(cell));
    if (releasedCells.length === 0) {
      return deny(OUTCOME.DENIED_THRESHOLD, { cohortSize, k: policy.k, allCellsSmall: true });
    }

    // 7. Differencing guard. ------------------------------------------------------
    // Runs BEFORE the cache lookup on purpose. The cache is shared across
    // callers, so a caller who has never seen this cohort must still be judged
    // against their *own* released history: serving them a cached answer that
    // would fail the check below would hand them the very number the policy
    // refused (e.g. caller A warms the cache with 华东/研发, caller B has
    // already released 研发, and 研发\华东/研发 is a 2-person slice).
    // Two answers over overlapping cohorts can be subtracted to isolate the
    // people in one but not the other. If either non-empty side (A\B or B\A)
    // is below k, the caller could isolate those people, so reject. An
    // identical cohort is not a differencing risk: it is a re-run governed by
    // the repeat limit and the budget (e.g. after the cache was purged).
    if (policy.differencingProtection) {
      const priorCohorts = this.store.listReleasedCohorts(callerId, { metric: query.metric });
      for (const prior of priorCohorts) {
        if (areSameCohort(personIds, prior.personIds)) continue;
        const { onlyA, onlyB } = oneSidedDifferences(personIds, prior.personIds);
        const isolate = Math.min(
          onlyA === 0 ? Infinity : onlyA,
          onlyB === 0 ? Infinity : onlyB,
        );
        if (isolate < policy.k) {
          return deny(OUTCOME.DENIED_DIFFERENCING, {
            cohortSize,
            k: policy.k,
            oneSidedDifference: Number.isFinite(isolate) ? isolate : null,
            overlapsCohort: prior.cohortId.slice(0, 12),
            priorCohortSize: prior.personIds.length,
          });
        }
      }
    }

    // 8. Cache. ------------------------------------------------------------------
    const cacheKey = queryCacheKey({
      query,
      policyVersion: policy.version,
      cohortSig,
    });
    const cacheEntry = policy.cacheTtlMs > 0 ? this.store.getCacheEntry(cacheKey) : null;
    const cacheFresh =
      cacheEntry && cacheEntry.policyVersion === policy.version && cacheEntry.expiresAt > nowMs;

    if (cacheFresh) {
      // Replay of an already released answer: no new information, so no budget
      // charge. Exposure is still recorded so later differencing is judged
      // against everything this caller has actually seen.
      this.store.recordCacheHit(cacheKey, nowMs);
      this.store.recordReleasedCohort(
        callerId,
        cohortId(personIds),
        personIds,
        nowIso,
        query.metric,
      );
      this.store.insertLedgerEntry({
        callerId,
        requestId,
        at: nowIso,
        epsilon: 0,
        status: 'released',
        outcomeCode: OUTCOME.CACHED,
        cacheKey,
        fingerprint,
        note: meta.note,
        resultJson: JSON.stringify(cacheEntry.payload),
      });
      const audit = this.store.appendAudit({
        actor: callerId,
        action: 'query',
        requestId,
        outcome: OUTCOME.CACHED,
        detail: {
          query: publicQuery(query),
          cacheKey,
          cohortSize,
          cohortSig,
          policyVersion: policy.version,
          epsilon: 0,
          note: meta.note || null,
        },
      });
      return this.#result({
        outcome: OUTCOME.CACHED,
        requestId,
        caller,
        callerId,
        query,
        policy,
        payload: cacheEntry.payload,
        epsilon: 0,
        cache: { hit: true, createdAt: cacheEntry.createdAt, expiresAt: cacheEntry.expiresAt },
        audit,
        note: meta.note,
      });
    }

    // 9. Repeat limit. ------------------------------------------------------------
    const windowStart = new Date(nowMs - policy.repeatWindowMs).toISOString();
    const attempts = this.store.countAttempts(callerId, fingerprint, windowStart);
    if (attempts >= policy.repeatLimit) {
      return deny(OUTCOME.DENIED_REPEAT, {
        attempts,
        repeatLimit: policy.repeatLimit,
        windowMs: policy.repeatWindowMs,
      });
    }

    // 10. Budget. -----------------------------------------------------------------
    const cellCount = releasedCells.length;
    const epsilon = round(policy.perQueryEpsilon * cellCount, 6);
    const budgetBefore = this.#budgetView(callerId, policy);
    if (budgetBefore.remaining + 1e-9 < epsilon) {
      return deny(OUTCOME.DENIED_BUDGET, {
        cost: epsilon,
        spent: budgetBefore.spent,
        cap: budgetBefore.cap,
        remaining: budgetBefore.remaining,
      });
    }

    // 11. Release. ---------------------------------------------------------------
    const released = noiseCells({
      cells: releasedCells,
      suppressedCells: smallCells,
      query,
      policy,
      rng: this.rng,
    });
    const payload = {
      query: publicQuery(query),
      cells: released.cells,
      // Metadata safe to echo even when the policy hides the exact cohort size
      // from users: cached replays and idempotent replays render from this.
      meta: {
        k: policy.k,
        cohortBand: cohortInfo.band,
        epsilon,
        mechanism: 'laplace',
        delta: 0,
      },
      cohortSize: policy.showCohortSize ? cohortSize : null,
      epsilon,
    };

    this.store.insertLedgerEntry({
      callerId,
      requestId,
      at: nowIso,
      epsilon,
      status: 'released',
      outcomeCode: OUTCOME.RELEASED,
      cacheKey,
      fingerprint,
      note: meta.note,
      resultJson: JSON.stringify(payload),
    });
    this.store.recordReleasedCohort(callerId, cohortId(personIds), personIds, nowIso, query.metric);
    if (policy.cacheTtlMs > 0) {
      this.store.putCacheEntry({
        cacheKey,
        policyVersion: policy.version,
        payload,
        cohortSignature: cohortSig,
        createdAt: nowMs,
        expiresAt: nowMs + policy.cacheTtlMs,
      });
    }
    const audit = this.store.appendAudit({
      actor: callerId,
      action: 'query',
      requestId,
      outcome: OUTCOME.RELEASED,
      detail: {
        query: publicQuery(query),
        cacheKey,
        cohortSize,
        cohortSig,
        policyVersion: policy.version,
        cells: released.cells.map((cell) => ({
          label: cell.label,
          value: cell.value,
          suppressed: cell.suppressed,
          sensitivity: cell.sensitivity,
        })),
        suppressedCells: smallCells.map((cell) => ({ label: cell.label, count: cell.count })),
        epsilon,
        sensitivity: released.worstSensitivity,
        noiseScale: released.worstScale,
        budgetSpentAfter: round(budgetBefore.spent + epsilon, 6),
        note: meta.note || null,
      },
    });

    return this.#result({
      outcome: OUTCOME.RELEASED,
      requestId,
      caller,
      callerId,
      query,
      policy,
      payload,
      epsilon,
      cache: { hit: false, expiresAt: policy.cacheTtlMs > 0 ? nowMs + policy.cacheTtlMs : null },
      audit,
      note: meta.note,
    });
  }

  // --------------------------------------------------------------- helpers

  #replay({ priorEntry, caller, callerId, query, policy, cohortInfo }) {
    const audit = this.store.appendAudit({
      actor: callerId,
      action: 'query.replay',
      requestId: priorEntry.request_id,
      outcome: priorEntry.outcome_code,
      detail: {
        query: publicQuery(query),
        originalOutcome: priorEntry.outcome_code,
        originalEpsilon: priorEntry.epsilon,
        epsilon: 0,
        note: 'request id replayed; no additional budget charged',
      },
    });
    if (priorEntry.status === 'released' && priorEntry.result_json) {
      const payload = JSON.parse(priorEntry.result_json);
      return this.#result({
        outcome: OUTCOME.REPLAYED,
        requestId: priorEntry.request_id,
        caller,
        callerId,
        query,
        policy,
        payload,
        epsilon: 0,
        cache: { hit: false, replayed: true },
        audit,
        note: '幂等重放：返回该请求编号首次发布的结果，不重复计费。',
      });
    }
    const code = isDenialCode(priorEntry.outcome_code)
      ? priorEntry.outcome_code
      : OUTCOME.DENIED_REPLAY;
    return this.#denialResult({
      code,
      caller,
      callerId,
      query,
      policy,
      requestId: priorEntry.request_id,
      audit,
      cohortInfo,
      extra: { replayed: true, originalOutcome: priorEntry.outcome_code },
    });
  }
  #deny({ code, caller, callerId, query, policy, requestId, fingerprint, nowIso, cohortInfo, meta }) {
    this.store.insertLedgerEntry({
      callerId,
      requestId,
      at: nowIso,
      epsilon: 0,
      status: 'denied',
      outcomeCode: code,
      fingerprint,
      note: meta.note ?? '',
    });
    const audit = this.store.appendAudit({
      actor: callerId,
      action: 'query',
      requestId,
      outcome: code,
      detail: {
        query: publicQuery(query),
        reason: denialMessage(code),
        policyVersion: policy.version,
        ...sanitize(meta),
      },
    });
    return this.#denialResult({
      code,
      caller,
      callerId,
      query,
      policy,
      requestId,
      audit,
      cohortInfo,
      extra: meta,
    });
  }
  #result({ outcome, requestId, caller, callerId, query, policy, payload, epsilon, cache, audit, note }) {
    return {
      outcome,
      allowed: true,
      requestId,
      caller: { id: callerId, displayName: caller.displayName, version: caller.version },
      conditions: describeConditions(query, policy),
      privacy: {
        status: cache?.hit ? 'cached' : cache?.replayed ? 'replayed' : 'released',
        message: cache?.hit
          ? '与已发布结果一致，从缓存返回，不额外消耗预算。'
          : cache?.replayed
            ? '幂等重放：返回首次发布的结果，不额外消耗预算。'
            : '结果已按 Laplace 差分隐私机制发布，并计入隐私预算。',
        k: policy.k,
        cohortSize: payload.cohortSize ?? null,
        // epsilon of the mechanism behind these numbers; budgetCharged is what
        // this particular request cost (0 for a cache replay).
        epsilon: payload.epsilon ?? epsilon,
        budgetCharged: epsilon,
        mechanism: 'laplace',
        delta: 0,
        cache,
        policyVersion: policy.version,
      },
      budget: this.#budgetView(callerId, policy),
      data: formatPayload(payload),
      audit: { seq: audit.seq, hash: audit.hash },
      note: note || null,
    };
  }

  #denialResult({ code, caller, callerId, query, policy, requestId, audit, cohortInfo, extra = {} }) {
    const budget = callerId ? this.#budgetView(callerId, policy) : null;
    return {
      outcome: code,
      allowed: false,
      requestId,
      caller: caller
        ? { id: callerId, displayName: caller.displayName, version: caller.version }
        : null,
      conditions: describeConditions(query, policy),
      privacy: {
        status: 'denied',
        message: extra?.publicMessage ?? denialMessage(code),
        reasonCode: code,
        k: policy.k,
        // Only the band ("below k" / "at least k"), never the exact size.
        cohortBand: cohortInfo?.size === null || cohortInfo === undefined ? null : cohortInfo.band,
        cohortSize: null,
        budgetCharged: 0,
        policyVersion: policy.version,
        details: publicDenialDetails(code, extra),
      },
      budget,
      data: null,
      audit: audit ? { seq: audit.seq, hash: audit.hash } : null,
    };
  }

  #budgetView(callerId, policy) {
    const spent = this.store.epsilonSpent(callerId);
    const cap = policy.perCallerEpsilonCap;
    const remaining = Math.max(0, cap - spent);
    return {
      spent: round(spent, 6),
      cap,
      remaining: round(remaining, 6),
      perCell: policy.perQueryEpsilon,
      affordableCells: Math.floor(remaining / policy.perQueryEpsilon + 1e-9),
    };
  }
}

// ------------------------------------------------------------------- utils

function isDenialCode(code) {
  return typeof code === 'string' && code.startsWith('denied_');
}

function sanitize(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value === undefined || value === null) continue;
    if (key === 'note' && !value) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Denial details shown to the user. Deliberately excludes exact cohort sizes
 * and cell labels: both would let a caller learn *which* small group exists.
 * Operators see the full picture in the audit log instead.
 */
function publicDenialDetails(code, extra) {
  switch (code) {
    case OUTCOME.DENIED_THRESHOLD:
      return { k: extra.k ?? null };
    case OUTCOME.DENIED_COMPLEMENTARY:
      return { k: extra.k ?? null, smallCellCount: extra.suppressedCells?.length ?? null };
    case OUTCOME.DENIED_DIFFERENCING:
      return { k: extra.k ?? null };
    case OUTCOME.DENIED_BUDGET:
      return { cost: extra.cost ?? null, remaining: extra.remaining ?? null };
    case OUTCOME.DENIED_REPEAT:
      return {
        attempts: extra.attempts ?? null,
        repeatLimit: extra.repeatLimit ?? null,
        windowMs: extra.windowMs ?? null,
      };
    case OUTCOME.DENIED_STALE_AUTHORITY:
      return {
        clientVersion: extra.clientVersion ?? null,
        serverVersion: extra.serverVersion ?? null,
      };
    case OUTCOME.DENIED_PERMISSION:
      return { required: extra.required ?? null, granted: extra.granted ?? null };
    case OUTCOME.DENIED_INVALID:
      return { field: extra.field ?? null, error: extra.validationError ?? null };
    default:
      return {};
  }
}

function buildCells(rows, query) {
  const metric = METRICS[query.metric];
  const column = query.groupBy === 'none' ? null : DIMENSIONS[query.groupBy].column;
  if (!column) {
    return [
      {
        key: null,
        label: '全部',
        count: rows.length,
        values: rows.map((row) => metricValue(row, metric)),
      },
    ];
  }
  const buckets = new Map();
  for (const row of rows) {
    const label = row[column];
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(row);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b), 'zh-Hans-CN'))
    .map(([label, groupRows]) => ({
      key: label,
      label,
      count: groupRows.length,
      values: groupRows.map((row) => metricValue(row, metric)),
    }));
}

function metricValue(row, metric) {
  return metric.kind === 'count' ? 1 : row[metric.field];
}

function noiseCells({ cells, suppressedCells, query, policy, rng }) {
  const metric = METRICS[query.metric];
  let worstSensitivity = 0;
  let worstScale = 0;
  const released = cells.map((cell) => {
    const sensitivity = sensitivityFor(query.metric, policy, cell.count);
    const scale = sensitivity / policy.perQueryEpsilon;
    worstSensitivity = Math.max(worstSensitivity, sensitivity);
    worstScale = Math.max(worstScale, scale);
    const truth = metric.kind === 'count' ? cell.count : mean(cell.values);
    const noisy = truth + laplaceNoise(scale, rng);
    return {
      key: cell.key,
      label: cell.label,
      suppressed: false,
      value: metric.kind === 'count' ? Math.max(0, Math.round(noisy)) : round(noisy, 2),
      unit: metric.unit,
      sensitivity,
    };
  });
  for (const cell of suppressedCells) {
    released.push({
      key: cell.key,
      label: cell.label,
      suppressed: true,
      value: null,
      unit: metric.unit,
      sensitivity: null,
    });
  }
  released.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
  return { cells: released, worstSensitivity, worstScale };
}

/**
 * Public payload. Suppressed cells are included as `suppressed: true` only when
 * complementary suppression is off; with it on (default) the whole query is
 * refused, so a caller never sees which label was small.
 */
function formatPayload(payload) {
  const meta = payload.meta ?? {};
  return {
    metric: payload.query.metric,
    groupBy: payload.query.groupBy,
    filters: payload.query.filters,
    cohortSize: payload.cohortSize ?? null,
    cohortBand: meta.cohortBand ?? null,
    epsilon: payload.epsilon ?? 0,
    cells: (payload.cells ?? []).map((cell) =>
      cell.suppressed
        ? { key: cell.key, label: cell.label, suppressed: true, value: null }
        : {
            key: cell.key,
            label: cell.label,
            suppressed: false,
            value: cell.value,
            unit: cell.unit,
          },
    ),
  };
}

/** Human-readable rendering of what the answer depends on. */
export function describeConditions(query, policy) {
  const normalized = normalizeSafe(query);
  const metric = METRICS[normalized.metric] ?? METRICS.count;
  const groupLabel =
    normalized.groupBy === 'none'
      ? '不分组'
      : `按${DIMENSIONS[normalized.groupBy]?.label ?? normalized.groupBy}分组`;
  const filterLabels = Object.entries(normalized.filters).map(
    ([key, value]) => `${DIMENSIONS[key]?.label ?? key} = ${value}`,
  );
  return {
    metric: {
      id: metric.id,
      label: metric.label,
      unit: metric.unit,
      description: metric.description,
    },
    groupBy: normalized.groupBy,
    groupLabel,
    filters: normalized.filters,
    filterLabels,
    summary: [groupLabel, ...filterLabels].join(' · '),
    k: policy.k,
    perQueryEpsilon: policy.perQueryEpsilon,
    complementarySuppression: policy.complementarySuppression,
    differencingProtection: policy.differencingProtection,
    cacheTtlMs: policy.cacheTtlMs,
    policyVersion: policy.version,
  };
}
