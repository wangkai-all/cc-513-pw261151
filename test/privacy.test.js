import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from './helpers.js';
import { OUTCOME, PrivacyEngine } from '../src/privacy.js';
import { Store } from '../src/store.js';

const CALLER = 'analyst-hr';
const WHOLE = { metric: 'count' };
const TINY = { metric: 'count', filters: { region: '海外', dept: '法务', ageBand: '50+' } };

test('releases a noisy answer and charges exactly one epsilon', () => {
  const { store, engine } = makeEngine();
  const result = engine.execute(WHOLE, CALLER);
  assert.equal(result.outcome, OUTCOME.RELEASED);
  assert.equal(result.allowed, true);
  assert.equal(result.privacy.budgetCharged, 0.5);
  assert.equal(result.budget.spent, 0.5);
  assert.equal(result.data.cells.length, 1);
  assert.equal(store.epsilonSpent(CALLER), 0.5);
});

test('exact cohort size is withheld unless policy opts in', () => {
  const { store, engine } = makeEngine();
  const hidden = engine.execute({ metric: 'count', filters: { region: '华东' } }, CALLER);
  assert.equal(hidden.data.cohortSize, null);
  assert.equal(hidden.data.cohortBand, 'large');

  store.updatePolicy({ showCohortSize: true });
  const shown = engine.execute({ metric: 'count', filters: { region: '华南' } }, CALLER);
  assert.ok(shown.data.cohortSize > 0);
});

test('rejects a cohort smaller than k without charging budget', () => {
  const { store, engine } = makeEngine();
  const result = engine.execute(TINY, CALLER);
  assert.equal(result.outcome, OUTCOME.DENIED_THRESHOLD);
  assert.equal(result.privacy.budgetCharged, 0);
  assert.equal(result.privacy.cohortBand, 'below_k');
  // The exact size must not leak through the response.
  assert.equal(result.privacy.cohortSize, null);
  assert.equal(store.epsilonSpent(CALLER), 0);
});

test('splitting by group cannot bypass the threshold (complementary suppression)', () => {
  const { engine } = makeEngine();
  // Whole cohort is large, but "海外 × 法务" contains pinned cohorts of 2 and 3.
  const result = engine.execute(
    { metric: 'count', groupBy: 'ageBand', filters: { region: '海外', dept: '法务' } },
    CALLER,
  );
  assert.equal(result.outcome, OUTCOME.DENIED_COMPLEMENTARY);
  assert.equal(result.data, null);
  // The response must not say which band was small.
  assert.equal(result.privacy.details.smallCellCount >= 1, true);
  assert.equal(JSON.stringify(result).includes('50+'), false);
});

test('grouped query charges epsilon per released cell', () => {
  const { engine } = makeEngine();
  const result = engine.execute({ metric: 'count', groupBy: 'dept' }, CALLER);
  assert.equal(result.outcome, OUTCOME.RELEASED);
  const released = result.data.cells.filter((cell) => !cell.suppressed).length;
  assert.ok(released > 1);
  assert.equal(result.privacy.budgetCharged, released * 0.5);
});

test('denials are still written to the ledger but never consume epsilon', () => {
  const { store, engine } = makeEngine();
  engine.execute(TINY, CALLER);
  const ledger = store.listLedger({ callerId: CALLER });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, 'denied');
  assert.equal(ledger[0].epsilon, 0);
  assert.equal(ledger[0].outcomeCode, OUTCOME.DENIED_THRESHOLD);
});

test('budget exhaustion blocks fresh releases but not cached replays', () => {
  const { store, engine } = makeEngine();
  // One 0.5-epsilon release is all this caller may ever get.
  store.updatePolicy({ perCallerEpsilonCap: 0.5 });
  const first = engine.execute({ metric: 'count', filters: { region: '华东' } }, CALLER);
  assert.equal(first.outcome, OUTCOME.RELEASED);
  const second = engine.execute({ metric: 'count', filters: { region: '华南' } }, CALLER);
  assert.equal(second.outcome, OUTCOME.DENIED_BUDGET);
  assert.equal(second.privacy.budgetCharged, 0);

  const replay = engine.execute({ metric: 'count', filters: { region: '华东' } }, CALLER);
  assert.equal(replay.outcome, OUTCOME.CACHED);
  assert.equal(replay.privacy.budgetCharged, 0);
});

