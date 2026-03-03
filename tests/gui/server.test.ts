import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import {
  insertTestFile,
  insertTestSymbol,
  insertTestSession,
  insertTestTokenLog,
} from '../helpers/fixtures.js';

// ─── Setup: create a real temp DB file for the gui app to read ────────────

const tmpBase = join(
  tmpdir(),
  `pindex-gui-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
const testProjectPath = join(tmpBase, 'test-project');
const testPindexDir = join(testProjectPath, '.pindex');
const tmpDbPath = join(testPindexDir, 'index.db');
const testHash = 'deadbeef';

// Create the real DB and populate it before mocking
mkdirSync(testPindexDir, { recursive: true });
const setupDb = new Database(tmpDbPath);
setupDb.pragma('journal_mode = WAL');
setupDb.pragma('foreign_keys = ON');
runMigrations(setupDb);

// Insert test data
const fileId = insertTestFile(setupDb, {
  path: 'src/app.ts',
  language: 'typescript',
  rawTokenEstimate: 200,
});
insertTestSymbol(setupDb, {
  fileId,
  name: 'main',
  kind: 'function',
  signature: 'main(): void',
  startLine: 1,
  endLine: 10,
});
insertTestSession(setupDb, 'sess-gui-1', 'indexed', 'GUI Test Session');
insertTestTokenLog(setupDb, 'sess-gui-1', 'search_symbols', 100, 1000);
setupDb.close();

// ─── Mock project-detector so createGuiApp uses our test DB ───────────────

vi.mock('../../src/cli/project-detector.js', () => {
  class MockGlobalRegistry {
    list() {
      return [
        {
          path: testProjectPath,
          hash: testHash,
          name: 'test-project',
          monitoringPort: 19999,
          federatedRepos: [],
          addedAt: '2025-01-01T00:00:00.000Z',
        },
      ];
    }
  }

  return {
    GlobalRegistry: MockGlobalRegistry,
    getProjectIndexPath: (projectPath: string) => {
      if (projectPath === testProjectPath) return tmpDbPath;
      return join(projectPath, '.pindex', 'index.db');
    },
  };
});

// Dynamically import after mocks are set up
const { createGuiApp } = await import('../../src/gui/server.js');
const request = (await import('supertest')).default;

describe('createGuiApp', () => {
  let app: ReturnType<typeof createGuiApp>;

  beforeAll(() => {
    app = createGuiApp();
  });

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('GET / returns 200 with HTML', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('PindeX');
  });

  it('GET /api/projects returns 200 with array', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const project = res.body[0];
    expect(project.entry.name).toBe('test-project');
    expect(project.entry.hash).toBe(testHash);
    expect(project.dbExists).toBe(true);
    expect(project.fileCount).toBe(1);
    expect(project.symbolCount).toBe(1);
  });

  it('GET /api/projects/:hash/detail returns 200 with files/symbols for known hash', async () => {
    const res = await request(app).get(`/api/projects/${testHash}/detail`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.files)).toBe(true);
    expect(Array.isArray(res.body.symbols)).toBe(true);
    expect(Array.isArray(res.body.tokenLog)).toBe(true);
    expect(res.body.files.length).toBe(1);
    expect(res.body.files[0].path).toBe('src/app.ts');
    expect(res.body.symbols.length).toBe(1);
    expect(res.body.symbols[0].name).toBe('main');
  });

  it('GET /api/projects/:hash/detail returns 404 for unknown hash', async () => {
    const res = await request(app).get('/api/projects/unknown123/detail');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('project not found');
  });

  it('GET /api/projects/:hash/sessions returns 200 with sessions', async () => {
    const res = await request(app).get(`/api/projects/${testHash}/sessions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].id).toBe('sess-gui-1');
  });

  it('GET /api/projects/:hash/sessions returns 404 for unknown hash', async () => {
    const res = await request(app).get('/api/projects/unknown123/sessions');
    expect(res.status).toBe(404);
  });

  it('GET /api/sessions/recent returns 200 with sessions array', async () => {
    const res = await request(app).get('/api/sessions/recent');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const session = res.body[0];
    expect(session.sessionId).toBe('sess-gui-1');
    expect(session.projectName).toBe('test-project');
    expect(session.projectHash).toBe(testHash);
    expect(session.mode).toBe('indexed');
  });

  it('GET /api/overview returns 200 with overview stats', async () => {
    const res = await request(app).get('/api/overview');
    expect(res.status).toBe(200);
    expect(res.body.overview).toBeDefined();
    expect(res.body.overview.totalProjects).toBe(1);
    expect(res.body.overview.totalFiles).toBe(1);
    expect(res.body.overview.totalSymbols).toBe(1);
    expect(res.body.overview.totalSessions).toBe(1);
    expect(Array.isArray(res.body.projects)).toBe(true);
    // serverRunning should be false since no actual server is listening
    expect(res.body.projects[0].serverRunning).toBe(false);
  });
});
