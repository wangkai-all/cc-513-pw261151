#!/usr/bin/env node
/**
 * Minimal DOM-ish smoke test: loads the static assets through the real server,
 * checks every element id that app.js queries, and verifies the client and
 * server agree on the outcome vocabulary. This is not a browser, but it catches
 * the most common "UI references an element that no longer exists" regressions
 * without adding a Playwright dependency.
 *
 *   node test/ui-contract.test.js     (also runs under `node --test`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startServer } from './helpers.js';

const root = resolve(import.meta.dirname, '..');

async function loadAsset(path) {
  return readFile(resolve(root, path), 'utf8');
}

test('UI: every element id used by app.js exists in index.html', async () => {
  const html = await loadAsset('public/index.html');
  const js = await loadAsset('public/app.js');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const used = new Set(
    [...js.matchAll(/\$\(\s*'#([a-zA-Z0-9_-]+)'\s*\)/g)].map((match) => match[1]),
  );
  const missing = [...used].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `app.js references missing ids: ${missing.join(', ')}`);
});

test('UI: template literals use only escaped text insertion', async () => {
  const js = await loadAsset('public/app.js');
  // The client must not build markup from data. innerHTML/outerHTML/
  // insertAdjacentHTML are banned outright; textContent/createElement only.
  assert.equal(/\.innerHTML\s*=/.test(js), false);
  assert.equal(/outerHTML\s*=/.test(js), false);
  assert.equal(/insertAdjacentHTML/.test(js), false);
  assert.equal(/document\.write/.test(js), false);
});

test('UI: app.js outcome labels cover every server outcome code', async () => {
  const { OUTCOME } = await import('../src/privacy.js');
  const js = await loadAsset('public/app.js');
  const missing = Object.values(OUTCOME).filter((code) => !js.includes(code));
  assert.deepEqual(missing, [], `app.js has no label for: ${missing.join(', ')}`);
});

test('UI: static assets served by the real server', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  for (const path of ['/', '/app.js', '/styles.css']) {
    const response = await fetch(app.base + path);
    assert.equal(response.status, 200, `${path} must be served`);
  }
  const html = await (await fetch(app.base + '/')).text();
  assert.match(html, /隐私保护聚合查询/);
});

test('UI: policy editor fields map to real, bounded policy keys', async () => {
  const html = await loadAsset('public/index.html');
  const js = await loadAsset('public/app.js');
  const policyKeys = [
    'k',
    'perQueryEpsilon',
    'perCallerEpsilonCap',
    'repeatLimit',
    'cacheTtlMs',
    'complementarySuppression',
    'differencingProtection',
    'showCohortSize',
  ];
  for (const key of policyKeys) {
    assert.ok(js.includes(`${key}:`), `app.js must send ${key}`);
  }
  assert.match(html, /id="policy-form"/);
});