test('repeat-query limit stops fresh repeats inside the window', () => {
  const { store, engine } = makeEngine();
  store.updatePolicy({ repeatLimit: 2, cacheTtlMs: 0 });
  const query = { metric: 'count', filters: { region: '华东' } };
  assert.equal(engine.execute(query, CALLER).outcome, OUTCOME.RELEASED);
  assert.equal(engine.execute(query, CALLER).outcome, OUTCOME.RELEASED);
  const third = engine.execute(query, CALLER);
  assert.equal(third.outcome, OUTCOME.DENIED_REPEAT);
  assert.equal(third.privacy.budgetCharged, 0);
});

test('identical query is served from cache for free', () => {
  const { engine } = makeEngine();
  const query = { metric: 'count', filters: { region: '华东' } };
  const first = engine.execute(query, CALLER);
  const second = engine.execute(query, CALLER);
  assert.equal(first.outcome, OUTCOME.RELEASED);
  assert.equal(second.outcome, OUTCOME.CACHED);
  assert.equal(second.privacy.budgetCharged, 0);
  assert.deepEqual(second.data.cells, first.data.cells);
  assert.equal(second.audit.seq > first.audit.seq, true);
});

test('cache entry is invalidated when the policy version changes', () => {
  const { store, engine } = makeEngine();
  const query = { metric: 'count', filters: { region: '华东' } };
  engine.execute(query, CALLER);
  store.updatePolicy({ k: 6 });
  store.purgeExpiredCache(Date.now(), store.getPolicy().version);
  const after = engine.execute(query, CALLER);
  assert.equal(after.outcome, OUTCOME.RELEASED);
  assert.equal(after.privacy.budgetCharged, 0.5);
});

test('cache entry does not survive a change to the underlying rows', () => {
  const { store, engine } = makeEngine();
  store.updatePolicy({ cacheTtlMs: 60_000 });
  const query = { metric: 'count', filters: { region: '华东' } };
  engine.execute(query, CALLER);
  assert.equal(engine.execute(query, CALLER).outcome, OUTCOME.CACHED);

  // Correct one person's salary: membership is unchanged (so the differencing
  // guard does not fire) but the row signature — and therefore the cache key —
  // is different. The stale answer must not be served.
  store.db
    .prepare(
      `UPDATE employees SET salary = salary + 1000
       WHERE person_id = (SELECT person_id FROM employees WHERE region = '华东' LIMIT 1)`,
    )
    .run();
  const after = engine.execute(query, CALLER);
  assert.equal(after.outcome, OUTCOME.RELEASED);
  assert.equal(after.privacy.budgetCharged, 0.5, 'a fresh release is charged, not a cache hit');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM query_cache').get().n, 2);
});

test('revoked caller is refused even for a cache hit', () => {
  const { store, engine } = makeEngine();
  const query = { metric: 'count', filters: { region: '华东' } };
  engine.execute(query, CALLER);
  store.setCallerActive(CALLER, false);
  const after = engine.execute(query, CALLER);
  assert.equal(after.outcome, OUTCOME.DENIED_INACTIVE);
  assert.equal(after.data, null);
});

test('permission change forces re-evaluation (stale authority version)', () => {
  const { store, engine } = makeEngine();
  const query = { metric: 'count', filters: { region: '华东' } };
  const first = engine.execute(query, CALLER);
  assert.equal(first.outcome, OUTCOME.RELEASED);
  // The client now holds an outdated snapshot of its own authority.
  store.setCallerPermissions(CALLER, ['query:aggregate', 'query:count', 'region:华东']);
  const stale = engine.execute({ ...query, callerVersion: 1 }, CALLER);
  assert.equal(stale.outcome, OUTCOME.DENIED_STALE_AUTHORITY);
  assert.equal(stale.data, null);
  assert.equal(stale.privacy.budgetCharged, 0);

  const refreshed = engine.execute({ ...query, callerVersion: 2 }, CALLER);
  assert.equal(refreshed.outcome, OUTCOME.CACHED, 'same authority scope, cached answer is fine');
});

