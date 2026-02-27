import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol } from '../helpers/fixtures.js';
import { getProjectOverview } from '../../src/tools/get_project_overview.js';

describe('getProjectOverview', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const f1 = insertTestFile(db, { path: 'src/index.ts', language: 'typescript', summary: 'Entry point' });
    const f2 = insertTestFile(db, { path: 'src/service.ts', language: 'typescript' });
    insertTestSymbol(db, { fileId: f1, name: 'main', kind: 'function', signature: 'main(): void' });
    insertTestSymbol(db, { fileId: f2, name: 'MyService', kind: 'class', signature: 'class MyService' });
    insertTestSymbol(db, { fileId: f2, name: 'helper', kind: 'function', signature: 'helper(): void' });
  });

  it('returns the root path', () => {
    const result = getProjectOverview(db, '/my/project');
    expect(result.rootPath).toBe('/my/project');
  });

  it('returns total file and symbol counts', () => {
    const result = getProjectOverview(db, '/my/project');
    expect(result.stats.totalFiles).toBe(2);
    expect(result.stats.totalSymbols).toBe(3);
  });

  it('returns modules with symbol counts', () => {
    const result = getProjectOverview(db, '/my/project');
    expect(result.modules).toHaveLength(2);
    const service = result.modules.find((m) => m.path === 'src/service.ts');
    expect(service).toBeDefined();
    expect(service!.symbolCount).toBe(2);
  });

  it('includes summary when available', () => {
    const result = getProjectOverview(db, '/my/project');
    const index = result.modules.find((m) => m.path === 'src/index.ts');
    expect(index!.summary).toBe('Entry point');
  });

  it('detects TypeScript as the dominant language', () => {
    const result = getProjectOverview(db, '/my/project');
    expect(result.language).toBe('typescript');
  });

  it('returns entryPoints containing index files', () => {
    const result = getProjectOverview(db, '/my/project');
    expect(result.entryPoints).toContain('src/index.ts');
  });

  it('returns empty modules for empty database', () => {
    const emptyDb = createTestDb();
    const result = getProjectOverview(emptyDb, '/empty');
    expect(result.stats.totalFiles).toBe(0);
    expect(result.modules).toHaveLength(0);
  });
});
