import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer } from './helpers.js';
import { OUTCOME } from '../src/privacy.js';

const CALLER = 'analyst-hr';

test('HTTP: health endpoint reports an intact audit chain', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await app.request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.audit.ok, true);
});

test('HTTP: query requires a caller identity', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await app.request('/api/query', {
    method: 'POST',
    body: { metric: 'count', filters: { region: '华东' } },
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'missing_caller');
});

test('HTTP: released query returns conditions, privacy status and budget', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: { query: { metric: 'count', filters: { region: '华东' } } },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.outcome, OUTCOME.RELEASED);
  assert.equal(response.body.conditions.k, 5);
  assert.equal(response.body.conditions.filterLabels[0], '地区 = 华东');
  assert.equal(response.body.privacy.status, 'released');
  assert.equal(response.body.privacy.epsilon, 0.5);
  assert.ok(response.body.budget.remaining < response.body.budget.cap);
  assert.ok(response.body.audit.hash.length === 64);
});

test('HTTP: refusals are 200 with a structured reason (not an HTTP error)', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: {
      query: {
        metric: 'count',
        filters: { region: '海外', dept: '法务', ageBand: '50+' },
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.privacy.status, 'denied');
  assert.equal(response.body.privacy.reasonCode, OUTCOME.DENIED_THRESHOLD);
  assert.equal(response.body.data, null);
  // The operator-facing copy is a sentence, the machine-facing copy a code.
  assert.match(response.body.privacy.message, /最小群体阈值/);
});

test('HTTP: invalid query shape gets a 400 with the offending field', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: { query: { metric: 'does_not_exist' } },
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'invalid_query');
  assert.match(response.body.error.message, /未知指标/);
  // The structured result rides along so the UI can render it like any denial.
  assert.equal(response.body.result.privacy.status, 'denied');
  assert.equal(response.body.result.privacy.budgetCharged, 0);
});

test('HTTP: a malformed body is rejected without a stack trace', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await fetch(app.base + '/api/query', {
    method: 'POST',
    headers: { 'x-caller-id': CALLER, 'content-type': 'application/json' },
    body: '{"query":',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'invalid_json');
  assert.equal(JSON.stringify(body).includes('at '), false);
});

test('HTTP: concurrent requests serialize and never overspend', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  // Trim the budget so exactly two 0.5-cost releases fit.
  const patched = await app.request('/api/admin/policy', {
    method: 'POST',
    admin: true,
    body: { perCallerEpsilonCap: 1 },
  });
  assert.equal(patched.status, 200);

  const regions = ['华东', '华南', '华北', '西部', '东北', '海外', '华东', '华南'];
  const responses = await Promise.all(
    regions.map((region) =>
      app.request('/api/query', {
        method: 'POST',
        caller: CALLER,
        body: { query: { metric: 'count', filters: { region } } },
      }),
    ),
  );
  const outcomes = responses.map((response) => response.body.outcome);
  const released = outcomes.filter((outcome) => outcome === OUTCOME.RELEASED);
  const cached = outcomes.filter((outcome) => outcome === OUTCOME.CACHED);
  const denied = outcomes.filter((outcome) => outcome === OUTCOME.DENIED_BUDGET);
  assert.equal(released.length, 2);
  assert.equal(cached.length, 2, 'the two duplicate regions hit the cache');
  assert.equal(denied.length, 4);

  const me = await app.request('/api/me', { caller: CALLER });
  assert.equal(me.body.budget.spent, 1);
  assert.equal(me.body.budget.remaining, 0);
});

test('HTTP: admin policy change bumps the version and invalidates the cache', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const query = { metric: 'count', filters: { region: '华东' } };
  const first = await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: { query },
  });
  assert.equal(first.body.outcome, OUTCOME.RELEASED);
  const second = await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: { query },
  });
  assert.equal(second.body.outcome, OUTCOME.CACHED);

  const patched = await app.request('/api/admin/policy', {
    method: 'POST',
    admin: true,
    body: { k: 6 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.policy.version, 2);
  assert.ok(patched.body.cacheEntriesInvalidated >= 1);

  const third = await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: { query },
  });
  assert.equal(third.body.outcome, OUTCOME.RELEASED, 'cache was dropped, answer recomputed');
});

test('HTTP: only admins may change policy', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await app.request('/api/admin/policy', {
    method: 'POST',
    caller: CALLER,
    body: { k: 3 },
  });
  assert.equal(response.status, 403);
  const invalid = await app.request('/api/admin/policy', {
    method: 'POST',
    admin: true,
    body: { k: 1 },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'invalid_policy_value');
});

test('HTTP: revocation immediately blocks queries and audit records it', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const query = { metric: 'count', filters: { region: '华东' } };
  const before = await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: { query },
  });
  assert.equal(before.body.outcome, OUTCOME.RELEASED);

  const revoked = await app.request(`/api/admin/callers/${CALLER}/revoke`, {
    method: 'POST',
    admin: true,
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.caller.active, false);

  const after = await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: { query },
  });
  assert.equal(after.body.outcome, OUTCOME.DENIED_INACTIVE);

  const audit = await app.request(`/api/admin/audit?actor=${CALLER}`, { admin: true });
  const actions = audit.body.records.map((record) => record.action);
  assert.ok(actions.includes('query'));
  const adminAudit = await app.request('/api/admin/audit', { admin: true });
  assert.ok(adminAudit.body.records.some((record) => record.action === 'caller.revoke'));
});

test('HTTP: audit verify detects a tampered record', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: { query: { metric: 'count', filters: { region: '华东' } } },
  });
  const ok = await app.request('/api/admin/audit/verify', { admin: true });
  assert.equal(ok.body.ok, true);

  app.store.db.exec('DROP TRIGGER audit_no_update');
  app.store.db.exec("UPDATE audit_log SET outcome = 'denied_k_threshold' WHERE seq = 2");
  const broken = await app.request('/api/admin/audit/verify', { admin: true });
  assert.equal(broken.body.ok, false);
  assert.equal(broken.body.brokenAt, 2);
});

test('HTTP: ledger exposes every charge and refusal for audit', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: { query: { metric: 'count', filters: { region: '华东' } } },
  });
  await app.request('/api/query', {
    method: 'POST',
    caller: CALLER,
    body: {
      query: { metric: 'count', filters: { region: '海外', dept: '法务', ageBand: '50+' } },
    },
  });
  const ledger = await app.request(`/api/admin/ledger?caller=${CALLER}`, { admin: true });
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.entries.length, 2);
  const total = ledger.body.entries.reduce((sum, entry) => sum + entry.epsilon, 0);
  assert.equal(total, 0.5, 'only the release is charged');
});

test('HTTP: static UI is served with a restrictive CSP', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await fetch(app.base + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await response.text(), /隐私保护聚合查询/);
});

test('HTTP: unknown API routes are 404 JSON, not the SPA', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await app.request('/api/nope');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'not_found');
});

test('HTTP: path traversal is refused', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  // Raw (un-normalised) request path: fetch would normalise it client-side.
  const status = await new Promise((resolve, reject) => {
    const url = new URL(app.base);
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(
        'GET /../src/store.js HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      );
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      raw += chunk;
    });
    socket.on('end', () => {
      const statusLine = raw.split('\r\n')[0];
      assert.equal(raw.includes('class Store'), false, 'server source must not be served');
      resolve(Number(statusLine.split(' ')[1]));
    });
    socket.on('error', reject);
  });
  assert.notEqual(status, 200);
});