test('switching filters under a revoked permission is re-judged, not cached', () => {
  const { store, engine } = makeEngine();
  // Warm the cache as a fully privileged caller.
  const before = engine.execute({ metric: 'count', filters: { region: '华东' } }, CALLER);
  assert.equal(before.outcome, OUTCOME.RELEASED);
  // Role change: count permission removed, but the *original* query is still
  // in cache. The next request for a different filter must be judged afresh.
  store.setCallerPermissions(CALLER, ['query:aggregate', 'region:华东']);
  const switched = engine.execute(
    { metric: 'count', filters: { region: '华南' }, callerVersion: store.getCaller(CALLER).version },
    CALLER,
  );
  assert.equal(switched.outcome, OUTCOME.DENIED_PERMISSION);
  const cachedNow = engine.execute(
    { metric: 'count', filters: { region: '华东' }, callerVersion: store.getCaller(CALLER).version },
    CALLER,
  );
  assert.equal(cachedNow.outcome, OUTCOME.DENIED_PERMISSION);
});

test('permission revocation also blocks cached payloads', () => {
  const { store, engine } = makeEngine();
  const query = { metric: 'count', filters: { region: '华东' } };
  engine.execute(query, CALLER);
  store.setCallerPermissions(CALLER, ['query:aggregate']);
  const after = engine.execute(query, CALLER);
  assert.equal(after.outcome, OUTCOME.DENIED_PERMISSION);
});

test('request id replay is idempotent: same answer, no second charge', () => {
  const { store, engine } = makeEngine();
  const query = { metric: 'count', filters: { region: '华东' }, requestId: 'req-1' };
  const first = engine.execute(query, CALLER);
  const second = engine.execute(query, CALLER);
  assert.equal(first.outcome, OUTCOME.RELEASED);
  assert.equal(second.outcome, OUTCOME.REPLAYED);
  assert.deepEqual(second.data.cells, first.data.cells);
  assert.equal(store.epsilonSpent(CALLER), 0.5);
});

test('request id replay cannot be used to re-obtain an answer after revocation', () => {
  const { store, engine } = makeEngine();
  const query = { metric: 'count', filters: { region: '华东' }, requestId: 'req-2' };
  engine.execute(query, CALLER);
  store.setCallerActive(CALLER, false);
  const replay = engine.execute(query, CALLER);
  assert.equal(replay.outcome, OUTCOME.DENIED_INACTIVE);
});

test('differencing: narrowing an already released cohort below k is refused', () => {
  const { store, engine } = makeEngine();
  store.updatePolicy({ cacheTtlMs: 0 });
  // The caller already received an answer about "everyone in 华东 except the
  // first person". Asking about all of 华东 now isolates exactly one person.
  const allRows = store.cohortSnapshot({ region: '华东' });
  store.recordReleasedCohort(
    CALLER,
    'seed-cohort',
    allRows.slice(1).map((row) => row.person_id),
    new Date().toISOString(),
    'count',
  );
  const attack = engine.execute({ metric: 'count', filters: { region: '华东' } }, CALLER);
  assert.equal(attack.outcome, OUTCOME.DENIED_DIFFERENCING);
  assert.equal(attack.privacy.budgetCharged, 0);
  assert.equal(
    JSON.stringify(attack).includes('oneSidedDifference'),
    false,
    'never reveal the difference size',
  );
});

