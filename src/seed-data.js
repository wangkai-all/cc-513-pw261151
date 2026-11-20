/**
 * Deterministic, auditable seed data.
 *
 * Rows are generated from a fixed PRNG so that two installations with the same
 * seed produce byte-identical cohorts. This matters for tests and for the
 * published audit exemplar.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ada', 'Bo', 'Cai', 'Dai', 'Eli', 'Fen', 'Gao', 'Hui', 'Ivy', 'Jun',
  'Kai', 'Lin', 'Ming', 'Nan', 'Ouy', 'Ping', 'Qin', 'Rui', 'Shan', 'Tao',
  'Ula', 'Wei', 'Xin', 'Yan', 'Zhe', 'Zhu', 'An', 'Bei', 'Chun', 'Dong'];
const LAST = ['陈', '林', '王', '赵', '钱', '孙', '李', '周', '吴', '郑',
  '冯', '许', '何', '高', '罗', '宋', '谢', '韩', '唐', '许'];

const REGIONS = [
  { region: '华东', weight: 0.34 },
  { region: '华南', weight: 0.2 },
  { region: '华北', weight: 0.18 },
  { region: '西部', weight: 0.12 },
  { region: '东北', weight: 0.1 },
  { region: '海外', weight: 0.06 },
];

const DEPTS = [
  { dept: '研发', weight: 0.3, salary: [120_000, 220_000] },
  { dept: '产品', weight: 0.14, salary: [95_000, 190_000] },
  { dept: '销售', weight: 0.24, salary: [50_000, 160_000] },
  { dept: '运营', weight: 0.12, salary: [45_000, 110_000] },
  { dept: '财务', weight: 0.08, salary: [55_000, 140_000] },
  { dept: '法务', weight: 0.04, salary: [60_000, 170_000] },
  { dept: '客服', weight: 0.08, salary: [30_000, 85_000] },
];

export const AGE_BANDS = ['18-24', '25-29', '30-34', '35-39', '40-44', '45-49', '50+'];

function pickWeighted(rng, items) {
  let roll = rng();
  let acc = 0;
  for (const item of items) {
    acc += item.weight;
    if (roll <= acc) return item;
  }
  return items[items.length - 1];
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

function ageBandFor(age) {
  if (age < 25) return '18-24';
  if (age < 30) return '25-29';
  if (age < 35) return '30-34';
  if (age < 40) return '35-39';
  if (age < 45) return '40-44';
  if (age < 50) return '45-49';
  return '50+';
}

/**
 * Build `count` employees. Uniqueness of the synthetic name is irrelevant to
 * privacy (we never expose names); person_id is what the differencing guard
 * tracks.
 */
export function generateEmployees(count = 4200, seed = 2601513) {
  const rng = mulberry32(seed);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const dept = pickWeighted(rng, DEPTS);
    const age = 21 + Math.floor(rng() * 38);
    const tenure = Math.min(30, Math.max(0, Math.round((rng() ** 1.7) * 22 * 10) / 10));
    const [lo, hi] = dept.salary;
    // Salary grows with age up to a point and with tenure, then jitters.
    const ageFactor = Math.min(1, (age - 21) / 30) * 0.55 + 0.45;
    const tenureFactor = Math.min(1, tenure / 15) * 0.25 + 0.75;
    const raw = lo + (hi - lo) * ageFactor * tenureFactor * (0.72 + rng() * 0.28);
    const salary = Math.round(Math.min(220_000, Math.max(30_000, raw)) / 100) * 100;
    rows.push({
      personId: `P${String(i + 1).padStart(5, '0')}`,
      name: `${pick(rng, LAST)}${pick(rng, FIRST)}`,
      region: pickWeighted(rng, REGIONS).region,
      dept: dept.dept,
      age,
      ageBand: ageBandFor(age),
      tenureYears: tenure,
      salary,
    });
  }
  return rows;
}

/**
 * A handful of deliberate "small worlds" so the UI and tests can show every
 * refusal path without hand-crafting SQL: a tiny overseas legal team, a
 * two-person intern cohort, etc.
 */
export const PINNED_COHORTS = Object.freeze([
  { region: '海外', dept: '法务', ageBand: '50+', size: 2, baseSalary: 150_000 },
  { region: '海外', dept: '法务', ageBand: '45-49', size: 3, baseSalary: 142_000 },
  { region: '东北', dept: '客服', ageBand: '18-24', size: 4, baseSalary: 52_000 },
  { region: '西部', dept: '产品', ageBand: '45-49', size: 7, baseSalary: 128_000 },
]);

export function generatePinnedEmployees(startIndex, seed = 77123) {
  const rng = mulberry32(seed);
  const out = [];
  let index = startIndex;
  for (const cohort of PINNED_COHORTS) {
    for (let i = 0; i < cohort.size; i += 1) {
      index += 1;
      out.push({
        personId: `P${String(index).padStart(5, '0')}`,
        name: `${pick(rng, LAST)}${pick(rng, FIRST)}`,
        region: cohort.region,
        dept: cohort.dept,
        age: cohort.ageBand === '50+' ? 52 + i : Number(cohort.ageBand.split('-')[0]) + (i % 5),
        ageBand: cohort.ageBand,
        tenureYears: Math.round(rng() * 20 * 10) / 10,
        salary: cohort.baseSalary + Math.round((rng() - 0.5) * 8000),
      });
    }
  }
  return out;
}
