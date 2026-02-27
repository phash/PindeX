import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { reindex } from '../../src/tools/reindex.js';
import { Indexer } from '../../src/indexer/index.js';
import { getAllFiles } from '../../src/db/queries.js';

describe('reindex', () => {
  let db: Database.Database;
  let testDir: string;
  let indexer: Indexer;

  beforeEach(() => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-reindex-test-${Date.now()}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'app.ts'), 'export function run() {}');
    indexer = new Indexer({ db, projectRoot: testDir });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('indexes all files when no target specified', async () => {
    const result = await reindex(db, indexer, {});
    expect(result.indexed + result.updated).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it('re-indexes a specific file when target provided', async () => {
    await reindex(db, indexer, {});
    // Modify the file
    writeFileSync(join(testDir, 'src', 'app.ts'), 'export function run() {}\nexport function stop() {}');
    const result = await reindex(db, indexer, { target: 'src/app.ts' });
    expect(result.errors).toHaveLength(0);
  });

  it('returns errors for non-existent target', async () => {
    const result = await reindex(db, indexer, { target: 'src/ghost.ts' });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns zero indexed when nothing changed', async () => {
    await reindex(db, indexer, {});
    const result2 = await reindex(db, indexer, {});
    expect(result2.indexed).toBe(0);
  });
});
