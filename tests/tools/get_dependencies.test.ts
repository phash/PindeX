import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestDependency } from '../helpers/fixtures.js';
import { getDependencies } from '../../src/tools/get_dependencies.js';

describe('getDependencies', () => {
  let db: Database.Database;
  let fileA: number; // src/app.ts
  let fileB: number; // src/service.ts
  let fileC: number; // src/utils.ts

  beforeEach(() => {
    db = createTestDb();
    fileA = insertTestFile(db, { path: 'src/app.ts' });
    fileB = insertTestFile(db, { path: 'src/service.ts' });
    fileC = insertTestFile(db, { path: 'src/utils.ts' });
    // app.ts → service.ts → utils.ts
    insertTestDependency(db, fileA, fileB, 'MyService');
    insertTestDependency(db, fileB, fileC, 'helper');
  });

  it('returns files that a target imports (direction=imports)', () => {
    const result = getDependencies(db, { target: 'src/app.ts', direction: 'imports' });
    expect(result.imports).toContain('src/service.ts');
    expect(result.importedBy).toHaveLength(0);
  });

  it('returns files that import the target (direction=imported_by)', () => {
    const result = getDependencies(db, { target: 'src/service.ts', direction: 'imported_by' });
    expect(result.importedBy).toContain('src/app.ts');
    expect(result.imports).toHaveLength(0);
  });

  it('returns both directions when direction=both', () => {
    const result = getDependencies(db, { target: 'src/service.ts', direction: 'both' });
    expect(result.imports).toContain('src/utils.ts');
    expect(result.importedBy).toContain('src/app.ts');
  });

  it('defaults to both direction when not specified', () => {
    const result = getDependencies(db, { target: 'src/service.ts' });
    expect(result.imports).toContain('src/utils.ts');
    expect(result.importedBy).toContain('src/app.ts');
  });

  it('returns empty arrays for an unknown target', () => {
    const result = getDependencies(db, { target: 'src/ghost.ts' });
    expect(result.imports).toHaveLength(0);
    expect(result.importedBy).toHaveLength(0);
  });
});
