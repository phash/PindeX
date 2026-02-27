import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol, insertTestDependency } from '../helpers/fixtures.js';
import { getFileSummary } from '../../src/tools/get_file_summary.js';

describe('getFileSummary', () => {
  let db: Database.Database;
  let fileId: number;

  beforeEach(() => {
    db = createTestDb();
    fileId = insertTestFile(db, { path: 'src/service.ts', language: 'typescript', summary: 'Auth service module' });
    insertTestSymbol(db, { fileId, name: 'AuthService', kind: 'class', signature: 'class AuthService', isExported: true });
    insertTestSymbol(db, { fileId, name: 'login', kind: 'method', signature: 'login(email: string): Promise<Token>' });
    insertTestSymbol(db, { fileId, name: 'privateHelper', kind: 'function', signature: 'privateHelper(): void', isExported: false });
  });

  it('returns file metadata', () => {
    const result = getFileSummary(db, { file: 'src/service.ts' });
    expect(result).not.toBeNull();
    expect(result!.language).toBe('typescript');
    expect(result!.summary).toBe('Auth service module');
  });

  it('returns all symbols for the file', () => {
    const result = getFileSummary(db, { file: 'src/service.ts' });
    expect(result!.symbols).toHaveLength(3);
    expect(result!.symbols.map((s) => s.name)).toContain('AuthService');
  });

  it('returns exports (symbols with isExported=true)', () => {
    const result = getFileSummary(db, { file: 'src/service.ts' });
    expect(result!.exports).toContain('AuthService');
    expect(result!.exports).not.toContain('privateHelper');
  });

  it('returns imports from dependencies', () => {
    const depFile = insertTestFile(db, { path: 'src/utils.ts' });
    insertTestDependency(db, fileId, depFile, 'Helper');
    const result = getFileSummary(db, { file: 'src/service.ts' });
    expect(result!.imports).toContain('src/utils.ts');
  });

  it('returns null for a non-existent file', () => {
    const result = getFileSummary(db, { file: 'src/ghost.ts' });
    expect(result).toBeNull();
  });

  it('returns empty symbols array when file has no symbols', () => {
    const emptyFileId = insertTestFile(db, { path: 'src/empty.ts' });
    const result = getFileSummary(db, { file: 'src/empty.ts' });
    expect(result!.symbols).toHaveLength(0);
  });
});
