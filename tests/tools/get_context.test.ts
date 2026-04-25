import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile } from '../helpers/fixtures.js';
import { getContext } from '../../src/tools/get_context.js';
import { RepoSet } from '../../src/federation/repo-set.js';

function singleRepoWithPath(db: Database.Database, path: string): RepoSet {
  return RepoSet.fromServerConfig(db, 'local', [], path);
}

describe('getContext', () => {
  let db: Database.Database;
  let testDir: string;

  const fileContent = [
    'line 1',
    'line 2',
    'line 3',
    'line 4',
    'line 5',
    'line 6',
    'line 7',
    'line 8',
    'line 9',
    'line 10',
  ].join('\n');

  beforeEach(() => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-ctx-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'file.ts'), fileContent);
    insertTestFile(db, { path: 'src/file.ts', language: 'typescript' });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns code around the requested line', async () => {
    const results = await getContext(singleRepoWithPath(db, testDir), { file: 'src/file.ts', line: 5, range: 2 });
    expect(results).toHaveLength(1);
    expect(results[0]?.code).toContain('line 5');
  });

  it('returns the language from the file record', async () => {
    const results = await getContext(singleRepoWithPath(db, testDir), { file: 'src/file.ts', line: 1 });
    expect(results[0]?.language).toBe('typescript');
  });

  it('respects the range parameter', async () => {
    const results = await getContext(singleRepoWithPath(db, testDir), { file: 'src/file.ts', line: 5, range: 1 });
    const lines = results[0]?.code.split('\n') ?? [];
    // range 1 means 1 line before + target + 1 line after = 3 lines max
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('uses default range of 30 when not specified', async () => {
    const results = await getContext(singleRepoWithPath(db, testDir), { file: 'src/file.ts', line: 5 });
    expect(results[0]?.code).toBeTruthy();
  });

  it('returns empty array when file not found in db', async () => {
    const results = await getContext(singleRepoWithPath(db, testDir), { file: 'nonexistent.ts', line: 1 });
    expect(results).toEqual([]);
  });

  it('refuses path-traversal attempts that escape projectRoot', async () => {
    // Create a "secret" file outside the project root and an indexed DB entry
    // pointing at a traversal string. Even though the DB record exists, the
    // resolved path must fall OUTSIDE the root and be rejected.
    const outsideDir = join(tmpdir(), `pindex-ctx-outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.txt'), 'top secret data');
    insertTestFile(db, { path: '../secret.txt', language: 'typescript' });
    try {
      const results = await getContext(singleRepoWithPath(db, testDir), { file: '../secret.txt', line: 1 });
      expect(results).toEqual([]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses absolute paths pointing outside projectRoot', async () => {
    insertTestFile(db, { path: '/etc/passwd', language: 'typescript' });
    const results = await getContext(singleRepoWithPath(db, testDir), { file: '/etc/passwd', line: 1 });
    expect(results).toEqual([]);
  });

  it('clamps to first line when requesting line 0 or negative', async () => {
    const results = await getContext(singleRepoWithPath(db, testDir), { file: 'src/file.ts', line: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.startLine).toBeGreaterThanOrEqual(1);
  });

  it('returns startLine and endLine', async () => {
    const results = await getContext(singleRepoWithPath(db, testDir), { file: 'src/file.ts', line: 5, range: 2 });
    expect(typeof results[0]?.startLine).toBe('number');
    expect(typeof results[0]?.endLine).toBe('number');
    expect(results[0]!.endLine).toBeGreaterThanOrEqual(results[0]!.startLine);
  });
});

describe('getContext — federation', () => {
  it('returns code snippets from each repo where the file exists', async () => {
    const primaryDir = join(tmpdir(), `pindex-ctx-fed-p-${Date.now()}`);
    const federatedDir = join(tmpdir(), `pindex-ctx-fed-f-${Date.now()}`);
    mkdirSync(join(primaryDir, 'src'), { recursive: true });
    mkdirSync(join(federatedDir, 'src'), { recursive: true });
    writeFileSync(join(primaryDir, 'src', 'a.ts'), 'primary line 1\nprimary line 2\n');
    writeFileSync(join(federatedDir, 'src', 'a.ts'), 'federated line 1\nfederated line 2\n');

    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    insertTestFile(primaryDb, { path: 'src/a.ts', language: 'typescript' });
    insertTestFile(federatedDb, { path: 'src/a.ts', language: 'typescript' });

    const repoSet = RepoSet.fromServerConfig(
      primaryDb,
      'main',
      [{ name: 'remote', path: federatedDir, db: federatedDb }],
      primaryDir,
    );

    try {
      const results = await getContext(repoSet, { file: 'src/a.ts', line: 1, range: 1 });
      expect(results).toHaveLength(2);
      const byProject = new Map(results.map((r) => [r.project, r.code]));
      expect(byProject.get('main')).toContain('primary');
      expect(byProject.get('remote')).toContain('federated');
    } finally {
      rmSync(primaryDir, { recursive: true, force: true });
      rmSync(federatedDir, { recursive: true, force: true });
    }
  });
});
