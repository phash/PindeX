import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol, insertTestRef, insertTestDependency } from '../helpers/fixtures.js';
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

  it('groups modules by directory with file and symbol counts', () => {
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project');
    expect(result.modules).toEqual([
      { dir: 'src', files: 2, symbols: 3, summaries: [{ path: 'src/index.ts', summary: 'Entry point' }] },
    ]);
  });

  it('brief mode has no modules key', () => {
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project', 'default', { mode: 'brief' });
    expect('modules' in result).toBe(false);
    expect(result.stats.totalFiles).toBe(2);
    expect(result.stats.totalSymbols).toBe(3);
  });

  it('full mode on 120 files in 3 dirs yields at most 3 groups, root files grouped under "."', () => {
    const big = createTestDb();
    for (let i = 0; i < 40; i++) {
      for (const d of ['src/a', 'src/b', 'lib/c/deep']) insertTestFile(big, { path: `${d}/f${i}.ts` });
    }
    insertTestFile(big, { path: 'index.ts' });
    const result = getProjectOverview(makeTestRepoSet(big), '/big');
    const dirs = result.modules!.map((m) => m.dir).sort();
    expect(dirs).toEqual(['.', 'lib/c', 'src/a', 'src/b']);
    expect(result.modules!.find((m) => m.dir === 'src/a')!.files).toBe(40);
    expect(result.modules!.every((m) => m.summaries === undefined)).toBe(true);
  });

  it('caps groups at 50, sorted by symbols desc then dir asc', () => {
    const big = createTestDb();
    for (let i = 0; i < 60; i++) {
      const id = insertTestFile(big, { path: `d${String(i).padStart(2, '0')}/x/f.ts` });
      if (i === 59) insertTestSymbol(big, { fileId: id, name: 'top', kind: 'function', signature: 'top()' });
    }
    const result = getProjectOverview(makeTestRepoSet(big), '/big');
    expect(result.modules).toHaveLength(50);
    expect(result.modules![0].dir).toBe('d59/x');
    expect(result.modules![1].dir).toBe('d00/x');
  });

  it('detects TypeScript as the dominant language', () => {
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project');
    expect(result.language).toBe('typescript');
  });

  it('returns entryPoints containing index files', () => {
    const result = getProjectOverview(makeTestRepoSet(db), '/my/project');
    expect(result.entryPoints).toContain('src/index.ts');
  });

  it('returns no modules for empty database', () => {
    const emptyDb = createTestDb();
    const result = getProjectOverview(makeTestRepoSet(emptyDb), '/empty');
    expect(result.stats.totalFiles).toBe(0);
    expect(result.modules ?? []).toHaveLength(0);
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

describe('getProjectOverview — index_recommendation (TST-14)', () => {
  // Constants pinned from src/tools/get_project_overview.ts:
  //   BREAK_EVEN_FILES = 40, BREAK_EVEN_AVG_LINES = 150
  //   avgFileTokens = SUM(raw_token_estimate) / files.length
  //   avgFileLinesEstimate = Math.round(avgFileTokens * 4 / 50)
  //   worthwhile = files.length >= 40 || avgFileLinesEstimate >= 150
  const BREAK_EVEN_FILES = 40;

  it('marks a small low-token project as NOT worthwhile with the "Small project" reason', () => {
    const db = createTestDb();
    // 3 files, each raw_token_estimate=100 → avgTokens=100 → avgLines=round(100*4/50)=8
    insertTestFile(db, { path: 'src/a.ts', language: 'typescript', rawTokenEstimate: 100 });
    insertTestFile(db, { path: 'src/b.ts', language: 'typescript', rawTokenEstimate: 100 });
    insertTestFile(db, { path: 'src/c.ts', language: 'typescript', rawTokenEstimate: 100 });

    const result = getProjectOverview(makeTestRepoSet(db), '/small');
    const rec = result.index_recommendation;
    expect(rec).toBeDefined();
    expect(rec!.worthwhile).toBe(false);
    expect(rec!.avgFileLinesEstimate).toBe(8);
    expect(rec!.breakEvenFiles).toBe(BREAK_EVEN_FILES);
    expect(rec!.reason).toBe(
      'Small project (3 files, avg ~8 lines/file) — direct reads may be more efficient than index overhead',
    );
  });

  it('marks a project with >=40 files as worthwhile (file-count threshold)', () => {
    const db = createTestDb();
    for (let i = 0; i < 40; i++) {
      insertTestFile(db, { path: `src/file${i}.ts`, language: 'typescript', rawTokenEstimate: 100 });
    }
    const result = getProjectOverview(makeTestRepoSet(db), '/big');
    const rec = result.index_recommendation;
    expect(rec).toBeDefined();
    expect(rec!.worthwhile).toBe(true);
    // avgTokens=100 → avgLines=8, still below 150, so worthwhile is driven by file count.
    expect(rec!.avgFileLinesEstimate).toBe(8);
    expect(rec!.breakEvenFiles).toBe(BREAK_EVEN_FILES);
    expect(rec!.reason).toBe('40 files, avg ~8 lines/file — index tools save tokens');
  });

  it('marks a small project worthwhile when avg lines/file >= 150 (avg-lines threshold)', () => {
    const db = createTestDb();
    // 2 files, raw_token_estimate=2000 → avgTokens=2000 → avgLines=round(2000*4/50)=160 (>=150)
    insertTestFile(db, { path: 'src/big1.ts', language: 'typescript', rawTokenEstimate: 2000 });
    insertTestFile(db, { path: 'src/big2.ts', language: 'typescript', rawTokenEstimate: 2000 });

    const result = getProjectOverview(makeTestRepoSet(db), '/dense');
    const rec = result.index_recommendation;
    expect(rec).toBeDefined();
    expect(rec!.worthwhile).toBe(true);
    expect(rec!.avgFileLinesEstimate).toBe(160);
    expect(rec!.breakEvenFiles).toBe(BREAK_EVEN_FILES);
    expect(rec!.reason).toBe('2 files, avg ~160 lines/file — index tools save tokens');
  });

  it('pins the avgFileLinesEstimate arithmetic: round(avgTokens * 4 / 50)', () => {
    const db = createTestDb();
    // single file, raw_token_estimate=625 → 625*4/50 = 50 exactly
    insertTestFile(db, { path: 'src/calc.ts', language: 'typescript', rawTokenEstimate: 625 });
    const result = getProjectOverview(makeTestRepoSet(db), '/calc');
    expect(result.index_recommendation!.avgFileLinesEstimate).toBe(50);
  });

  describe('hubs and communities', () => {
    function graphDb(): Database.Database {
      const g = createTestDb();
      const lib = insertTestFile(g, { path: 'src/lib/util.ts' });
      const lib2 = insertTestFile(g, { path: 'src/lib/more.ts' });
      insertTestSymbol(g, { fileId: lib, name: 'util', kind: 'function', startLine: 1, endLine: 2 });
      insertTestDependency(g, lib2, lib);
      for (let i = 0; i < 3; i++) {
        const f = insertTestFile(g, { path: `src/app/c${i}.ts` });
        insertTestRef(g, f, 'util', 5);
      }
      return g;
    }

    it('brief mode has no hubs/communities', () => {
      const r = getProjectOverview(makeTestRepoSet(graphDb()), '/p', 'default', { mode: 'brief' });
      expect('hubs' in r).toBe(false);
      expect('communities' in r).toBe(false);
    });

    it('full mode returns hubs and communities when edges exist', () => {
      const r = getProjectOverview(makeTestRepoSet(graphDb()), '/p', 'default', { mode: 'full' });
      expect(r.hubs).toEqual([{ symbol: 'util', file: 'src/lib/util.ts', callerFiles: 3 }]);
      expect(r.hubs!.length).toBeLessThanOrEqual(10);
      expect(r.communities!.length).toBeGreaterThan(0);
      expect(r.communities![0].size).toBeGreaterThan(1);
      const all = r.communities!.flatMap((c) => c.topFiles);
      expect(all).toContain('src/lib/util.ts');
      expect(r.communities!.some((c) => c.label.startsWith('src'))).toBe(true);
    });

    it('omits hubs/communities when the project has no edges', () => {
      const plain = createTestDb();
      insertTestFile(plain, { path: 'src/a.ts' });
      const r = getProjectOverview(makeTestRepoSet(plain), '/p');
      expect('hubs' in r).toBe(false);
      expect('communities' in r).toBe(false);
    });
  });
});
