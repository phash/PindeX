import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import {
  insertTestFile,
  insertTestSymbol,
  insertTestDependency,
  insertTestRef,
} from '../helpers/fixtures.js';
import { deleteSymbolsByFileId, getAllRefs } from '../../src/db/queries.js';
import { buildCallGraph, resolveRefs, findSymbolCandidates } from '../../src/graph/call-graph.js';

describe('call graph resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('resolves a same-file call as EXTRACTED, with the caller symbol', () => {
    const f = insertTestFile(db, { path: 'src/a.ts' });
    const helper = insertTestSymbol(db, { fileId: f, name: 'helper', startLine: 1, endLine: 3 });
    const main = insertTestSymbol(db, { fileId: f, name: 'main', startLine: 5, endLine: 9 });
    insertTestRef(db, f, 'helper', 6, { callerSymbolId: main });

    const { edges, ambiguous } = buildCallGraph(db);
    expect(ambiguous).toBe(0);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromFile: 'src/a.ts',
      line: 6,
      confidence: 'EXTRACTED',
      from: { id: main, name: 'main', file: 'src/a.ts', line: 5 },
      to: { id: helper, name: 'helper', kind: 'function', file: 'src/a.ts', line: 1 },
    });
  });

  it('module-level call has from = null', () => {
    const f = insertTestFile(db, { path: 'src/a.ts' });
    insertTestSymbol(db, { fileId: f, name: 'helper' });
    insertTestRef(db, f, 'helper', 20);
    const { edges } = buildCallGraph(db);
    expect(edges[0].from).toBeNull();
    expect(edges[0].fromFile).toBe('src/a.ts');
  });

  it('follows the import for a name defined in two files; unimported call is ambiguous', () => {
    const a = insertTestFile(db, { path: 'src/a.ts' });
    const b = insertTestFile(db, { path: 'src/b.ts', hash: 'b' });
    const c = insertTestFile(db, { path: 'src/c.ts', hash: 'c' });
    const d = insertTestFile(db, { path: 'src/d.ts', hash: 'd' });
    const fa = insertTestSymbol(db, { fileId: a, name: 'format', isExported: true });
    insertTestSymbol(db, { fileId: b, name: 'format', isExported: true });
    insertTestDependency(db, c, a, 'format');
    insertTestRef(db, c, 'format', 7);
    insertTestRef(db, d, 'format', 3);

    const { edges, ambiguous } = buildCallGraph(db);
    expect(edges).toHaveLength(1);
    expect(edges[0].fromFile).toBe('src/c.ts');
    expect(edges[0].to.id).toBe(fa);
    expect(edges[0].to.file).toBe('src/a.ts');
    expect(edges[0].confidence).toBe('EXTRACTED');
    expect(ambiguous).toBe(1);
  });

  it('resolves a unique project-wide name without import as INFERRED', () => {
    const a = insertTestFile(db, { path: 'src/a.ts' });
    const b = insertTestFile(db, { path: 'src/b.ts', hash: 'b' });
    const target = insertTestSymbol(db, { fileId: a, name: 'uniqueThing' });
    insertTestRef(db, b, 'uniqueThing', 4);

    const { edges, ambiguous } = buildCallGraph(db);
    expect(ambiguous).toBe(0);
    expect(edges).toHaveLength(1);
    expect(edges[0].to.id).toBe(target);
    expect(edges[0].confidence).toBe('INFERRED');
  });

  it('drops refs to names with no definition without counting them as ambiguous', () => {
    const a = insertTestFile(db, { path: 'src/a.ts' });
    insertTestRef(db, a, 'console', 1);
    expect(buildCallGraph(db)).toEqual({ edges: [], ambiguous: 0 });
  });

  it('receiver this restricts the same-file step to methods', () => {
    const a = insertTestFile(db, { path: 'src/a.ts' });
    const b = insertTestFile(db, { path: 'src/b.ts', hash: 'b' });
    insertTestSymbol(db, { fileId: a, name: 'save', kind: 'function', startLine: 1 });
    insertTestSymbol(db, { fileId: b, name: 'save', kind: 'method', startLine: 1 });
    const method = insertTestSymbol(db, { fileId: a, name: 'save', kind: 'method', startLine: 10 });
    insertTestRef(db, a, 'save', 12, { receiver: 'this' });

    const { edges } = buildCallGraph(db);
    expect(edges).toHaveLength(1);
    expect(edges[0].to.id).toBe(method);
    expect(edges[0].confidence).toBe('EXTRACTED');
  });

  it('survives a reindex of the target file (symbols deleted + re-inserted)', () => {
    const a = insertTestFile(db, { path: 'src/a.ts' });
    const c = insertTestFile(db, { path: 'src/c.ts', hash: 'c' });
    insertTestSymbol(db, { fileId: a, name: 'format', isExported: true });
    insertTestDependency(db, c, a, 'format');
    insertTestRef(db, c, 'format', 7);
    expect(buildCallGraph(db).edges).toHaveLength(1);

    deleteSymbolsByFileId(db, a);
    const reinserted = insertTestSymbol(db, { fileId: a, name: 'format', isExported: true });

    const { edges } = buildCallGraph(db);
    expect(edges).toHaveLength(1);
    expect(edges[0].to.id).toBe(reinserted);
    expect(edges[0].confidence).toBe('EXTRACTED');
  });

  it('resolveRefs only resolves the refs it is given', () => {
    const a = insertTestFile(db, { path: 'src/a.ts' });
    insertTestSymbol(db, { fileId: a, name: 'x' });
    insertTestSymbol(db, { fileId: a, name: 'y' });
    insertTestRef(db, a, 'x', 1);
    insertTestRef(db, a, 'y', 2);
    const onlyY = getAllRefs(db).filter((r) => r.callee_name === 'y');
    const { edges } = resolveRefs(db, onlyY);
    expect(edges.map((e) => e.to.name)).toEqual(['y']);
  });
});

describe('findSymbolCandidates', () => {
  it('returns candidates in deterministic order and filters by normalized file', () => {
    const db = createTestDb();
    const b = insertTestFile(db, { path: 'src/b.ts', hash: 'b' });
    const a = insertTestFile(db, { path: 'src/a.ts' });
    insertTestSymbol(db, { fileId: b, name: 'format', startLine: 3 });
    insertTestSymbol(db, { fileId: a, name: 'format', startLine: 9 });

    expect(findSymbolCandidates(db, 'format').map((s) => s.file)).toEqual(['src/a.ts', 'src/b.ts']);
    const scoped = findSymbolCandidates(db, 'format', './src\\b.ts');
    expect(scoped).toEqual([{ id: expect.any(Number), name: 'format', kind: 'function', file: 'src/b.ts', line: 3 }]);
    expect(findSymbolCandidates(db, 'nope')).toEqual([]);
  });
});