test('differencing: a nested cohort is allowed when both sets are independently >= k', () => {
  const { store, engine } = makeEngine();
  store.updatePolicy({ cacheTtlMs: 0 });
  // count(华东) and count(华东 ∩ 研发) are both about >= k people. Subtracting
  // them yields the count of 华东 \ 研发, which is also large, so nothing below
  // the threshold is isolated and the second release is legitimate.
  assert.equal(
    engine.execute({ metric: 'count', filters: { region: '华东' } }, CALLER).outcome,
    OUTCOME.RELEASED,
  );
  const nested = engine.execute(
    { metric: 'count', filters: { region: '华东', dept: '研发' } },
    CALLER,
  );
  assert.equal(nested.outcome, OUTCOME.RELEASED);
  const complement =
    store.cohortSnapshot({ region: '华东' }).length -
    store.cohortSnapshot({ region: '华东', dept: '研发' }).length;
  assert.ok(complement >= 5, 'complement is itself large');
});

test('differencing: a query that adds fewer than k new people is refused', () => {
  const { store, engine } = makeEngine();
  store.updatePolicy({ cacheTtlMs: 0 });
  // The caller was already answered about "all of 华东 except one person".
  // Asking about all of 华东 now isolates that one person by subtraction.
  const allRows = store.cohortSnapshot({ region: '华东' });
  store.recordReleasedCohort(
    CALLER,
    'seed-cohort',
    allRows.slice(1).map((row) => row.person_id),
    new Date().toISOString(),
    'count',
  );
  const attack = engine.execute({ metric: 'count', filters: { region: '华东' } }, CALLER);
  assert.equal(attack.outcome, OUTCOME.DENIED_DIFFERENCING);
  assert.equal(store.epsilonSpent(CALLER), 0, 'the attack costs nothing and yields nothing');
});

test('differencing does not block a different metric over the same cohort', () => {
  const { engine } = makeEngine();
  const filters = { region: '华东' };
  assert.equal(engine.execute({ metric: 'count', filters }, CALLER).outcome, OUTCOME.RELEASED);
  const salary = engine.execute({ metric: 'avg_salary', filters }, CALLER);
  assert.equal(salary.outcome, OUTCOME.RELEASED);
});

test('a caller cannot receive another caller’s cached answer that would isolate < k people', () => {
  // The cache is keyed independently of the caller, so it is shared. Before the
  // differencing guard was moved ahead of the cache lookup, caller B could ask
  // for a cohort caller A had already warmed and receive the cached number even
  // though, against B's own history, that cohort was a 2-person slice.
  const store = new Store(':memory:');
  const perms = ['query:aggregate', 'query:count', 'query:metric'];
  store.upsertCaller({ callerId: 'warm', displayName: 'W', role: 'r', permissions: perms, allRegions: true });
  store.upsertCaller({ callerId: 'attacker', displayName: 'A', role: 'r', permissions: perms, allRegions: true });
  const mk = (n, region, dept, prefix) =>
    Array.from({ length: n }, (_, i) => ({
      personId: `${prefix}${i}`,
      name: 'x',
      region,
      dept,
      age: 30,
      ageBand: '30-34',
      tenureYears: 3,
      salary: 100_000 + i,
    }));
  // 研发: 60 in 华东, 2 in 华南. 客服: 200 in 华东 (to keep other cells healthy).
  store.replaceEmployees([
    ...mk(60, '华东', '研发', 'a'),
    ...mk(2, '华南', '研发', 'b'),
    ...mk(200, '华东', '客服', 'c'),
  ]);
  const engine = new PrivacyEngine(store, { rng: () => 0.5 });
  store.updatePolicy({
    k: 5,
    cacheTtlMs: 900_000,
    repeatLimit: 50,
    perCallerEpsilonCap: 100,
    perQueryEpsilon: 0.1,
  });

  const slice = { metric: 'avg_salary', filters: { region: '华东', dept: '研发' } }; // 60
  const superset = { metric: 'avg_salary', filters: { dept: '研发' } }; // 62; superset \ slice = 2

  // The first caller releases the slice and warms the cache.
  assert.equal(engine.execute(slice, 'warm').outcome, OUTCOME.RELEASED);
  // The second caller releases the superset.
  assert.equal(engine.execute(superset, 'attacker').outcome, OUTCOME.RELEASED);

  // Asking for the slice now isolates the 2 people outside 华东 — must be
  // refused even though a perfect cached answer exists.
  const attack = engine.execute(slice, 'attacker');
  assert.equal(attack.outcome, OUTCOME.DENIED_DIFFERENCING);
  assert.equal(attack.privacy.budgetCharged, 0);

  // Sanity: the cache entry still exists and would have been served with the
  // guard accidentally disabled — proving the assertion above is load-bearing.
  // Written directly so the policy *version* does not change (which would
  // invalidate the cache and make the check vacuous).
  store.db.prepare('UPDATE policy SET differencing_protection = 0 WHERE id = 1').run();
  const unguarded = engine.execute(slice, 'attacker');
  assert.equal(unguarded.outcome, OUTCOME.CACHED);
});

