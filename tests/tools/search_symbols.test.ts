import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol } from '../helpers/fixtures.js';
import { searchSymbols } from '../../src/tools/search_symbols.js';
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';
import { RepoSet } from '../../src/federation/repo-set.js';

function singleRepoWithPath(db: Database.Database, path: string): RepoSet {
  return RepoSet.fromServerConfig(db, 'local', [], path);
}

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

describe('searchSymbols — snippet (TST-06)', () => {
  let db: Database.Database;
  let testDir: string;

  const sourceLines = [
    'export function targetSnippetFn() {',  // line 1
    '  const a = 1;',                        // line 2
    '  const b = 2;',                        // line 3
    '  const c = 3;',                        // line 4
    '  const d = 4;',                        // line 5
    '  const e = 5;',                        // line 6
    '  return a + b + c + d + e;',           // line 7
    '}',                                     // line 8
  ];
  const sourceContent = sourceLines.join('\n');

  beforeEach(() => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-ss-snip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'target.ts'), sourceContent);
    const fileId = insertTestFile(db, { path: 'src/target.ts', language: 'typescript' });
    insertTestSymbol(db, {
      fileId,
      name: 'targetSnippetFn',
      kind: 'function',
      signature: 'targetSnippetFn(): number',
      startLine: 1,
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('attaches a ~5-line snippet read from disk when snippet:true', () => {
    const results = searchSymbols(singleRepoWithPath(db, testDir), {
      query: 'targetSnippetFn',
      snippet: true,
    });
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.name === 'targetSnippetFn');
    expect(hit).toBeDefined();
    // Source slices 5 lines starting at startIdx = max(0, start_line-1) = 0
    const expected = sourceLines.slice(0, 5).join('\n');
    expect(hit!.snippet).toBe(expected);
    expect(hit!.snippet!.split('\n')).toHaveLength(5);
    expect(hit!.snippet).toContain('export function targetSnippetFn');
  });

  it('does not attach a snippet when snippet is omitted', () => {
    const results = searchSymbols(singleRepoWithPath(db, testDir), { query: 'targetSnippetFn' });
    const hit = results.find((r) => r.name === 'targetSnippetFn');
    expect(hit).toBeDefined();
    expect(hit!.snippet).toBeUndefined();
  });

  it('refuses to read snippets for path-traversal file rows (../secret.txt)', () => {
    const outsideDir = join(tmpdir(), `pindex-ss-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.txt'), 'TOP SECRET\nline 2\nline 3\nline 4\nline 5\nline 6');
    // The DB row's path resolves to outsideDir/secret.txt when joined to testDir.
    const traversalPath = join('..', basename(outsideDir), 'secret.txt');
    const fileId = insertTestFile(db, { path: traversalPath, language: 'typescript' });
    insertTestSymbol(db, { fileId, name: 'secretSnippetSym', kind: 'function', startLine: 1 });
    try {
      const results = searchSymbols(singleRepoWithPath(db, testDir), {
        query: 'secretSnippetSym',
        snippet: true,
      });
      const hit = results.find((r) => r.name === 'secretSnippetSym');
      expect(hit).toBeDefined();
      // Guard skips the disk read → no snippet leaked.
      expect(hit!.snippet).toBeUndefined();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses to read snippets for absolute paths outside root (/etc/passwd)', () => {
    const fileId = insertTestFile(db, { path: '/etc/passwd', language: 'typescript' });
    insertTestSymbol(db, { fileId, name: 'passwdSnippetSym', kind: 'function', startLine: 1 });
    const results = searchSymbols(singleRepoWithPath(db, testDir), {
      query: 'passwdSnippetSym',
      snippet: true,
    });
    const hit = results.find((r) => r.name === 'passwdSnippetSym');
    expect(hit).toBeDefined();
    expect(hit!.snippet).toBeUndefined();
  });
});
