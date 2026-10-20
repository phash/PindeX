import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol, insertTestDependency, insertTestRef } from '../helpers/fixtures.js';
import { findUsages } from '../../src/tools/find_usages.js';
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';
import type { UsageResult } from '../../src/types.js';

/** Narrows a findUsages result to the usage list (fails on an ambiguity payload). */
function usageList(result: ReturnType<typeof findUsages>): UsageResult[] {
  if (!Array.isArray(result)) throw new Error(`expected usages, got ${JSON.stringify(result)}`);
  return result;
}

describe('findUsages', () => {
  let db: Database.Database;
  let symbolId: number;

  beforeEach(() => {
    db = createTestDb();
    const hostFileId = insertTestFile(db, { path: 'src/auth.ts' });
    symbolId = insertTestSymbol(db, {
      fileId: hostFileId,
      name: 'validateToken',
      kind: 'function',
      signature: 'validateToken(token: string): boolean',
    });

    const callerA = insertTestFile(db, { path: 'src/middleware.ts' });
    const callerB = insertTestFile(db, { path: 'src/routes.ts' });
    const handler = insertTestSymbol(db, { fileId: callerA, name: 'authMiddleware', startLine: 10, endLine: 20 });
    insertTestDependency(db, callerA, hostFileId, 'validateToken');
    insertTestDependency(db, callerB, hostFileId, 'validateToken');
    insertTestRef(db, callerA, 'validateToken', 15, { callerSymbolId: handler });
    insertTestRef(db, callerB, 'validateToken', 42);
    void symbolId;
  });

  it('does not repeat file:line in a context field', () => {
    const result = usageList(findUsages(makeTestRepoSet(db), { symbol: 'validateToken' }));
    expect(result.every((u) => !('context' in u))).toBe(true);
  });

  it('returns all usages of a symbol', () => {
    const result = usageList(findUsages(makeTestRepoSet(db), { symbol: 'validateToken' }));
    expect(result).toHaveLength(2);
  });

  it('returns file path for each usage', () => {
    const result = usageList(findUsages(makeTestRepoSet(db), { symbol: 'validateToken' }));
    const files = result.map((u) => u.file);
    expect(files).toContain('src/middleware.ts');
    expect(files).toContain('src/routes.ts');
  });

  it('returns line number for each usage', () => {
    const result = usageList(findUsages(makeTestRepoSet(db), { symbol: 'validateToken' }));
    const lines = result.map((u) => u.line);
    expect(lines).toContain(15);
    expect(lines).toContain(42);
  });

  it('tags usages with caller and confidence, omitting project for a single repo', () => {
    const result = usageList(findUsages(makeTestRepoSet(db), { symbol: 'validateToken' }));
    expect(result).toEqual([
      { file: 'src/middleware.ts', line: 15, caller: 'authMiddleware', confidence: 'EXTRACTED' },
      { file: 'src/routes.ts', line: 42, caller: null, confidence: 'EXTRACTED' },
    ]);
  });

  it('returns empty array for unknown symbol', () => {
    const result = findUsages(makeTestRepoSet(db), { symbol: 'unknownXYZ' });
    expect(result).toHaveLength(0);
  });

  it('returns empty array for symbol with no usages', () => {
    const fileId = insertTestFile(db, { path: 'src/unused.ts' });
    insertTestSymbol(db, { fileId, name: 'unusedFunc', kind: 'function', signature: 'unusedFunc(): void' });
    const result = findUsages(makeTestRepoSet(db), { symbol: 'unusedFunc' });
    expect(result).toHaveLength(0);
  });
});

describe('findUsages — federation', () => {
  it('returns usages tagged with their repo of origin', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    const pf = insertTestFile(primaryDb, { path: 'src/local.ts' });
    const ff = insertTestFile(federatedDb, { path: 'src/remote.ts' });
    const ps = insertTestSymbol(primaryDb, { fileId: pf, name: 'parseToken' });
    const fs = insertTestSymbol(federatedDb, { fileId: ff, name: 'parseToken' });
    insertTestRef(primaryDb, pf, 'parseToken', 5, { callerSymbolId: ps });
    insertTestRef(federatedDb, ff, 'parseToken', 8, { callerSymbolId: fs });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = usageList(findUsages(repoSet, { symbol: 'parseToken' }));
    const projects = results.map((r) => r.project).sort();
    expect(projects).toEqual(['auth', 'main']);
  });

  it('scopes by repos param', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    const pf = insertTestFile(primaryDb, { path: 'src/x.ts' });
    const ff = insertTestFile(federatedDb, { path: 'src/y.ts' });
    insertTestSymbol(primaryDb, { fileId: pf, name: 'foo' });
    insertTestSymbol(federatedDb, { fileId: ff, name: 'foo' });
    insertTestRef(primaryDb, pf, 'foo', 2);
    insertTestRef(federatedDb, ff, 'foo', 3);

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = findUsages(repoSet, { symbol: 'foo', repos: ['auth'] });
    expect(results).toEqual([{ file: 'src/y.ts', line: 3, caller: null, confidence: 'EXTRACTED', project: 'auth' }]);
  });
});

