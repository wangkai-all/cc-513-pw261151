/**
 * Shared seeding used by both `npm start` (auto-seed when empty) and
 * `scripts/seed.js`. Returns true when it actually inserted data.
 */

import { generateEmployees, generatePinnedEmployees } from './seed-data.js';

export const DEMO_CALLERS = Object.freeze([
  {
    callerId: 'analyst-hr',
    displayName: 'HR 分析师',
    role: 'hr-analyst',
    permissions: ['query:aggregate', 'query:count', 'query:metric'],
    allRegions: true,
  },
  {
    callerId: 'analyst-fin',
    displayName: '财务分析师（无计数权限）',
    role: 'finance-analyst',
    permissions: ['query:aggregate', 'query:metric'],
    allRegions: true,
  },
  {
    callerId: 'analyst-regional',
    displayName: '区域运营（仅华东）',
    role: 'ops',
    permissions: ['query:aggregate', 'query:count', 'region:华东'],
    allRegions: false,
  },
  {
    callerId: 'intern-demo',
    displayName: '演示实习生（无地区授权）',
    role: 'intern',
    permissions: ['query:aggregate', 'query:count'],
    allRegions: false,
  },
]);

export function seedIfEmpty(store, { force = false } = {}) {
  if (!force && store.countEmployees() > 0) return false;
  const base = generateEmployees(4200);
  const pinned = generatePinnedEmployees(base.length);
  store.replaceEmployees([...base, ...pinned]);
  store.transaction(() => {
    for (const caller of DEMO_CALLERS) store.upsertCaller(caller);
    store.appendAudit({
      actor: 'system',
      action: 'seed',
      outcome: 'applied',
      detail: {
        employees: base.length + pinned.length,
        callers: DEMO_CALLERS.length,
        note: 'deterministic demo dataset',
      },
    });
  });
  return true;
}
