import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol } from '../helpers/fixtures.js';
import { searchSymbols } from '../../src/tools/search_symbols.js';
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

describe('searchSymbols', () => {
  let db: Database.Database;
  let fileId: number;

  beforeEach(() => {
    db = createTestDb();
    fileId = insertTestFile(db, { path: 'src/auth.ts', rawTokenEstimate: 500 });
    insertTestSymbol(db, { fileId, name: 'createUser', kind: 'function', signature: 'createUser(email: string): Promise<User>' });
    insertTestSymbol(db, { fileId, name: 'deleteUser', kind: 'function', signature: 'deleteUser(id: number): void' });
    insertTestSymbol(db, { fileId, name: 'AuthService', kind: 'class', signature: 'class AuthService' });
  });

  it('returns matching symbols for a query', () => {
    const result = searchSymbols(makeTestRepoSet(db), { query: 'createUser' });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe('createUser');
    expect(result[0].kind).toBe('function');
    expect(result[0].file).toBe('src/auth.ts');
  });

  it('returns multiple matches', () => {
    const result = searchSymbols(makeTestRepoSet(db), { query: 'User' });
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty array for no matches', () => {
    const result = searchSymbols(makeTestRepoSet(db), { query: 'zzznomatchzzz12345' });
    expect(result).toHaveLength(0);
  });

  it('respects the limit parameter', () => {
    const result = searchSymbols(makeTestRepoSet(db), { query: 'User', limit: 1 });
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it('uses default limit of 20 when not specified', () => {
    const result = searchSymbols(makeTestRepoSet(db), { query: 'User' });
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('includes signature and summary in result', () => {
    const result = searchSymbols(makeTestRepoSet(db), { query: 'createUser' });
    expect(result[0].signature).toBe('createUser(email: string): Promise<User>');
  });

  it('includes file path and line number', () => {
    const result = searchSymbols(makeTestRepoSet(db), { query: 'createUser' });
    expect(result[0].file).toBe('src/auth.ts');
    expect(typeof result[0].line).toBe('number');
  });
});

describe('searchSymbols — federation', () => {
  let primaryDb: Database.Database;
  let federatedDb: Database.Database;
  let primaryFileId: number;
  let federatedFileId: number;

  beforeEach(() => {
    primaryDb = createTestDb();
    federatedDb = createTestDb();
    primaryFileId = insertTestFile(primaryDb, { path: 'src/local.ts' });
    federatedFileId = insertTestFile(federatedDb, { path: 'src/remote.ts' });
    insertTestSymbol(primaryDb, { fileId: primaryFileId, name: 'localWidget' });
    insertTestSymbol(federatedDb, { fileId: federatedFileId, name: 'remoteWidget' });
  });

  it('returns results from both repos with project tags', () => {
    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );
    const localResults = searchSymbols(repoSet, { query: 'localWidget' });
    const remoteResults = searchSymbols(repoSet, { query: 'remoteWidget' });
    expect(localResults.length).toBeGreaterThan(0);
    expect(remoteResults.length).toBeGreaterThan(0);
    expect(localResults[0].project).toBe('main');
    expect(remoteResults[0].project).toBe('auth');
  });

  it('scopes by repos param', () => {
    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );
    const results = searchSymbols(repoSet, { query: 'remoteWidget', repos: ['auth'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('remoteWidget');
    expect(results[0].project).toBe('auth');
    // Primary should not appear when scoped to auth only
    const primaryResults = searchSymbols(repoSet, { query: 'localWidget', repos: ['auth'] });
    expect(primaryResults).toHaveLength(0);
  });

  it('throws on unknown repo name', () => {
    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );
    expect(() => searchSymbols(repoSet, { query: 'localWidget', repos: ['nope'] })).toThrow(
      /Unknown repo name: 'nope'/,
    );
  });
});
