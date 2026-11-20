#!/usr/bin/env node
/**
 * Seed a SQLite database with the deterministic demo dataset and four
 * callers that cover the interesting permission shapes.
 *
 *   node scripts/seed.js [path/to/db.sqlite]
 *   DB_PATH=... node scripts/seed.js
 *
 * This replaces the employee rows (the audit log and budget ledger are kept;
 *  cached results are keyed by a row signature and simply stop matching).
 */

import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { seedIfEmpty } from '../src/bootstrap.js';

const dbPath = resolve(process.argv[2] ?? process.env.DB_PATH ?? 'data/privacy.sqlite');
const store = new Store(dbPath);
const seeded = seedIfEmpty(store, { force: true });

const summary = {
  dbPath,
  seeded,
  employees: store.countEmployees(),
  callers: store.listCallers().map((caller) => caller.callerId),
  audit: store.verifyAuditChain(),
};
store.close();
console.log(JSON.stringify(summary, null, 2));
