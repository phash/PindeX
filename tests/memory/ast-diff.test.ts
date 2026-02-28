import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { computeAstDiff, hashSignature } from '../../src/memory/ast-diff.js';
import { getSnapshotsByFile } from '../../src/db/queries.js';
import type { ParsedSymbol } from '../../src/types.js';

const sym = (name: string, sig: string, kind = 'function'): ParsedSymbol => ({
  name,
  kind: kind as ParsedSymbol['kind'],
  signature: sig,
  startLine: 1,
  endLine: 10,
  isExported: true,
});

describe('hashSignature', () => {
  it('produces a consistent 8-char hex hash', () => {
    const h = hashSignature('function foo(): void');
    expect(h).toHaveLength(8);
    expect(hashSignature('function foo(): void')).toBe(h);
  });

  it('is insensitive to leading/trailing whitespace and extra spaces', () => {
    expect(hashSignature('  function foo(): void  ')).toBe(
      hashSignature('function foo(): void'),
    );
    expect(hashSignature('function  foo():  void')).toBe(
      hashSignature('function foo(): void'),
    );
  });

  it('differs for different signatures', () => {
    expect(hashSignature('function foo(): void')).not.toBe(
      hashSignature('function bar(): void'),
    );
  });
});

describe('computeAstDiff', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns no changes for a new file (no prior snapshots)', () => {
    const result = computeAstDiff(db, 'src/auth.ts', [sym('foo', 'function foo(): void')]);
    expect(result.hasChanges).toBe(false);
    expect(result.changes).toHaveLength(0);
  });

  it('stores snapshots after first call', () => {
    computeAstDiff(db, 'src/auth.ts', [sym('foo', 'function foo(): void')]);
    const snaps = getSnapshotsByFile(db, 'src/auth.ts');
    expect(snaps).toHaveLength(1);
    expect(snaps[0].symbol_name).toBe('foo');
  });

  it('detects added symbols on second call', () => {
    computeAstDiff(db, 'src/auth.ts', [sym('foo', 'function foo(): void')]);
    const result = computeAstDiff(db, 'src/auth.ts', [
      sym('foo', 'function foo(): void'),
      sym('bar', 'function bar(): string'),
    ]);
    expect(result.hasChanges).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].type).toBe('added');
    expect(result.changes[0].name).toBe('bar');
  });

  it('detects removed symbols', () => {
    computeAstDiff(db, 'src/auth.ts', [
      sym('foo', 'function foo(): void'),
      sym('bar', 'function bar(): string'),
    ]);
    const result = computeAstDiff(db, 'src/auth.ts', [sym('foo', 'function foo(): void')]);
    expect(result.hasChanges).toBe(true);
    expect(result.changes[0].type).toBe('removed');
    expect(result.changes[0].name).toBe('bar');
    expect(result.changes[0].oldSignature).toBe('function bar(): string');
  });

  it('detects signature changes', () => {
    computeAstDiff(db, 'src/auth.ts', [sym('foo', 'function foo(): void')]);
    const result = computeAstDiff(db, 'src/auth.ts', [
      sym('foo', 'function foo(bar: string): void'),
    ]);
    expect(result.changes[0].type).toBe('sig_changed');
    expect(result.changes[0].oldSignature).toBe('function foo(): void');
    expect(result.changes[0].newSignature).toBe('function foo(bar: string): void');
  });

  it('does not flag changes when signature is identical (normalised)', () => {
    computeAstDiff(db, 'src/auth.ts', [sym('foo', 'function foo(): void')]);
    // Same signature with different whitespace
    const result = computeAstDiff(db, 'src/auth.ts', [sym('foo', 'function  foo():  void')]);
    expect(result.hasChanges).toBe(false);
  });

  it('updates snapshots after each call', () => {
    computeAstDiff(db, 'src/auth.ts', [sym('foo', 'function foo(): void')]);
    computeAstDiff(db, 'src/auth.ts', [sym('foo', 'function foo(x: number): void')]);
    const snaps = getSnapshotsByFile(db, 'src/auth.ts');
    expect(snaps[0].signature).toBe('function foo(x: number): void');
  });

  it('handles empty symbol list (all removed)', () => {
    computeAstDiff(db, 'src/auth.ts', [
      sym('foo', 'function foo(): void'),
      sym('bar', 'function bar(): void'),
    ]);
    const result = computeAstDiff(db, 'src/auth.ts', []);
    expect(result.changes).toHaveLength(2);
    expect(result.changes.every((c) => c.type === 'removed')).toBe(true);
    expect(getSnapshotsByFile(db, 'src/auth.ts')).toHaveLength(0);
  });

  it('description includes kind and symbol name', () => {
    computeAstDiff(db, 'src/auth.ts', [sym('Foo', 'class Foo', 'class')]);
    const result = computeAstDiff(db, 'src/auth.ts', []);
    expect(result.changes[0].description).toContain('Foo');
    expect(result.changes[0].description).toContain('class');
  });
});