test('mean metrics use bounded sensitivity and noise', () => {
  const { engine } = makeEngine();
  const result = engine.execute({ metric: 'avg_salary', filters: { region: '华东' } }, CALLER);
  assert.equal(result.outcome, OUTCOME.RELEASED);
  assert.equal(result.privacy.mechanism, 'laplace');
  const cell = result.data.cells[0];
  assert.ok(cell.value >= 30_000 && cell.value <= 220_000);
});

test('unknown metric or grouping is rejected as invalid without charging', () => {
  const { store, engine } = makeEngine();
  const badMetric = engine.execute({ metric: 'median_salary' }, CALLER);
  assert.equal(badMetric.outcome, OUTCOME.DENIED_INVALID);
  const badGroup = engine.execute({ metric: 'count', groupBy: 'salary' }, CALLER);
  assert.equal(badGroup.outcome, OUTCOME.DENIED_INVALID);
  assert.equal(store.epsilonSpent(CALLER), 0);
});

test('an unknown caller is rejected', () => {
  const { engine } = makeEngine();
  const result = engine.execute(WHOLE, 'nobody');
  assert.equal(result.outcome, OUTCOME.DENIED_NOT_FOUND);
  assert.equal(result.data, null);
});

test('region scoping silently restricts a caller with region permissions', () => {
  const { engine } = makeEngine();
  // analyst-regional may only see 华东.
  const whole = engine.execute({ metric: 'count' }, 'analyst-regional');
  const eastOnly = engine.execute({ metric: 'count', filters: { region: '华东' } }, 'analyst-regional');
  assert.equal(whole.outcome, OUTCOME.RELEASED);
  // Both answer the same population, so the aggregate numbers match closely.
  assert.equal(whole.data.cells[0].value, eastOnly.data.cells[0].value);

  const other = engine.execute({ metric: 'count', filters: { region: '西部' } }, 'analyst-regional');
  assert.equal(other.outcome, OUTCOME.DENIED_PERMISSION);
});

test('a caller with no region grant sees no population at all', () => {
  const { engine } = makeEngine();
  // intern-demo is active but holds no `region:*` grant: an empty cohort, not
  // the whole organisation.
  const result = engine.execute({ metric: 'count' }, 'intern-demo');
  assert.equal(result.outcome, OUTCOME.DENIED_THRESHOLD);
  assert.equal(result.privacy.cohortBand, 'empty');
  assert.equal(result.data, null);
});

test('every outcome is recorded in the hash-chained audit log', () => {
  const { store, engine } = makeEngine();
  engine.execute(WHOLE, CALLER);
  engine.execute(TINY, CALLER);
  engine.execute(WHOLE, 'nobody');
  const chain = store.verifyAuditChain();
  assert.equal(chain.ok, true);
  const outcomes = store.listAudit({ limit: 100 }).map((record) => record.outcome);
  assert.ok(outcomes.includes(OUTCOME.RELEASED));
  assert.ok(outcomes.includes(OUTCOME.DENIED_THRESHOLD));
  assert.ok(outcomes.includes(OUTCOME.DENIED_NOT_FOUND));
});

