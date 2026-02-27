import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol, insertTestUsage } from '../helpers/fixtures.js';
import { findUsages } from '../../src/tools/find_usages.js';

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
    insertTestUsage(db, symbolId, callerA, 15);
    insertTestUsage(db, symbolId, callerB, 42);
  });

  it('returns all usages of a symbol', () => {
    const result = findUsages(db, { symbol: 'validateToken' });
    expect(result).toHaveLength(2);
  });

  it('returns file path for each usage', () => {
    const result = findUsages(db, { symbol: 'validateToken' });
    const files = result.map((u) => u.file);
    expect(files).toContain('src/middleware.ts');
    expect(files).toContain('src/routes.ts');
  });

  it('returns line number for each usage', () => {
    const result = findUsages(db, { symbol: 'validateToken' });
    const lines = result.map((u) => u.line);
    expect(lines).toContain(15);
    expect(lines).toContain(42);
  });

  it('returns empty array for unknown symbol', () => {
    const result = findUsages(db, { symbol: 'unknownXYZ' });
    expect(result).toHaveLength(0);
  });

  it('returns empty array for symbol with no usages', () => {
    const fileId = insertTestFile(db, { path: 'src/unused.ts' });
    insertTestSymbol(db, { fileId, name: 'unusedFunc', kind: 'function', signature: 'unusedFunc(): void' });
    const result = findUsages(db, { symbol: 'unusedFunc' });
    expect(result).toHaveLength(0);
  });
});
