import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol } from '../helpers/fixtures.js';
import { searchSymbols } from '../../src/tools/search_symbols.js';

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
    const result = searchSymbols(db, { query: 'createUser' });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe('createUser');
    expect(result[0].kind).toBe('function');
    expect(result[0].file).toBe('src/auth.ts');
  });

  it('returns multiple matches', () => {
    const result = searchSymbols(db, { query: 'User' });
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty array for no matches', () => {
    const result = searchSymbols(db, { query: 'zzznomatchzzz12345' });
    expect(result).toHaveLength(0);
  });

  it('respects the limit parameter', () => {
    const result = searchSymbols(db, { query: 'User', limit: 1 });
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it('uses default limit of 20 when not specified', () => {
    const result = searchSymbols(db, { query: 'User' });
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('includes signature and summary in result', () => {
    const result = searchSymbols(db, { query: 'createUser' });
    expect(result[0].signature).toBe('createUser(email: string): Promise<User>');
  });

  it('includes file path and line number', () => {
    const result = searchSymbols(db, { query: 'createUser' });
    expect(result[0].file).toBe('src/auth.ts');
    expect(typeof result[0].line).toBe('number');
  });
});
