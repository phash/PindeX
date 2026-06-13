import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol, insertTestDependency } from '../helpers/fixtures.js';
import { insertObservation } from '../../src/db/queries.js';
import { getSymbol } from '../../src/tools/get_symbol.js';
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

describe('getSymbol', () => {
  let db: Database.Database;
  let fileId: number;

  beforeEach(() => {
    db = createTestDb();
    fileId = insertTestFile(db, { path: 'src/auth.ts' });
    insertTestSymbol(db, {
      fileId,
      name: 'AuthService',
      kind: 'class',
      signature: 'class AuthService',
      startLine: 5,
      endLine: 50,
      isExported: true,
    });
  });

  it('returns symbol details by name', () => {
    const results = getSymbol(makeTestRepoSet(db), { name: 'AuthService' });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('AuthService');
    expect(results[0].kind).toBe('class');
    expect(results[0].file).toBe('src/auth.ts');
    expect(results[0].startLine).toBe(5);
    expect(results[0].endLine).toBe(50);
    expect(results[0].isExported).toBe(true);
  });

  it('returns empty array when symbol is not found', () => {
    const results = getSymbol(makeTestRepoSet(db), { name: 'NonExistent' });
    expect(results).toEqual([]);
  });

  it('filters by file when specified', () => {
    const otherFileId = insertTestFile(db, { path: 'src/other.ts' });
    insertTestSymbol(db, { fileId: otherFileId, name: 'AuthService', kind: 'class', signature: 'class AuthService' });

    const results = getSymbol(makeTestRepoSet(db), { name: 'AuthService', file: 'src/auth.ts' });
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('src/auth.ts');
  });

  it('includes dependencies array', () => {
    const depFileId = insertTestFile(db, { path: 'src/utils.ts' });
    insertTestDependency(db, fileId, depFileId, 'Helper');

    const results = getSymbol(makeTestRepoSet(db), { name: 'AuthService' });
    expect(Array.isArray(results[0].dependencies)).toBe(true);
  });

  it('returns signature', () => {
    const results = getSymbol(makeTestRepoSet(db), { name: 'AuthService' });
    expect(results[0].signature).toBe('class AuthService');
  });
});

describe('getSymbol — federation', () => {
  it('returns one entry per repo when the same name exists in multiple repos', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    insertTestSymbol(primaryDb, {
      fileId: insertTestFile(primaryDb, { path: 'src/auth.ts' }),
      name: 'AuthService',
    });
    insertTestSymbol(federatedDb, {
      fileId: insertTestFile(federatedDb, { path: 'src/auth.ts' }),
      name: 'AuthService',
    });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = getSymbol(repoSet, { name: 'AuthService' });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.project).sort()).toEqual(['auth', 'main']);
  });

  it('returns an empty array when the symbol is in no repo', () => {
    const repoSet = makeTestRepoSet(createTestDb(), 'main');
    expect(getSymbol(repoSet, { name: 'Nope' })).toEqual([]);
  });
});

describe('getSymbol — memory_context', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const fileId = insertTestFile(db, { path: 'src/auth.ts' });
    insertTestSymbol(db, {
      fileId,
      name: 'AuthService',
      kind: 'class',
      signature: 'class AuthService',
      isExported: true,
    });
  });

  it('omits memory_context when there are no observations for the symbol', () => {
    const results = getSymbol(makeTestRepoSet(db), { name: 'AuthService' });
    expect(results[0].memory_context).toBeUndefined();
  });

  it('attaches memory_context with non-stale observations', () => {
    insertObservation(db, {
      sessionId: 'sess-1',
      type: 'accessed',
      filePath: 'src/auth.ts',
      symbolName: 'AuthService',
      observation: 'AuthService was inspected',
    });

    const results = getSymbol(makeTestRepoSet(db), { name: 'AuthService' });
    expect(results[0].memory_context).toBeDefined();
    expect(results[0].memory_context!.last_seen_session).toBe('sess-1');
    expect(results[0].memory_context!.observations).toContain('AuthService was inspected');
    expect(results[0].memory_context!.stale).toBe(false);
  });

  it('marks memory_context.stale=true when any observation is stale', () => {
    // A live observation plus a stale one for the same symbol.
    insertObservation(db, {
      sessionId: 'sess-1',
      type: 'accessed',
      filePath: 'src/auth.ts',
      symbolName: 'AuthService',
      observation: 'fresh observation',
    });
    db.prepare(
      `INSERT INTO session_observations (session_id, type, file_path, symbol_name, observation, stale, stale_reason)
       VALUES (?, 'sig_changed', 'src/auth.ts', 'AuthService', 'old observation', 1, 'signature changed')`,
    ).run('sess-0');

    const results = getSymbol(makeTestRepoSet(db), { name: 'AuthService' });
    expect(results[0].memory_context).toBeDefined();
    expect(results[0].memory_context!.stale).toBe(true);
  });

  it('omits memory_context when observations exist only for a different symbol', () => {
    insertObservation(db, {
      sessionId: 'sess-1',
      type: 'accessed',
      filePath: 'src/auth.ts',
      symbolName: 'SomethingElse',
      observation: 'unrelated',
    });

    const results = getSymbol(makeTestRepoSet(db), { name: 'AuthService' });
    expect(results[0].memory_context).toBeUndefined();
  });
});
