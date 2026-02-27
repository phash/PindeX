import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import {
  insertTestFile,
  insertTestSymbol,
  insertTestDependency,
  insertTestUsage,
  insertTestSession,
  insertTestTokenLog,
} from '../helpers/fixtures.js';
import {
  upsertFile,
  getFileByPath,
  getAllFiles,
  deleteFile,
  upsertSymbol,
  getSymbolsByFileId,
  getSymbolByName,
  searchSymbolsFts,
  getDependenciesByFile,
  getImportedByFile,
  getUsagesBySymbol,
  insertTokenLog,
  getSessionStats,
  createSession,
  updateSession,
  getSession,
  listSessions,
  deleteSymbolsByFileId,
  upsertDependency,
  upsertUsage,
} from '../../src/db/queries.js';

describe('File queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('upsertFile', () => {
    it('inserts a new file record', () => {
      upsertFile(db, {
        path: 'src/index.ts',
        language: 'typescript',
        hash: 'abc',
        rawTokenEstimate: 200,
        summary: null,
      });
      const file = getFileByPath(db, 'src/index.ts');
      expect(file).toBeTruthy();
      expect(file!.path).toBe('src/index.ts');
      expect(file!.language).toBe('typescript');
    });

    it('updates an existing file on conflict', () => {
      upsertFile(db, { path: 'src/a.ts', language: 'typescript', hash: 'h1', rawTokenEstimate: 100, summary: null });
      upsertFile(db, { path: 'src/a.ts', language: 'typescript', hash: 'h2', rawTokenEstimate: 200, summary: null });
      const file = getFileByPath(db, 'src/a.ts');
      expect(file!.hash).toBe('h2');
      expect(file!.raw_token_estimate).toBe(200);
    });
  });

  describe('getFileByPath', () => {
    it('returns null for non-existent path', () => {
      const result = getFileByPath(db, 'nonexistent.ts');
      expect(result).toBeNull();
    });

    it('returns the file for an existing path', () => {
      insertTestFile(db, { path: 'src/found.ts' });
      const file = getFileByPath(db, 'src/found.ts');
      expect(file).not.toBeNull();
      expect(file!.path).toBe('src/found.ts');
    });
  });

  describe('getAllFiles', () => {
    it('returns empty array for empty db', () => {
      expect(getAllFiles(db)).toHaveLength(0);
    });

    it('returns all inserted files', () => {
      insertTestFile(db, { path: 'a.ts' });
      insertTestFile(db, { path: 'b.ts' });
      expect(getAllFiles(db)).toHaveLength(2);
    });
  });

  describe('deleteFile', () => {
    it('removes a file by path', () => {
      insertTestFile(db, { path: 'del.ts' });
      deleteFile(db, 'del.ts');
      expect(getFileByPath(db, 'del.ts')).toBeNull();
    });

    it('does not throw when deleting a non-existent path', () => {
      expect(() => deleteFile(db, 'ghost.ts')).not.toThrow();
    });
  });
});

