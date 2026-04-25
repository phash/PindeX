import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestDependency } from '../helpers/fixtures.js';
import { getDependencies } from '../../src/tools/get_dependencies.js';
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

describe('getDependencies', () => {
  let db: Database.Database;
  let fileA: number; // src/app.ts
  let fileB: number; // src/service.ts
  let fileC: number; // src/utils.ts

  beforeEach(() => {
    db = createTestDb();
    fileA = insertTestFile(db, { path: 'src/app.ts' });
    fileB = insertTestFile(db, { path: 'src/service.ts' });
    fileC = insertTestFile(db, { path: 'src/utils.ts' });
    // app.ts → service.ts → utils.ts
    insertTestDependency(db, fileA, fileB, 'MyService');
    insertTestDependency(db, fileB, fileC, 'helper');
  });

  it('returns files that a target imports (direction=imports)', () => {
    const results = getDependencies(makeTestRepoSet(db), { target: 'src/app.ts', direction: 'imports' });
    expect(results[0]?.imports).toContain('src/service.ts');
    expect(results[0]?.importedBy).toHaveLength(0);
  });

  it('returns files that import the target (direction=imported_by)', () => {
    const results = getDependencies(makeTestRepoSet(db), { target: 'src/service.ts', direction: 'imported_by' });
    expect(results[0]?.importedBy).toContain('src/app.ts');
    expect(results[0]?.imports).toHaveLength(0);
  });

  it('returns both directions when direction=both', () => {
    const results = getDependencies(makeTestRepoSet(db), { target: 'src/service.ts', direction: 'both' });
    expect(results[0]?.imports).toContain('src/utils.ts');
    expect(results[0]?.importedBy).toContain('src/app.ts');
  });

  it('defaults to both direction when not specified', () => {
    const results = getDependencies(makeTestRepoSet(db), { target: 'src/service.ts' });
    expect(results[0]?.imports).toContain('src/utils.ts');
    expect(results[0]?.importedBy).toContain('src/app.ts');
  });

  it('returns empty arrays for an unknown target', () => {
    const results = getDependencies(makeTestRepoSet(db), { target: 'src/ghost.ts' });
    expect(results).toEqual([]);
  });
});

describe('getDependencies — federation', () => {
  it('returns one entry per repo where the file exists', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    const pf = insertTestFile(primaryDb, { path: 'src/x.ts' });
    const ff = insertTestFile(federatedDb, { path: 'src/x.ts' });
    const pTarget = insertTestFile(primaryDb, { path: 'src/y.ts' });
    const fTarget = insertTestFile(federatedDb, { path: 'src/y.ts' });
    insertTestDependency(primaryDb, pf, pTarget, 'helperA');
    insertTestDependency(federatedDb, ff, fTarget, 'helperB');

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = getDependencies(repoSet, { target: 'src/x.ts', direction: 'imports' });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.project).sort()).toEqual(['auth', 'main']);
  });

  it('scopes by repos param', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    insertTestFile(primaryDb, { path: 'src/x.ts' });
    insertTestFile(federatedDb, { path: 'src/x.ts' });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = getDependencies(repoSet, { target: 'src/x.ts', direction: 'imports', repos: ['main'] });
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe('main');
  });
});
