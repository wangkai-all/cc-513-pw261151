#!/usr/bin/env node
/**
 * End-to-end demonstration of the privacy guarantees, printed as a readable
 * report. Useful as a smoke test and as living documentation for reviewers.
 *
 *   node scripts/demo.js              # start an ephemeral server + temp database
 *   node scripts/demo.js <baseUrl>    # run against an already-running instance
 *
 * Exercises, in order:
 *   1. a release and its audit record
 *   2. a free cache hit
 *   3. a below-threshold refusal
 *   4. a split-by-group refusal (complementary suppression)
 *   5. revocation, including refusal of an already-cached answer
 *   6. concurrent requests against a nearly exhausted budget
 *   7. audit chain verification and ledger totals
 */

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/http.js';
import { seedIfEmpty } from '../src/bootstrap.js';

const external = process.argv[2] ?? null;
const CALLER = 'analyst-hr';

async function api(base, path, { method = 'GET', body, admin = false, caller = CALLER } = {}) {
  const headers = { 'x-caller-id': caller };
  if (admin) headers['x-admin'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.error?.message ?? response.status}`);
  return data;
}

function line(label, result) {
  const status = result.allowed ? result.privacy.status : result.privacy.reasonCode;
  const epsilon = result.privacy.budgetCharged ?? 0;
  console.log(
    `  ${label.padEnd(30)} ${String(status).padEnd(32)} 计费 ε=${epsilon}  剩余 ε=${result.budget?.remaining ?? '—'}`,
  );
}

const query = (filters, extra = {}) => ({
  method: 'POST',
  body: { query: { metric: 'count', filters, ...extra } },
});

async function run(base) {
  console.log(`\n隐私保护聚合查询 · 演示 (${base})\n${'─'.repeat(76)}`);

  const before = await api(base, '/api/me');
  const initialCap = before.budget.cap;

  try {
    // Start from an empty cache so the first query below is a genuine release
    // even when running against a long-lived server.
    await api(base, '/api/admin/cache/purge', { method: 'POST', admin: true });

    console.log('\n1. 首次发布');
    const requestId = `demo-${Date.now()}-1`;
    const first = await api(base, '/api/query', {
      method: 'POST',
      body: {
        query: { metric: 'count', filters: { region: '华东' }, requestId },
        note: 'demo release',
      },
    });
    line('count · 华东', first);
    console.log(
      `     值: ${first.data.cells[0].value} ${first.data.cells[0].unit} · 审计 #${first.audit.seq}`,
    );

    console.log('\n2. 相同查询（缓存）');
    line('count · 华东（重复）', await api(base, '/api/query', query({ region: '华东' })));

    console.log('\n3. 低于阈值的小群体');
    line(
      'count · 海外/法务/50+',
      await api(
        base,
        '/api/query',
        query({ region: '海外', dept: '法务', ageBand: '50+' }),
      ),
    );

    console.log('\n4. 按分组拆分（互补抑制）');
    line(
      'count · 海外/法务 按年龄段',
      await api(
        base,
        '/api/query',
        query({ region: '海外', dept: '法务' }, { groupBy: 'ageBand' }),
      ),
    );

    console.log('\n5. 权限撤销（缓存仍然有效，但必须先通过权限检查）');
    await api(base, `/api/admin/callers/${CALLER}/revoke`, { method: 'POST', admin: true });
    line('撤销后查询（缓存已存在）', await api(base, '/api/query', query({ region: '华东' })));
    await api(base, `/api/admin/callers/${CALLER}/restore`, { method: 'POST', admin: true });
    line('恢复后查询（命中缓存）', await api(base, '/api/query', query({ region: '华东' })));

    console.log('\n6. 并发查询与预算');
    const me = await api(base, '/api/me');
    const tightCap = Math.min(100, Math.round((me.budget.spent + 1.5) * 1000) / 1000);
    await api(base, '/api/admin/policy', {
      method: 'POST',
      admin: true,
      body: { perCallerEpsilonCap: tightCap },
    });
    await api(base, '/api/admin/cache/purge', { method: 'POST', admin: true });
    console.log(
      `     上限收紧到 ε=${tightCap}（已用 ε=${me.budget.spent}），4 个请求同时到达：`,
    );
    const regions = ['华南', '华北', '西部', '东北'];
    const results = await Promise.all(
      regions.map((region) => api(base, '/api/query', query({ region }))),
    );
    results.forEach((result, index) => line(`并发 count · ${regions[index]}`, result));
    const after = await api(base, '/api/me');
    console.log(`     预算台账：已用 ${after.budget.spent} / ${after.budget.cap} ε`);
    // Hand the borrowed headroom back before the next step.
    await api(base, '/api/admin/policy', {
      method: 'POST',
      admin: true,
      body: { perCallerEpsilonCap: initialCap },
    });

    console.log('\n7. 审计链');
    const chain = await api(base, '/api/admin/audit/verify', { admin: true });
    console.log(
      chain.ok
        ? `  ✓ 审计链完整（${chain.checked} 条，链头 ${chain.head.slice(0, 16)}…）`
        : `  ✗ 审计链在第 ${chain.brokenAt} 条被破坏`,
    );
    const ledger = await api(base, `/api/admin/ledger?caller=${CALLER}&limit=1000`, {
      admin: true,
    });
    const total = ledger.entries.reduce((sum, entry) => sum + entry.epsilon, 0);
    const released = ledger.entries.filter((entry) => entry.epsilon > 0).length;
    console.log(
      `  台账 ${ledger.entries.length} 条（计费 ${released} 条），合计 ε=${Math.round(total * 1000) / 1000}`,
    );
    console.log();
  } finally {
    // Restore the caller-visible policy cap the demo borrowed for step 5.
    await api(base, '/api/admin/policy', {
      method: 'POST',
      admin: true,
      body: { perCallerEpsilonCap: initialCap },
    }).catch(() => {});
  }
}

async function main() {
  if (external) {
    await run(external);
    return;
  }
  const dbPath = join(tmpdir(), `privacy-demo-${process.pid}-${Date.now()}.sqlite`);
  const app = createServer({ dbPath });
  seedIfEmpty(app.store, { force: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await run(base);
    console.log('以上运行在临时数据库上，未影响 data/ 下的开发数据。');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
    await Promise.all(
      ['', '-wal', '-shm'].map((suffix) => rm(dbPath + suffix, { force: true })),
    );
  }
}

main().catch((error) => {
  console.error('演示失败：', error.message);
  if (external) console.error('目标实例需已运行 `npm start`。');
  process.exitCode = 1;
});
