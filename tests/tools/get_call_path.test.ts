import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol, insertTestRef } from '../helpers/fixtures.js';
import { RepoSet } from '../../src/federation/repo-set.js';
import { makeTestRepoSet } from '../helpers/repo-set.js';
import { getCallPath } from '../../src/tools/get_call_path.js';

describe('getCallPath', () => {
  let db: Database.Database;
  let f: number;
  let a: number;
  let b: number;
  let c: number;

  beforeEach(() => {
    db = createTestDb();
    f = insertTestFile(db, { path: 'src/chain.ts' });
    a = insertTestSymbol(db, { fileId: f, name: 'a', startLine: 1, endLine: 3 });
    b = insertTestSymbol(db, { fileId: f, name: 'b', startLine: 5, endLine: 7 });
    c = insertTestSymbol(db, { fileId: f, name: 'c', startLine: 9, endLine: 11 });
  });

  it('returns the ordered steps of a 2-hop chain with file and line', () => {
    insertTestRef(db, f, 'b', 2, { callerSymbolId: a });
    insertTestRef(db, f, 'c', 6, { callerSymbolId: b });
    const res = getCallPath(makeTestRepoSet(db), { from: 'a', to: 'c' });
    expect(res).toEqual({
      hops: 2,
      path: [
        { from: 'a', to: 'b', file: 'src/chain.ts', line: 2, confidence: 'EXTRACTED' },
        { from: 'b', to: 'c', file: 'src/chain.ts', line: 6, confidence: 'EXTRACTED' },
      ],
    });
  });

  it('terminates on a cycle with an unreachable target', () => {
    insertTestSymbol(db, { fileId: f, name: 'z', startLine: 13, endLine: 15 });
    insertTestRef(db, f, 'b', 2, { callerSymbolId: a });
    insertTestRef(db, f, 'a', 6, { callerSymbolId: b });
    expect(getCallPath(makeTestRepoSet(db), { from: 'a', to: 'z' })).toEqual({ path: null, hops: 0 });
  });

  it('returns null when the path is longer than max_depth', () => {
    insertTestRef(db, f, 'b', 2, { callerSymbolId: a });
    insertTestRef(db, f, 'c', 6, { callerSymbolId: b });
    expect(getCallPath(makeTestRepoSet(db), { from: 'a', to: 'c', max_depth: 1 })).toEqual({ path: null, hops: 0 });
    expect(getCallPath(makeTestRepoSet(db), { from: 'a', to: 'c', max_depth: 2 })).toMatchObject({ hops: 2 });
  });

  it('ignores module-level calls as starting points', () => {
    insertTestRef(db, f, 'b', 2); // module-level, no caller
    expect(getCallPath(makeTestRepoSet(db), { from: 'a', to: 'b' })).toEqual({ path: null, hops: 0 });
  });

  it('reports an ambiguous from side with candidates', () => {
    const g = insertTestFile(db, { path: 'src/other.ts', hash: 'o' });
    insertTestSymbol(db, { fileId: g, name: 'a', startLine: 4, endLine: 6 });
    const res = getCallPath(makeTestRepoSet(db), { from: 'a', to: 'c' });
    expect(res).toMatchObject({ error: 'ambiguous', side: 'from' });
    expect((res as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('disambiguates via from_file', () => {
    const g = insertTestFile(db, { path: 'src/other.ts', hash: 'o' });
    insertTestSymbol(db, { fileId: g, name: 'a', startLine: 4, endLine: 6 });
    insertTestRef(db, f, 'b', 2, { callerSymbolId: a });
    const res = getCallPath(makeTestRepoSet(db), { from: 'a', to: 'b', from_file: 'src/chain.ts' });
    expect(res).toMatchObject({ hops: 1 });
  });

  it('reports an unknown to side as not_found', () => {
    expect(getCallPath(makeTestRepoSet(db), { from: 'a', to: 'nope' })).toEqual({ error: 'not_found', side: 'to' });
  });

  it('treats a from_file escaping the root as not_found', () => {
    const rooted = RepoSet.fromServerConfig(db, 'local', [], '/tmp/proj');
    expect(getCallPath(rooted, { from: 'a', to: 'c', from_file: '../../etc/passwd' })).toEqual({
      error: 'not_found',
      side: 'from',
    });
  });
});
