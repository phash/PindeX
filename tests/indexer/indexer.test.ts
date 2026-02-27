import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { Indexer } from '../../src/indexer/index.js';
import { getAllFiles, getFileByPath, getSymbolsByFileId } from '../../src/db/queries.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

let testDir: string;

function createTempProject(): string {
  const dir = join(tmpdir(), `pindex-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });

  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `export function hello(name: string): string { return 'Hello ' + name; }`,
  );
  writeFileSync(
    join(dir, 'src', 'service.ts'),
    `import { hello } from './index';\nexport class MyService { greet() { return hello('world'); } }`,
  );
  // This should be ignored
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.ts'), 'export const x = 1;');

  return dir;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Indexer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    testDir = createTempProject();
  });

  it('indexes all TypeScript files in a project directory', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    const result = await indexer.indexAll();

    expect(result.indexed + result.updated).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    const files = getAllFiles(db);
    const filePaths = files.map((f) => f.path);
    expect(filePaths).toContain('src/index.ts');
    expect(filePaths).toContain('src/service.ts');
  });

  it('ignores node_modules directory', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    const files = getAllFiles(db);
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('skips unchanged files on second run (hash-based)', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    const result2 = await indexer.indexAll();
    // All files should be skipped (unchanged), so indexed should be 0
    expect(result2.indexed).toBe(0);
    expect(result2.updated).toBe(0);
  });

  it('re-indexes a file when its content changes', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    // Modify a file
    writeFileSync(
      join(testDir, 'src', 'index.ts'),
      `export function hello(name: string): string { return 'Hi ' + name; }\nexport function bye(): void {}`,
    );

    const result2 = await indexer.indexAll();
    expect(result2.updated).toBe(1);
  });

  it('stores a valid hash for each indexed file', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    const file = getFileByPath(db, 'src/index.ts');
    expect(file).not.toBeNull();
    expect(file!.hash).toMatch(/^[a-f0-9]{32}$/); // MD5 hex
  });

  it('stores a raw_token_estimate > 0 for non-empty files', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    const file = getFileByPath(db, 'src/index.ts');
    expect(file!.raw_token_estimate).toBeGreaterThan(0);
  });

  it('indexFile handles a non-existent file gracefully', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    const result = await indexer.indexFile('src/ghost.ts');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('indexAll returns errors array for problematic files', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    // Override to inject an error path
    const result = await indexer.indexAll({ additionalPaths: ['nonexistent/ghost.ts'] });
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