describe('Symbol queries', () => {
  let db: Database.Database;
  let fileId: number;

  beforeEach(() => {
    db = createTestDb();
    fileId = insertTestFile(db, { path: 'src/module.ts' });
  });

  describe('upsertSymbol', () => {
    it('inserts a new symbol', () => {
      upsertSymbol(db, {
        fileId,
        name: 'myFunction',
        kind: 'function',
        signature: 'myFunction(): void',
        summary: null,
        startLine: 1,
        endLine: 5,
        isExported: true,
      });
      const symbols = getSymbolsByFileId(db, fileId);
      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe('myFunction');
    });
  });

  describe('getSymbolsByFileId', () => {
    it('returns empty array when file has no symbols', () => {
      expect(getSymbolsByFileId(db, fileId)).toHaveLength(0);
    });

    it('returns all symbols for a file', () => {
      insertTestSymbol(db, { fileId, name: 'alpha' });
      insertTestSymbol(db, { fileId, name: 'beta' });
      expect(getSymbolsByFileId(db, fileId)).toHaveLength(2);
    });
  });

  describe('getSymbolByName', () => {
    it('returns null when symbol not found', () => {
      expect(getSymbolByName(db, 'unknown')).toBeNull();
    });

    it('returns the symbol by name', () => {
      insertTestSymbol(db, { fileId, name: 'AuthService' });
      const sym = getSymbolByName(db, 'AuthService');
      expect(sym).not.toBeNull();
      expect(sym!.name).toBe('AuthService');
    });

    it('filters by file when provided', () => {
      const otherFileId = insertTestFile(db, { path: 'src/other.ts' });
      insertTestSymbol(db, { fileId, name: 'Shared' });
      insertTestSymbol(db, { fileId: otherFileId, name: 'Shared' });
      const result = getSymbolByName(db, 'Shared', 'src/module.ts');
      expect(result).not.toBeNull();
      expect(result!.file_path).toBe('src/module.ts');
    });
  });

  describe('deleteSymbolsByFileId', () => {
    it('removes all symbols for a file', () => {
      insertTestSymbol(db, { fileId, name: 'a' });
      insertTestSymbol(db, { fileId, name: 'b' });
      deleteSymbolsByFileId(db, fileId);
      expect(getSymbolsByFileId(db, fileId)).toHaveLength(0);
    });
  });

  describe('searchSymbolsFts', () => {
    it('finds symbols by name using full-text search', () => {
      insertTestSymbol(db, { fileId, name: 'createUser' });
      insertTestSymbol(db, { fileId, name: 'deleteUser' });
      const results = searchSymbolsFts(db, 'createUser', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('createUser');
    });

    it('returns empty array for no matches', () => {
      const results = searchSymbolsFts(db, 'nonexistentXYZ12345', 10);
      expect(results).toHaveLength(0);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        insertTestSymbol(db, { fileId, name: `handler${i}` });
      }
      const results = searchSymbolsFts(db, 'handler', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });
});

describe('Dependency queries', () => {
  let db: Database.Database;
  let fileAId: number;
  let fileBId: number;

  beforeEach(() => {
    db = createTestDb();
    fileAId = insertTestFile(db, { path: 'src/a.ts' });
    fileBId = insertTestFile(db, { path: 'src/b.ts' });
  });

  describe('upsertDependency', () => {
    it('inserts a dependency between two files', () => {
      upsertDependency(db, { fromFile: fileAId, toFile: fileBId, symbolName: 'MyClass' });
      const deps = getDependenciesByFile(db, fileAId);
      expect(deps).toHaveLength(1);
      expect(deps[0]).toContain('src/b.ts');
    });
  });

  describe('getDependenciesByFile', () => {
    it('returns empty array when no dependencies', () => {
      expect(getDependenciesByFile(db, fileAId)).toHaveLength(0);
    });

    it('returns paths of files that fileA imports', () => {
      insertTestDependency(db, fileAId, fileBId, 'SomeSymbol');
      const deps = getDependenciesByFile(db, fileAId);
      expect(deps).toContain('src/b.ts');
    });
  });

  describe('getImportedByFile', () => {
    it('returns files that import a given file', () => {
      insertTestDependency(db, fileAId, fileBId, null);
      const importedBy = getImportedByFile(db, fileBId);
      expect(importedBy).toContain('src/a.ts');
    });
  });
});

describe('Usage queries', () => {
  let db: Database.Database;
  let fileId: number;
  let symbolId: number;

  beforeEach(() => {
    db = createTestDb();
    fileId = insertTestFile(db, { path: 'src/app.ts' });
    symbolId = insertTestSymbol(db, { fileId, name: 'getUser' });
  });

  describe('upsertUsage', () => {
    it('inserts a usage record', () => {
      const callerFileId = insertTestFile(db, { path: 'src/caller.ts' });
      upsertUsage(db, { symbolId, usedInFile: callerFileId, usedAtLine: 42 });
      const usages = getUsagesBySymbol(db, symbolId);
      expect(usages).toHaveLength(1);
      expect(usages[0].used_at_line).toBe(42);
    });
  });

  describe('getUsagesBySymbol', () => {
    it('returns empty array when no usages', () => {
      expect(getUsagesBySymbol(db, symbolId)).toHaveLength(0);
    });

    it('returns all usages for a symbol', () => {
      const callerA = insertTestFile(db, { path: 'src/callerA.ts' });
      const callerB = insertTestFile(db, { path: 'src/callerB.ts' });
      insertTestUsage(db, symbolId, callerA, 10);
      insertTestUsage(db, symbolId, callerB, 20);
      const usages = getUsagesBySymbol(db, symbolId);
      expect(usages).toHaveLength(2);
    });
  });
});

describe('Token log queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertTestSession(db, 'sess-1', 'indexed', 'Test');
  });

  describe('insertTokenLog', () => {
    it('inserts a token log entry', () => {
      insertTokenLog(db, {
        sessionId: 'sess-1',
        toolName: 'search_symbols',
        tokensUsed: 50,
        tokensWithoutIndex: 500,
        filesTouched: ['src/a.ts'],
        query: 'myFunc',
      });
      const stats = getSessionStats(db, 'sess-1');
      expect(stats.calls).toHaveLength(1);
    });
  });

  describe('getSessionStats', () => {
    it('returns correct aggregated stats', () => {
      insertTestTokenLog(db, 'sess-1', 'search_symbols', 50, 500);
      insertTestTokenLog(db, 'sess-1', 'get_symbol', 80, 800);
      const stats = getSessionStats(db, 'sess-1');
      expect(stats.tokens_used).toBe(130);
      expect(stats.tokens_saved).toBe(1170);
      expect(stats.calls).toHaveLength(2);
    });
  });
});

describe('Session queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('createSession', () => {
    it('creates a new session', () => {
      createSession(db, { id: 'sess-abc', mode: 'indexed', label: 'My Test' });
      const session = getSession(db, 'sess-abc');
      expect(session).not.toBeNull();
      expect(session!.mode).toBe('indexed');
      expect(session!.label).toBe('My Test');
    });
  });

  describe('updateSession', () => {
    it('updates total_tokens and total_savings', () => {
      createSession(db, { id: 'sess-upd', mode: 'indexed', label: null });
      updateSession(db, 'sess-upd', { totalTokens: 100, totalSavings: 900 });
      const session = getSession(db, 'sess-upd');
      expect(session!.total_tokens).toBe(100);
      expect(session!.total_savings).toBe(900);
    });
  });

  describe('listSessions', () => {
    it('returns all sessions', () => {
      createSession(db, { id: 's1', mode: 'indexed', label: null });
      createSession(db, { id: 's2', mode: 'baseline', label: 'Baseline' });
      const sessions = listSessions(db);
      expect(sessions).toHaveLength(2);
    });
  });
});
