/**
 * Test helpers: an in-memory store seeded with deterministic data, plus HTTP
 * server bootstrapping on an ephemeral port.
 */

import { createServer } from '../src/http.js';
import { Store } from '../src/store.js';
import { PrivacyEngine } from '../src/privacy.js';
import { seedIfEmpty } from '../src/bootstrap.js';

/** A deterministic "random" source so noise is reproducible in assertions. */
export function fixedRng(value = 0.5) {
  return () => value;
}

export function makeEngine({ rng = fixedRng(0.5), now } = {}) {
  const store = new Store(':memory:');
  seedIfEmpty(store);
  const engine = new PrivacyEngine(store, {
    rng,
    ...(now ? { now } : {}),
  });
  return { store, engine };
}

export async function startServer(options = {}) {
  const { server, store, engine } = createServer({ dbPath: ':memory:', ...options });
  seedIfEmpty(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    store,
    engine,
    server,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
    async request(path, { method = 'GET', caller, admin = false, body } = {}) {
      const headers = {};
      if (caller) headers['x-caller-id'] = caller;
      if (admin) headers['x-admin'] = '1';
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
      };
    },
  };
}
