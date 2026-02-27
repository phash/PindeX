import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol, insertTestDependency } from '../helpers/fixtures.js';
import { getSymbol } from '../../src/tools/get_symbol.js';

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
    const result = getSymbol(db, { name: 'AuthService' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('AuthService');
    expect(result!.kind).toBe('class');
    expect(result!.file).toBe('src/auth.ts');
    expect(result!.startLine).toBe(5);
    expect(result!.endLine).toBe(50);
    expect(result!.isExported).toBe(true);
  });

  it('returns null when symbol is not found', () => {
    const result = getSymbol(db, { name: 'NonExistent' });
    expect(result).toBeNull();
  });

  it('filters by file when specified', () => {
    const otherFileId = insertTestFile(db, { path: 'src/other.ts' });
    insertTestSymbol(db, { fileId: otherFileId, name: 'AuthService', kind: 'class', signature: 'class AuthService' });

    const result = getSymbol(db, { name: 'AuthService', file: 'src/auth.ts' });
    expect(result).not.toBeNull();
    expect(result!.file).toBe('src/auth.ts');
  });

  it('includes dependencies array', () => {
    const depFileId = insertTestFile(db, { path: 'src/utils.ts' });
    insertTestDependency(db, fileId, depFileId, 'Helper');

    const result = getSymbol(db, { name: 'AuthService' });
    expect(Array.isArray(result!.dependencies)).toBe(true);
  });

  it('returns signature', () => {
    const result = getSymbol(db, { name: 'AuthService' });
    expect(result!.signature).toBe('class AuthService');
  });
});
