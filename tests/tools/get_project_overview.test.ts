import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol } from '../helpers/fixtures.js';
import { getProjectOverview } from '../../src/tools/get_project_overview.js';
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

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
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project');
    expect(result.rootPath).toBe('/my/project');
  });

  it('returns total file and symbol counts', () => {
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project');
    expect(result.stats.totalFiles).toBe(2);
    expect(result.stats.totalSymbols).toBe(3);
  });

  it('returns modules with symbol counts', () => {
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project');
    expect(result.modules).toHaveLength(2);
    const service = result.modules.find((m) => m.path === 'src/service.ts');
    expect(service).toBeDefined();
    expect(service!.symbolCount).toBe(2);
  });

  it('includes summary when available', () => {
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project');
    const index = result.modules.find((m) => m.path === 'src/index.ts');
    expect(index!.summary).toBe('Entry point');
  });

  it('detects TypeScript as the dominant language', () => {
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project');
    expect(result.language).toBe('typescript');
  });

  it('returns entryPoints containing index files', () => {
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project');
    expect(result.entryPoints).toContain('src/index.ts');
  });

  it('returns empty modules for empty database', () => {
    const emptyDb = createTestDb();
    const result = getProjectOverview(makeTestRepoSet(emptyDb), '/empty');
    expect(result.stats.totalFiles).toBe(0);
    expect(result.modules).toHaveLength(0);
  });
});

describe('getProjectOverview — federation', () => {
  let primaryDb: Database.Database;
  let federatedDb: Database.Database;

  beforeEach(() => {
    primaryDb = createTestDb();
    federatedDb = createTestDb();

    const pf1 = insertTestFile(primaryDb, { path: 'src/main.ts', language: 'typescript' });
    insertTestSymbol(primaryDb, { fileId: pf1, name: 'bootstrap', kind: 'function', signature: 'bootstrap(): void' });

    const ff1 = insertTestFile(federatedDb, { path: 'src/auth.ts', language: 'typescript' });
    insertTestSymbol(federatedDb, { fileId: ff1, name: 'login', kind: 'function', signature: 'login(): void' });
    insertTestSymbol(federatedDb, { fileId: ff1, name: 'logout', kind: 'function', signature: 'logout(): void' });
  });

  it('returns federated_projects with snapshots from each federated repo', () => {
    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );
    const result = getProjectOverview(repoSet, '/main');

    expect(result.project).toBe('main');
    expect(result.stats.totalFiles).toBe(1);
    expect(result.stats.totalSymbols).toBe(1);

    expect(result.federated_projects).toHaveLength(1);
    const authSnap = result.federated_projects![0];
    expect(authSnap.project).toBe('auth');
    expect(authSnap.stats.totalFiles).toBe(1);
    expect(authSnap.stats.totalSymbols).toBe(2);
  });

  it('scopes by repos param — only primary appears when scoped to primary name', () => {
    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );
    const result = getProjectOverview(repoSet, '/main', 'default', { repos: ['main'] });

    expect(result.project).toBe('main');
    expect(result.federated_projects).toBeUndefined();
  });

  it('scopes by repos param — only federated appears when scoped to federated name', () => {
    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );
    const result = getProjectOverview(repoSet, '/main', 'default', { repos: ['auth'] });

    // When primary isn't in scope, first snapshot becomes the "primary" in the output
    expect(result.project).toBe('auth');
    expect(result.stats.totalFiles).toBe(1);
    expect(result.stats.totalSymbols).toBe(2);
    expect(result.federated_projects).toBeUndefined();
  });
});
