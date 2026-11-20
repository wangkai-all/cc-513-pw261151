/**
 * Central policy defaults and enumerations.
 *
 * The policy is persisted in the `policy` table so that every query, cache
 * entry and audit record can be tied to a concrete policy version. Changing a
 * privacy-relevant value bumps the version and invalidates the result cache.
 */

export const GENESIS_HASH = '0'.repeat(64);

export const METRICS = Object.freeze({
  count: {
    id: 'count',
    label: '人数（计数）',
    unit: '人',
    kind: 'count',
    sensitivity: 1,
    description: '按筛选条件统计人数，结果加入 Laplace 噪声。',
  },
  avg_salary: {
    id: 'avg_salary',
    label: '平均薪资',
    unit: '元',
    kind: 'mean',
    field: 'salary',
    description: '有界平均薪资，敏感度 = (上限 − 下限) / 组内真实人数。',
  },
  avg_tenure: {
    id: 'avg_tenure',
    label: '平均司龄',
    unit: '年',
    kind: 'mean',
    field: 'tenure_years',
    description: '有界平均司龄，敏感度 = (上限 − 下限) / 组内真实人数。',
  },
});

export const DIMENSIONS = Object.freeze({
  region: { id: 'region', label: '地区', column: 'region' },
  dept: { id: 'dept', label: '部门', column: 'dept' },
  ageBand: { id: 'ageBand', label: '年龄段', column: 'age_band' },
});

export const GROUP_BY_OPTIONS = Object.freeze(['none', 'region', 'dept', 'ageBand']);

export const DEFAULT_POLICY = Object.freeze({
  /** Minimum number of distinct people behind any released cell (k-anonymity). */
  k: 5,
  /** Base privacy budget charged for one fresh release. */
  perQueryEpsilon: 0.5,
  /** Lifetime epsilon a single person may contribute to one caller. */
  perCallerEpsilonCap: 6,
  /** How many attempts of the same fingerprint are allowed in the window. */
  repeatLimit: 5,
  repeatWindowMs: 60 * 60 * 1000,
  /** How long a released answer may be replayed without new budget cost. */
  cacheTtlMs: 15 * 60 * 1000,
  /** Suppress a second cell whenever one cell is suppressed. */
  complementarySuppression: true,
  /** Reject queries whose difference against prior releases isolates < k people. */
  differencingProtection: true,
  /** Display exact (released) cohort size to end users. Off by default. */
  showCohortSize: false,
  /** Clamping bounds used to bound the sensitivity of numeric metrics. */
  salaryMin: 30_000,
  salaryMax: 220_000,
  tenureMin: 0,
  tenureMax: 30,
});

/** Values accepted from the admin policy API; clamping bounds are not editable. */
export const POLICY_EDITABLE_LIMITS = Object.freeze({
  k: { min: 2, max: 100, integer: true },
  perQueryEpsilon: { min: 0.05, max: 5 },
  perCallerEpsilonCap: { min: 0.1, max: 100 },
  repeatLimit: { min: 1, max: 100, integer: true },
  repeatWindowMs: { min: 60_000, max: 7 * 24 * 60 * 60 * 1000, integer: true },
  cacheTtlMs: { min: 0, max: 24 * 60 * 60 * 1000, integer: true },
  complementarySuppression: { boolean: true },
  differencingProtection: { boolean: true },
  showCohortSize: { boolean: true },
});
