// scripts/bench-index.mjs
// Usage:
//   node scripts/bench-index.mjs                         # auto workers
//   PINDEX_PARSE_WORKERS=0 node scripts/bench-index.mjs  # sync baseline
//   BENCH_FILES=500 node scripts/bench-index.mjs         # override file count
//
// Generates FILES synthetic TS files in a temp dir, indexes once, prints the
// wall-time for indexAll() + resolveDependencies(). Uses the built dist/, so
// run `npm run build` first (npm run bench:index does this automatically).

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Indexer } from '../dist/indexer/index.js';
import { runMigrations } from '../dist/db/migrations.js';

const FILES = parseInt(process.env.BENCH_FILES ?? '1000', 10);

function generateProject(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let i = 0; i < FILES; i++) {
    const body = Array.from({ length: 8 }, (_, k) =>
      `export function f${i}_${k}(x: number): number { return x + ${k}; }`,
    ).join('\n');
    writeFileSync(join(dir, 'src', `m${i}.ts`), body);
  }
}

async function main() {
  const dir = join(tmpdir(), `pindex-bench-${Date.now()}`);
  generateProject(dir);

  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);

  const indexer = new Indexer({ db, projectRoot: dir });

  const t0 = Date.now();
  const result = await indexer.indexAll();
  const t1 = Date.now();
  await indexer.resolveDependencies();
  const t2 = Date.now();

  await indexer.closePool();
  db.close();
  rmSync(dir, { recursive: true, force: true });

  const workers = process.env.PINDEX_PARSE_WORKERS ?? 'auto';
  console.log(`files=${FILES} workers=${workers}`);
  console.log(`indexAll               : ${t1 - t0} ms`);
  console.log(`resolveDependencies    : ${t2 - t1} ms`);
  console.log(`total                  : ${t2 - t0} ms`);
  console.log(`indexed=${result.indexed} updated=${result.updated} skipped=${result.skipped} errors=${result.errors.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