describe('findUsages — disambiguation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const a = insertTestFile(db, { path: 'src/a.ts' });
    const b = insertTestFile(db, { path: 'src/b.ts', hash: 'b' });
    const c = insertTestFile(db, { path: 'src/c.ts', hash: 'c' });
    const d = insertTestFile(db, { path: 'src/d.ts', hash: 'd' });
    insertTestSymbol(db, { fileId: a, name: 'format', kind: 'function', startLine: 2, isExported: true });
    insertTestSymbol(db, { fileId: b, name: 'format', kind: 'method', startLine: 7, isExported: true });
    insertTestDependency(db, c, a, 'format');
    insertTestDependency(db, d, b, 'format');
    insertTestRef(db, c, 'format', 11);
    insertTestRef(db, d, 'format', 21);
  });

  it('returns candidates as data when the name is defined more than once', () => {
    const result = findUsages(makeTestRepoSet(db), { symbol: 'format' });
    expect(result).toEqual({
      error: 'ambiguous',
      candidates: [
        { file: 'src/a.ts', line: 2, kind: 'function' },
        { file: 'src/b.ts', line: 7, kind: 'method' },
      ],
    });
  });

  it('file picks one definition and returns only its call sites', () => {
    const result = findUsages(makeTestRepoSet(db), { symbol: 'format', file: 'src/a.ts' });
    expect(result).toEqual([{ file: 'src/c.ts', line: 11, caller: null, confidence: 'EXTRACTED' }]);
  });

  it('file is normalized (./ prefix, backslashes)', () => {
    const result = findUsages(makeTestRepoSet(db), { symbol: 'format', file: '.\\src\\b.ts' });
    expect(result).toEqual([{ file: 'src/d.ts', line: 21, caller: null, confidence: 'EXTRACTED' }]);
  });

  it('absolute file inside the repo root is relativized', () => {
    // primary path is '' in test sets; use a federated repo with a real root instead
    const fed = makeFederatedTestRepoSet({ db: createTestDb(), name: 'other' }, [{ db, name: 'main', path: '/proj' }]);
    const result = findUsages(fed, { symbol: 'format', file: '/proj/src/a.ts', repos: ['main'] });
    expect(result).toEqual([{ file: 'src/c.ts', line: 11, caller: null, confidence: 'EXTRACTED', project: 'main' }]);
  });

  it('absolute file outside the repo root is rejected', () => {
    const fed = makeFederatedTestRepoSet({ db: createTestDb(), name: 'other' }, [{ db, name: 'main', path: '/proj' }]);
    expect(findUsages(fed, { symbol: 'format', file: '/elsewhere/src/a.ts', repos: ['main'] })).toEqual([]);
  });

  it('file that defines no such symbol yields no usages', () => {
    expect(findUsages(makeTestRepoSet(db), { symbol: 'format', file: 'src/c.ts' })).toEqual([]);
  });
});

describe('findUsages — high-volume names', () => {
  it('does not lose target call sites behind many refs to a same-named decoy', () => {
    const db = createTestDb();
    const decoy = insertTestFile(db, { path: 'src/aaa/decoy.ts' });
    const target = insertTestFile(db, { path: 'src/zzz/target.ts', hash: 't' });
    const caller = insertTestFile(db, { path: 'src/zzz/caller.ts', hash: 'c' });
    insertTestSymbol(db, { fileId: decoy, name: 'run' });
    insertTestSymbol(db, { fileId: target, name: 'run' });
    for (let i = 0; i < 600; i++) insertTestRef(db, decoy, 'run', i + 1);
    insertTestDependency(db, caller, target, 'run');
    for (const line of [10, 20, 30]) insertTestRef(db, caller, 'run', line);

    const result = usageList(findUsages(makeTestRepoSet(db), { symbol: 'run', file: 'src/zzz/target.ts' }));
    expect(result.map((u) => u.line)).toEqual([10, 20, 30]);
  });

  it('caps output at 500 usages', () => {
    const db = createTestDb();
    const f = insertTestFile(db, { path: 'src/a.ts' });
    insertTestSymbol(db, { fileId: f, name: 'run' });
    for (let i = 0; i < 520; i++) insertTestRef(db, f, 'run', i + 1);
    expect(usageList(findUsages(makeTestRepoSet(db), { symbol: 'run' }))).toHaveLength(500);
  });
});
