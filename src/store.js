/**
 * SQLite storage layer (node:sqlite, built into Node 22.5+).
 *
 * Design notes
 * ------------
 *  - `audit_log` is append-only and hash-chained: each row's hash covers the
 *    previous row's hash plus a canonical serialization of the row, and SQLite
 *    triggers reject UPDATE/DELETE. Any edit breaks the chain and is caught by
 *    `verifyAuditChain()`.
 *  - `budget_ledger` records every attempt (releases, cache replays, denials)
 *    with UNIQUE(caller_id, request_id). A retried request id can never be
 *    charged twice or replayed into a second independent release.
 *  - `caller_released_cohorts` keeps the exact member set of every cohort a
 *    caller has already received an answer about, so a later query whose cohort
 *    differs by fewer than k people can be rejected (classic differencing).
 *  - `query_cache` stores released answers keyed by policy version + query +
 *    a signature of the underlying rows. Cached answers are re-checked against
 *    the *current* caller's authority, budget and cohort history before use.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_POLICY, GENESIS_HASH } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  person_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  region       TEXT NOT NULL,
  dept         TEXT NOT NULL,
  age          INTEGER NOT NULL,
  age_band     TEXT NOT NULL,
  tenure_years REAL NOT NULL,
  salary       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employees_region ON employees(region);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(dept);
CREATE INDEX IF NOT EXISTS idx_employees_age_band ON employees(age_band);

CREATE TABLE IF NOT EXISTS callers (
  caller_id     TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,
  permissions   TEXT NOT NULL,      -- JSON array
  all_regions   INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  -- Bumped whenever permissions / activation change. Clients echo the version
  -- they last saw so stale authority is refused instead of silently used.
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS policy (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  version                  INTEGER NOT NULL,
  k                        INTEGER NOT NULL,
  per_query_epsilon        REAL NOT NULL,
  per_caller_epsilon_cap   REAL NOT NULL,
  repeat_limit             INTEGER NOT NULL,
  repeat_window_ms         INTEGER NOT NULL,
  cache_ttl_ms             INTEGER NOT NULL,
  complementary_suppression INTEGER NOT NULL,
  differencing_protection  INTEGER NOT NULL,
  show_cohort_size         INTEGER NOT NULL,
  salary_min               INTEGER NOT NULL,
  salary_max               INTEGER NOT NULL,
  tenure_min               REAL NOT NULL,
  tenure_max               REAL NOT NULL,
  updated_at               TEXT NOT NULL,
  updated_by               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  request_id   TEXT,
  outcome      TEXT NOT NULL,
  detail       TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update
  BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete
  BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE IF NOT EXISTS budget_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id     TEXT NOT NULL,
  request_id    TEXT NOT NULL,
  at            TEXT NOT NULL,
  epsilon       REAL NOT NULL,
  status        TEXT NOT NULL,        -- released | denied
  outcome_code  TEXT NOT NULL,
  cache_key     TEXT,
  fingerprint   TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  -- Snapshot of what was released, so an idempotent replay returns byte-for-byte
  -- the same answer instead of a new noisy draw. NULL for denials/cache hits.
  result_json   TEXT,
  UNIQUE (caller_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_budget_caller ON budget_ledger(caller_id, status);
CREATE INDEX IF NOT EXISTS idx_budget_fingerprint ON budget_ledger(caller_id, fingerprint, at);

CREATE TABLE IF NOT EXISTS caller_released_cohorts (
  caller_id  TEXT NOT NULL,
  cohort_id  TEXT NOT NULL,
  person_ids TEXT NOT NULL,           -- JSON array, sorted
  metric     TEXT NOT NULL DEFAULT '',-- metric released over this cohort
  released_at TEXT NOT NULL,
  PRIMARY KEY (caller_id, cohort_id, metric)
);

CREATE TABLE IF NOT EXISTS caller_person_exposure (
  caller_id  TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  first_cohort TEXT NOT NULL,
  PRIMARY KEY (caller_id, person_id)
);

CREATE TABLE IF NOT EXISTS query_cache (
  cache_key        TEXT PRIMARY KEY,
  policy_version   INTEGER NOT NULL,
  payload          TEXT NOT NULL,
  cohort_signature TEXT NOT NULL,
  created_at       INTEGER NOT NULL,  -- epoch ms
  expires_at       INTEGER NOT NULL,
  hits             INTEGER NOT NULL DEFAULT 0,
  last_hit_at      INTEGER
);
`;

const POLICY_COLUMNS = {
  k: 'k',
  perQueryEpsilon: 'per_query_epsilon',
  perCallerEpsilonCap: 'per_caller_epsilon_cap',
  repeatLimit: 'repeat_limit',
  repeatWindowMs: 'repeat_window_ms',
  cacheTtlMs: 'cache_ttl_ms',
  complementarySuppression: 'complementary_suppression',
  differencingProtection: 'differencing_protection',
  showCohortSize: 'show_cohort_size',
};

function boolToInt(value) {
  return value ? 1 : 0;
}

function rowToPolicy(row) {
  return {
    version: row.version,
    k: row.k,
    perQueryEpsilon: row.per_query_epsilon,
    perCallerEpsilonCap: row.per_caller_epsilon_cap,
    repeatLimit: row.repeat_limit,
    repeatWindowMs: row.repeat_window_ms,
    cacheTtlMs: row.cache_ttl_ms,
    complementarySuppression: Boolean(row.complementary_suppression),
    differencingProtection: Boolean(row.differencing_protection),
    showCohortSize: Boolean(row.show_cohort_size),
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    tenureMin: row.tenure_min,
    tenureMax: row.tenure_max,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Stable JSON: sorted keys, so hashes and cache keys are reproducible. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\u0000');
  return hash.digest('hex');
}

export class Store {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
    );
    this.db.exec(SCHEMA);
    this.#ensurePolicy();
  }

  close() {
    this.db.close();
  }

  #ensurePolicy() {
    const exists = this.db.prepare('SELECT id FROM policy WHERE id = 1').get();
    if (exists) return;
    this.db
      .prepare(
        `INSERT INTO policy (id, version, k, per_query_epsilon, per_caller_epsilon_cap,
            repeat_limit, repeat_window_ms, cache_ttl_ms, complementary_suppression,
            differencing_protection, show_cohort_size, salary_min, salary_max,
            tenure_min, tenure_max, updated_at, updated_by)
         VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        DEFAULT_POLICY.k,
        DEFAULT_POLICY.perQueryEpsilon,
        DEFAULT_POLICY.perCallerEpsilonCap,
        DEFAULT_POLICY.repeatLimit,
        DEFAULT_POLICY.repeatWindowMs,
        DEFAULT_POLICY.cacheTtlMs,
        boolToInt(DEFAULT_POLICY.complementarySuppression),
        boolToInt(DEFAULT_POLICY.differencingProtection),
        boolToInt(DEFAULT_POLICY.showCohortSize),
        DEFAULT_POLICY.salaryMin,
        DEFAULT_POLICY.salaryMax,
        DEFAULT_POLICY.tenureMin,
        DEFAULT_POLICY.tenureMax,
        new Date().toISOString(),
        'system',
      );
  }

  getPolicy() {
    return rowToPolicy(this.db.prepare('SELECT * FROM policy WHERE id = 1').get());
  }

  /** Apply an already-validated patch; bump version and invalidate cache. */
  updatePolicy(patch, actor = 'admin') {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(POLICY_COLUMNS)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      const value = patch[key];
      values.push(typeof value === 'boolean' ? boolToInt(value) : value);
    }
    if (sets.length === 0) return this.getPolicy();
    sets.push('version = version + 1', 'updated_at = ?', 'updated_by = ?');
    values.push(new Date().toISOString(), actor, 1);
    this.db.prepare(`UPDATE policy SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getPolicy();
  }

  replaceEmployees(rows) {
    const insert = this.db.prepare(
      `INSERT INTO employees (person_id, name, region, dept, age, age_band, tenure_years, salary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      this.db.exec('DELETE FROM employees');
      for (const row of rows) {
        insert.run(
          row.personId,
          row.name,
          row.region,
          row.dept,
          row.age,
          row.ageBand,
          row.tenureYears,
          row.salary,
        );
      }
    });
  }

  countEmployees() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM employees').get().n;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------------------------------------------------------------- callers

  upsertCaller(caller) {
    this.db
      .prepare(
        `INSERT INTO callers (caller_id, display_name, role, permissions, all_regions, active)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(caller_id) DO UPDATE SET
           display_name = excluded.display_name,
           role = excluded.role,
           permissions = excluded.permissions,
           all_regions = excluded.all_regions,
           version = version + 1`,
      )
      .run(
        caller.callerId,
        caller.displayName,
        caller.role,
        JSON.stringify(caller.permissions ?? []),
        caller.allRegions ? 1 : 0,
        caller.active === false ? 0 : 1,
      );
  }

  getCaller(callerId) {
    const row = this.db.prepare('SELECT * FROM callers WHERE caller_id = ?').get(callerId);
    if (!row) return null;
    return {
      callerId: row.caller_id,
      displayName: row.display_name,
      role: row.role,
      permissions: JSON.parse(row.permissions),
      allRegions: Boolean(row.all_regions),
      active: Boolean(row.active),
      version: row.version,
    };
  }

  listCallers() {
    return this.db
      .prepare('SELECT * FROM callers ORDER BY caller_id')
      .all()
      .map((row) => ({
        callerId: row.caller_id,
        displayName: row.display_name,
        role: row.role,
        permissions: JSON.parse(row.permissions),
        allRegions: Boolean(row.all_regions),
        active: Boolean(row.active),
        version: row.version,
      }));
  }

  /** Activation switch used by the permission-revocation scenario. */
  setCallerActive(callerId, active) {
    return (
      this.db
        .prepare('UPDATE callers SET active = ?, version = version + 1 WHERE caller_id = ?')
        .run(active ? 1 : 0, callerId).changes > 0
    );
  }

  setCallerPermissions(callerId, permissions, allRegions) {
    if (allRegions === undefined) {
      this.db
        .prepare('UPDATE callers SET permissions = ?, version = version + 1 WHERE caller_id = ?')
        .run(JSON.stringify(permissions), callerId);
    } else {
      this.db
        .prepare(
          `UPDATE callers SET permissions = ?, all_regions = ?, version = version + 1
           WHERE caller_id = ?`,
        )
        .run(JSON.stringify(permissions), allRegions ? 1 : 0, callerId);
    }
  }

  // ------------------------------------------------------------------ audit

  /**
   * Append a hash-chained audit record. Returns { seq, hash }. Callers should
   * invoke it inside the transaction of the state change it describes.
   */
  appendAudit({ actor, action, requestId = null, outcome, detail }) {
    const prev = this.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get();
    const prevHash = prev?.hash ?? GENESIS_HASH;
    const at = new Date().toISOString();
    const detailJson = canonicalJson(detail);
    const body = canonicalJson({ at, actor, action, requestId, outcome, detail });
    const hash = sha256([prevHash, body]);
    const info = this.db
      .prepare(
        `INSERT INTO audit_log (at, actor, action, request_id, outcome, detail, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(at, actor, action, requestId, outcome, detailJson, prevHash, hash);
    return { seq: Number(info.lastInsertRowid), hash };
  }

  listAudit({ limit = 200, actor = null } = {}) {
    const rows = actor
      ? this.db
          .prepare('SELECT * FROM audit_log WHERE actor = ? ORDER BY seq DESC LIMIT ?')
          .all(actor, limit)
      : this.db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?').all(limit);
    return rows.map((row) => ({
      seq: row.seq,
      at: row.at,
      actor: row.actor,
      action: row.action,
      requestId: row.request_id,
      outcome: row.outcome,
      detail: JSON.parse(row.detail),
      prevHash: row.prev_hash,
      hash: row.hash,
    }));
  }

  /**
   * Recompute the full chain. Returns {ok:false, brokenAt} for the first
   * tampered sequence number. Detects edits, deletions and reordering.
   */
  verifyAuditChain() {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all();
    let prevHash = GENESIS_HASH;
    for (const row of rows) {
      const body = canonicalJson({
        at: row.at,
        actor: row.actor,
        action: row.action,
        requestId: row.request_id,
        outcome: row.outcome,
        detail: JSON.parse(row.detail),
      });
      const expected = sha256([prevHash, body]);
      if (row.prev_hash !== prevHash || row.hash !== expected) {
        return { ok: false, brokenAt: row.seq, checked: rows.length };
      }
      prevHash = row.hash;
    }
    return { ok: true, brokenAt: null, checked: rows.length, head: prevHash };
  }

  // ----------------------------------------------------------------- budget

  epsilonSpent(callerId) {
    return this.db
      .prepare(
        `SELECT COALESCE(SUM(epsilon), 0) AS spent FROM budget_ledger
         WHERE caller_id = ? AND status = 'released'`,
      )
      .get(callerId).spent;
  }

  findLedgerEntry(callerId, requestId) {
    return this.db
      .prepare('SELECT * FROM budget_ledger WHERE caller_id = ? AND request_id = ?')
      .get(callerId, requestId);
  }

  /**
   * Record an attempt. UNIQUE(caller, request_id) makes this idempotent: a
   * request id that already exists (e.g. a replay attempt that is now denied)
   * is ignored rather than raising. Returns true when a row was inserted.
   */
  insertLedgerEntry(entry) {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO budget_ledger
           (caller_id, request_id, at, epsilon, status, outcome_code, cache_key, fingerprint,
            note, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.callerId,
        entry.requestId,
        entry.at,
        entry.epsilon,
        entry.status,
        entry.outcomeCode,
        entry.cacheKey ?? null,
        entry.fingerprint ?? '',
        entry.note ?? '',
        entry.resultJson ?? null,
      );
    return info.changes > 0;
  }

  listLedger({ callerId = null, limit = 200 } = {}) {
    const rows = callerId
      ? this.db
          .prepare('SELECT * FROM budget_ledger WHERE caller_id = ? ORDER BY id DESC LIMIT ?')
          .all(callerId, limit)
      : this.db.prepare('SELECT * FROM budget_ledger ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((row) => ({
      id: row.id,
      callerId: row.caller_id,
      requestId: row.request_id,
      at: row.at,
      epsilon: row.epsilon,
      status: row.status,
      outcomeCode: row.outcome_code,
      cacheKey: row.cache_key,
      fingerprint: row.fingerprint,
      note: row.note,
      resultJson: row.result_json ? JSON.parse(row.result_json) : null,
    }));
  }

  /**
   * Attempts of this exact query inside the window. Cache replays are excluded:
   * replaying the same released number leaks nothing, while fresh noisy
   * releases and denials both count (denials are a threshold oracle and must
   * be rate-limited too).
   */
  countAttempts(callerId, fingerprint, sinceIso) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM budget_ledger
         WHERE caller_id = ? AND fingerprint = ? AND at >= ? AND outcome_code <> 'cached'`,
      )
      .get(callerId, fingerprint, sinceIso).n;
  }

  // -------------------------------------------------- released cohort history

  /**
   * Distinct cohorts this caller has received an answer about, optionally only
   * those where `metric` was released. The differencing guard only needs
   * cohorts of the *same* metric: two different metrics (say count and average
   * salary) cannot be subtracted from one another to isolate people.
   */
  listReleasedCohorts(callerId, { metric = null } = {}) {
    const rows = metric
      ? this.db
          .prepare(
            `SELECT cohort_id, person_ids FROM caller_released_cohorts
             WHERE caller_id = ? AND metric = ? ORDER BY released_at`,
          )
          .all(callerId, metric)
      : this.db
          .prepare(
            `SELECT cohort_id, person_ids FROM caller_released_cohorts
             WHERE caller_id = ? ORDER BY released_at`,
          )
          .all(callerId);
    return rows.map((row) => ({
      cohortId: row.cohort_id,
      personIds: JSON.parse(row.person_ids),
    }));
  }

  recordReleasedCohort(callerId, cohortId, personIds, releasedAtIso, metric = '') {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO caller_released_cohorts
           (caller_id, cohort_id, person_ids, metric, released_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(callerId, cohortId, JSON.stringify(personIds), metric, releasedAtIso);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO caller_person_exposure (caller_id, person_id, first_cohort)
       VALUES (?, ?, ?)`,
    );
    for (const personId of personIds) insert.run(callerId, personId, cohortId);
  }

  exposedPersonCount(callerId) {
    return this.db
      .prepare('SELECT COUNT(*) AS n FROM caller_person_exposure WHERE caller_id = ?')
      .get(callerId).n;
  }

  // ------------------------------------------------------------------ cache

  getCacheEntry(cacheKey) {
    const row = this.db.prepare('SELECT * FROM query_cache WHERE cache_key = ?').get(cacheKey);
    if (!row) return null;
    return {
      cacheKey: row.cache_key,
      policyVersion: row.policy_version,
      payload: JSON.parse(row.payload),
      cohortSignature: row.cohort_signature,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      hits: row.hits,
      lastHitAt: row.last_hit_at,
    };
  }

  putCacheEntry(entry) {
    this.db
      .prepare(
        `INSERT INTO query_cache
           (cache_key, policy_version, payload, cohort_signature, created_at, expires_at, hits)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(cache_key) DO UPDATE SET
           policy_version = excluded.policy_version,
           payload = excluded.payload,
           cohort_signature = excluded.cohort_signature,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           hits = 0,
           last_hit_at = NULL`,
      )
      .run(
        entry.cacheKey,
        entry.policyVersion,
        JSON.stringify(entry.payload),
        entry.cohortSignature,
        entry.createdAt,
        entry.expiresAt,
      );
  }

  recordCacheHit(cacheKey, at = Date.now()) {
    this.db
      .prepare('UPDATE query_cache SET hits = hits + 1, last_hit_at = ? WHERE cache_key = ?')
      .run(at, cacheKey);
  }

  purgeCache({ reason = 'manual' } = {}) {
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM query_cache').get().n;
    this.db.exec('DELETE FROM query_cache');
    return { purged: before, reason };
  }

  purgeExpiredCache(now = Date.now(), policyVersion = null) {
    const removedByAge = Number(
      this.db.prepare('DELETE FROM query_cache WHERE expires_at <= ?').run(now).changes,
    );
    let removedByVersion = 0;
    if (policyVersion !== null) {
      removedByVersion = Number(
        this.db
          .prepare('DELETE FROM query_cache WHERE policy_version <> ?')
          .run(policyVersion).changes,
      );
    }
    return { removedByAge, removedByVersion };
  }

  cacheStats(now = Date.now()) {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS expired,
           COALESCE(SUM(hits), 0) AS hits
         FROM query_cache`,
      )
      .get(now);
    return { total: row.total, expired: row.expired, hits: row.hits };
  }

  /** Row-level snapshot used for cohort signatures and cell construction. */
  cohortSnapshot(filters = {}, regionScope = null) {
    const clauses = [];
    const values = [];
    const columns = { region: 'region', dept: 'dept', ageBand: 'age_band' };
    for (const [key, value] of Object.entries(filters)) {
      clauses.push(`${columns[key]} = ?`);
      values.push(value);
    }
    if (regionScope) {
      if (regionScope.length === 0) return [];
      clauses.push(`region IN (${regionScope.map(() => '?').join(',')})`);
      values.push(...regionScope);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT person_id, region, dept, age_band, tenure_years, salary
         FROM employees ${whereSql} ORDER BY person_id`,
      )
      .all(...values);
  }

  distinctValues(column) {
    const allowed = { region: 'region', dept: 'dept', age_band: 'age_band' };
    const safe = allowed[column];
    if (!safe) throw new Error(`unsupported column ${column}`);
    return this.db
      .prepare(`SELECT DISTINCT ${safe} AS value FROM employees ORDER BY value`)
      .all()
      .map((row) => row.value);
  }

  getEmployee(personId) {
    const row = this.db
      .prepare(
        'SELECT person_id, name, region, dept, age_band, tenure_years, salary FROM employees WHERE person_id = ?',
      )
      .get(personId);
    return row
      ? {
          personId: row.person_id,
          name: row.name,
          region: row.region,
          dept: row.dept,
          ageBand: row.age_band,
          tenureYears: row.tenure_years,
          salary: row.salary,
        }
      : null;
  }
}
