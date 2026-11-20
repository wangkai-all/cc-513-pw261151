#!/usr/bin/env node
/**
 * Entry point.
 *
 *   DB_PATH=data/privacy.sqlite PORT=5173 npm start
 *
 * A fresh database is seeded automatically on first start.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer } from './http.js';
import { seedIfEmpty } from './bootstrap.js';

const PORT = Number.parseInt(process.env.PORT ?? '5173', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve('data/privacy.sqlite');

const existed = existsSync(DB_PATH);
const { server, store } = createServer({ dbPath: DB_PATH });
const seeded = seedIfEmpty(store);
if (seeded) {
  console.log(`[privacy-service] ${existed ? 'seeded empty' : 'created'} database at ${DB_PATH}`);
}

server.listen(PORT, HOST, () => {
  console.log(`[privacy-service] listening on http://${HOST}:${PORT}`);
  console.log(`[privacy-service] db: ${DB_PATH}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
