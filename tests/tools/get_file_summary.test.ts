import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol, insertTestDependency } from '../helpers/fixtures.js';
import { getFileSummary } from '../../src/tools/get_file_summary.js';
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

describe('getFileSummary', () => {
  let db: Database.Database;
  let fileId: number;

  beforeEach(() => {
    db = createTestDb();
    fileId = insertTestFile(db, { path: 'src/service.ts', language: 'typescript', summary: 'Auth service module' });
    insertTestSymbol(db, { fileId, name: 'AuthService', kind: 'class', signature: 'class AuthService', isExported: true });
    insertTestSymbol(db, { fileId, name: 'login', kind: 'method', signature: 'login(email: string): Promise<Token>' });
    insertTestSymbol(db, { fileId, name: 'privateHelper', kind: 'function', signature: 'privateHelper(): void', isExported: false });
  });

  it('returns file metadata', () => {
    const results = getFileSummary(makeTestRepoSet(db), { file: 'src/service.ts' });
    expect(results).toHaveLength(1);
    expect(results[0]?.language).toBe('typescript');
    expect(results[0]?.summary).toBe('Auth service module');
  });

  it('returns all symbols for the file', () => {
    const results = getFileSummary(makeTestRepoSet(db), { file: 'src/service.ts' });
    expect(results[0]?.symbols).toHaveLength(3);
    expect(results[0]?.symbols.map((s) => s.name)).toContain('AuthService');
  });

  it('returns exports (symbols with isExported=true)', () => {
    const results = getFileSummary(makeTestRepoSet(db), { file: 'src/service.ts' });
    expect(results[0]?.exports).toContain('AuthService');
    expect(results[0]?.exports).not.toContain('privateHelper');
  });

  it('returns imports from dependencies', () => {
    const depFile = insertTestFile(db, { path: 'src/utils.ts' });
    insertTestDependency(db, fileId, depFile, 'Helper');
    const results = getFileSummary(makeTestRepoSet(db), { file: 'src/service.ts' });
    expect(results[0]?.imports).toContain('src/utils.ts');
  });

  it('returns empty array for a non-existent file', () => {
    const results = getFileSummary(makeTestRepoSet(db), { file: 'src/ghost.ts' });
    expect(results).toEqual([]);
  });

  it('returns empty symbols array when file has no symbols', () => {
    insertTestFile(db, { path: 'src/empty.ts' });
    const results = getFileSummary(makeTestRepoSet(db), { file: 'src/empty.ts' });
    expect(results[0]?.symbols).toHaveLength(0);
  });
});

describe('getFileSummary — federation', () => {
  it('returns matching files from each repo, tagged with project', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    insertTestFile(primaryDb, { path: 'src/auth.ts' });
    insertTestFile(federatedDb, { path: 'src/auth.ts' });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'remote' }],
    );

    const results = getFileSummary(repoSet, { file: 'src/auth.ts' });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.project).sort()).toEqual(['main', 'remote']);
  });

  it('scopes by repos param', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    insertTestFile(primaryDb, { path: 'src/x.ts' });
    insertTestFile(federatedDb, { path: 'src/x.ts' });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'remote' }],
    );

    const results = getFileSummary(repoSet, { file: 'src/x.ts', repos: ['remote'] });
    expect(results.map((r) => r.project)).toEqual(['remote']);
  });
});
