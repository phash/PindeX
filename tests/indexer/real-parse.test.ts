import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Run with the REAL tree-sitter bindings instead of the empty-AST mock that
// tests/setup.ts installs globally. Must be at the very top, before any import
// that transitively pulls in tree-sitter (the Indexer / parser does).
vi.unmock('tree-sitter');
vi.unmock('tree-sitter-typescript');

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { Indexer } from '../../src/indexer/index.js';
import { parseFile } from '../../src/indexer/parser.js';

interface SymbolRow {
  name: string;
  kind: string;
  is_exported: number;
}

describe('Indexer with REAL tree-sitter (TST-03)', () => {
  let db: Database.Database;
  let projectRoot: string;

  beforeEach(() => {
    db = createTestDb();
    projectRoot = mkdtempSync(join(tmpdir(), 'pindex-real-parse-'));
  });

  afterEach(async () => {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('extracts real function and class names with correct kinds', async () => {
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'src', 'sample.ts'),
      [
        'export function computeTotal(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export class InvoiceService {',
        '  total(): number {',
        '    return 0;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    // maxParseWorkers: 0 → parse synchronously on the main thread so the
    // unmocked tree-sitter binding is used (worker threads have their own
    // module cache and would re-apply the global mock).
    const indexer = new Indexer({
      db,
      projectRoot,
      languages: ['typescript'],
      maxParseWorkers: 0,
    });

    const result = await indexer.indexAll();
    await indexer.closePool();

    expect(result.errors).toEqual([]);
    expect(result.indexed).toBeGreaterThan(0);

    const rows = db
      .prepare(
        `SELECT s.name, s.kind, s.is_exported
         FROM symbols s JOIN files f ON s.file_id = f.id
         WHERE f.path = 'src/sample.ts'`,
      )
      .all() as SymbolRow[];

    const byName = new Map(rows.map((r) => [r.name, r]));

    // Real AST parsing must surface the actual identifiers — the empty-AST
    // mock would yield zero symbols here.
    expect(byName.has('computeTotal')).toBe(true);
    expect(byName.get('computeTotal')?.kind).toBe('function');

    expect(byName.has('InvoiceService')).toBe(true);
    expect(byName.get('InvoiceService')?.kind).toBe('class');

    // Both top-level declarations are exported.
    expect(byName.get('computeTotal')?.is_exported).toBe(1);
    expect(byName.get('InvoiceService')?.is_exported).toBe(1);
  });
});

describe('parseFile symbol extraction with REAL tree-sitter (Task 10)', () => {
  const names = (src: string) => parseFile('x.ts', src).symbols.map((s) => s.name);

  it('does not export locals declared inside an exported arrow body; arrow becomes a function', () => {
    const { symbols } = parseFile('x.ts', 'export const h = () => { const inner = 1; };');
    expect(symbols.map((s) => s.name)).toEqual(['h']);
    expect(symbols[0].kind).toBe('function');
    expect(symbols[0].signature).toBe('h()');
    expect(symbols[0].isExported).toBe(true);
  });

  it('extracts non-exported arrow consts as non-exported functions with params/return type', () => {
    const { symbols } = parseFile('x.ts', 'const f = (a: number): number => a;');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'f', kind: 'function', isExported: false, signature: 'f(a: number): number' });
  });

  it('treats function expressions and async arrows as functions', () => {
    const { symbols } = parseFile('x.ts', 'export const g = async function (x) { return x; };\nexport const k = async (y) => y;');
    expect(symbols.map((s) => [s.name, s.kind, s.isAsync])).toEqual([['g', 'function', true], ['k', 'function', true]]);
  });

  it('keeps non-function exported consts as const', () => {
    const { symbols } = parseFile('x.ts', 'export const X = 5;\nexport const cfg = { a: () => { const z = 1; } };');
    expect(symbols.map((s) => [s.name, s.kind])).toEqual([['X', 'const'], ['cfg', 'const']]);
  });

  it('extracts exported abstract classes and their methods', () => {
    const { symbols } = parseFile('x.ts', 'export abstract class A { m() {} }');
    expect(symbols.map((s) => [s.name, s.kind, s.isExported])).toEqual([['A', 'class', true], ['m', 'method', false]]);
  });

  it('does not pick up methods of nested classes', () => {
    expect(names('class O { m(){ const x = class { n(){} }; } }')).toEqual(['O', 'm']);
  });
});