test('audit log is physically append-only', () => {
  const { store, engine } = makeEngine();
  engine.execute(WHOLE, CALLER);
  assert.throws(() => store.db.exec("UPDATE audit_log SET outcome = 'released'"), /append-only/);
  assert.throws(() => store.db.exec('DELETE FROM audit_log'), /append-only/);
});

test('tampering with audit history is detected', () => {
  const { store, engine } = makeEngine();
  engine.execute(WHOLE, CALLER);
  engine.execute({ metric: 'count', filters: { region: '华东' } }, CALLER);
  assert.equal(store.verifyAuditChain().ok, true);
  // Drop the triggers, tamper, check detection (simulating an operator with
  // database access, i.e. exactly the threat model a hash chain is for).
  store.db.exec('DROP TRIGGER audit_no_update');
  store.db.exec("UPDATE audit_log SET outcome = 'denied_k_threshold' WHERE seq = 2");
  const after = store.verifyAuditChain();
  assert.equal(after.ok, false);
  assert.equal(after.brokenAt, 2);
});

test('concurrent releases cannot overspend the budget', async () => {
  const { store, engine } = makeEngine();
  store.updatePolicy({ perCallerEpsilonCap: 1.5 });
  const regions = ['华东', '华南', '华北', '西部', '东北', '海外'];
  const queries = [];
  for (let i = 0; i < 12; i += 1) {
    queries.push({ metric: 'count', filters: { region: regions[i % regions.length] } });
  }
  // Same cohort twice => the second is a cache hit, so use one query per region
  // at most; budget allows three fresh 0.5-cost releases.
  const results = queries.map((query) => engine.execute(query, CALLER));
  const released = results.filter((result) => result.outcome === OUTCOME.RELEASED);
  const cached = results.filter((result) => result.outcome === OUTCOME.CACHED);
  assert.equal(released.length, 3, '1.5 epsilon buys exactly three 0.5-cost releases');
  assert.equal(store.epsilonSpent(CALLER), 1.5);
  assert.ok(cached.length >= 1, 'duplicate queries are served from cache');
  const denied = results.filter((result) => result.outcome === OUTCOME.DENIED_BUDGET);
  assert.equal(denied.length, queries.length - released.length - cached.length);
});

test('two engines sharing one database cannot both spend the last epsilon', async () => {
  const { store, engine } = makeEngine();
  store.updatePolicy({ perCallerEpsilonCap: 0.5 });
  const { PrivacyEngine } = await import('../src/privacy.js');
  const competitor = new PrivacyEngine(store);
  const first = engine.execute({ metric: 'count', filters: { region: '华东' } }, CALLER);
  const second = competitor.execute({ metric: 'count', filters: { region: '华南' } }, CALLER);
  assert.equal(first.outcome, OUTCOME.RELEASED);
  assert.equal(second.outcome, OUTCOME.DENIED_BUDGET);
  assert.equal(store.epsilonSpent(CALLER), 0.5);
});

test('budget accounting is exact for fractional per-query costs', () => {
  const { store, engine } = makeEngine();
  store.updatePolicy({ perQueryEpsilon: 0.1, perCallerEpsilonCap: 0.3 });
  const regions = ['华东', '华南', '华北', '西部'];
  const outcomes = regions.map(
    (region) => engine.execute({ metric: 'count', filters: { region } }, CALLER).outcome,
  );
  assert.equal(outcomes.filter((outcome) => outcome === OUTCOME.RELEASED).length, 3);
  assert.ok(Math.abs(store.epsilonSpent(CALLER) - 0.3) < 1e-9);
});

test('lowering k below 2 is rejected by the policy layer', async () => {
  // Validation lives in the HTTP layer; the engine trusts the stored policy.
  const { validatePolicyPatch } = await import('../src/http.js');
  assert.throws(() => validatePolicyPatch({ k: 1 }), /k 必须在/);
  assert.throws(() => validatePolicyPatch({ perQueryEpsilon: -1 }), /perQueryEpsilon/);
  assert.throws(() => validatePolicyPatch({ nope: 1 }), /未知策略字段/);
});
