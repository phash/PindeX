import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import open from 'open';
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
//
// The mock reads from mutable module-level state (mockRegistryList /
// mockPathResolver) so individual tests can reconfigure the registry and the
// DB-path resolution without re-mocking. The default state reproduces the
// original single-project fixture exactly, so the existing tests are unaffected.

const defaultRegistryEntry = {
  path: testProjectPath,
  hash: testHash,
  name: 'test-project',
  monitoringPort: 19999,
  federatedRepos: [] as string[],
  addedAt: '2025-01-01T00:00:00.000Z',
};

const defaultPathResolver = (projectPath: string): string => {
  if (projectPath === testProjectPath) return tmpDbPath;
  return join(projectPath, '.pindex', 'index.db');
};

// Mutable hooks reconfigured per-test (reset in beforeEach below).
let mockRegistryList: () => Array<typeof defaultRegistryEntry> = () => [
  { ...defaultRegistryEntry },
];
let mockPathResolver: (projectPath: string) => string = defaultPathResolver;

vi.mock('../../src/cli/project-detector.js', () => {
  class MockGlobalRegistry {
    list() {
      return mockRegistryList();
    }
  }

  return {
    GlobalRegistry: MockGlobalRegistry,
    getProjectIndexPath: (projectPath: string) => mockPathResolver(projectPath),
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

// ─── Shared reset for the parameterizable mock state ──────────────────────
// Every block below restores the default single-project registry + path
// resolver so tests stay independent regardless of execution order.
function resetMockState() {
  mockRegistryList = () => [{ ...defaultRegistryEntry }];
  mockPathResolver = defaultPathResolver;
}

// ─── SEC-04 / TST-08: POST /api/projects/:hash/open ───────────────────────

describe('POST /api/projects/:hash/open (SEC-04 / TST-08)', () => {
  let app: ReturnType<typeof createGuiApp>;
  const savedBindHost = process.env.PINDEX_BIND_HOST;

  beforeEach(() => {
    resetMockState();
    // Ensure loopback enforcement is ON (Origin check active).
    delete process.env.PINDEX_BIND_HOST;
    vi.mocked(open).mockClear();
    vi.mocked(open).mockResolvedValue(undefined as never);
    app = createGuiApp();
  });

  afterEach(() => {
    if (savedBindHost === undefined) delete process.env.PINDEX_BIND_HOST;
    else process.env.PINDEX_BIND_HOST = savedBindHost;
    vi.mocked(open).mockReset();
    vi.mocked(open).mockResolvedValue(undefined as never);
  });

  it('GET .../open returns 404 (route is POST-only now)', async () => {
    const res = await request(app).get(`/api/projects/${testHash}/open`);
    expect(res.status).toBe(404);
  });

  it('POST .../open returns 404 for unknown hash', async () => {
    const res = await request(app).post('/api/projects/nope-unknown/open');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('project not found');
  });

  it('POST .../open returns 200 {ok:true} and calls open() with the project path', async () => {
    const res = await request(app).post(`/api/projects/${testHash}/open`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(open)).toHaveBeenCalledWith(testProjectPath);
  });

  it('POST .../open returns 500 when open() rejects', async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error('x'));
    const res = await request(app).post(`/api/projects/${testHash}/open`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('failed to open folder');
  });

  it('POST .../open rejects a cross-site Origin with 403 (SEC-04)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testHash}/open`)
      .set('Origin', 'http://evil.com');
    expect(res.status).toBe(403);
    // open() must never fire for a forged cross-origin request.
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });
});

// ─── TST-07: resilience to missing / corrupt DBs and empty registry ───────

describe('GUI resilience (TST-07)', () => {
  const extraTmp = join(
    tmpdir(),
    `pindex-gui-resilience-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  beforeEach(() => {
    resetMockState();
    mkdirSync(extraTmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(extraTmp, { recursive: true, force: true });
  });

  it('missing index.db -> dbExists:false and /detail returns empty arrays (200)', async () => {
    const missingHash = 'missing01';
    const missingProjectPath = join(extraTmp, 'missing-project');
    const missingDbPath = join(missingProjectPath, '.pindex', 'index.db');
    expect(existsSync(missingDbPath)).toBe(false);

    mockRegistryList = () => [
      {
        ...defaultRegistryEntry,
        path: missingProjectPath,
        hash: missingHash,
        name: 'missing-project',
      },
    ];
    mockPathResolver = (p) => (p === missingProjectPath ? missingDbPath : defaultPathResolver(p));

    const app = createGuiApp();

    const projects = await request(app).get('/api/projects');
    expect(projects.status).toBe(200);
    expect(projects.body[0].dbExists).toBe(false);
    expect(projects.body[0].fileCount).toBe(0);

    const detail = await request(app).get(`/api/projects/${missingHash}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({ files: [], symbols: [], tokenLog: [] });
  });

  it('corrupt DB -> loadProjectStats degrades to dbExists:false, /detail returns 200 empty arrays', async () => {
    const corruptHash = 'corrupt01';
    const corruptProjectPath = join(extraTmp, 'corrupt-project');
    const corruptDbDir = join(corruptProjectPath, '.pindex');
    const corruptDbPath = join(corruptDbDir, 'index.db');
    mkdirSync(corruptDbDir, { recursive: true });
    // Non-SQLite garbage bytes: opening/querying must throw, not crash the route.
    writeFileSync(corruptDbPath, 'this is definitely not a sqlite database file ');

    mockRegistryList = () => [
      {
        ...defaultRegistryEntry,
        path: corruptProjectPath,
        hash: corruptHash,
        name: 'corrupt-project',
      },
    ];
    mockPathResolver = (p) => (p === corruptProjectPath ? corruptDbPath : defaultPathResolver(p));

    const app = createGuiApp();

    const projects = await request(app).get('/api/projects');
    expect(projects.status).toBe(200);
    expect(projects.body[0].dbExists).toBe(false);
    expect(projects.body[0].fileCount).toBe(0);
    expect(projects.body[0].symbolCount).toBe(0);

    const detail = await request(app).get(`/api/projects/${corruptHash}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({ files: [], symbols: [], tokenLog: [] });
  });

  it('empty registry -> /api/overview has totalProjects:0 and avgSavingsPercent:0', async () => {
    mockRegistryList = () => [];
    const app = createGuiApp();

    const res = await request(app).get('/api/overview');
    expect(res.status).toBe(200);
    expect(res.body.overview.totalProjects).toBe(0);
    expect(res.body.overview.avgSavingsPercent).toBe(0);
    expect(res.body.projects).toEqual([]);
  });
});

// ─── SEC-03: Host-header guard (DNS-rebinding protection) ─────────────────

describe('Host guard (SEC-03)', () => {
  const savedBindHost = process.env.PINDEX_BIND_HOST;
  let app: ReturnType<typeof createGuiApp>;

  beforeEach(() => {
    resetMockState();
    delete process.env.PINDEX_BIND_HOST; // enforcement ON
    app = createGuiApp();
  });

  afterEach(() => {
    if (savedBindHost === undefined) delete process.env.PINDEX_BIND_HOST;
    else process.env.PINDEX_BIND_HOST = savedBindHost;
  });

  it('rejects a non-loopback Host header with 403', async () => {
    const res = await request(app).get('/api/overview').set('Host', 'evil.com');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('allows the default loopback Host (127.0.0.1) with 200', async () => {
    const res = await request(app).get('/api/overview');
    expect(res.status).toBe(200);
  });
});

// ─── TST-05: startGuiServer binds loopback ────────────────────────────────

describe('startGuiServer (TST-05)', () => {
  const savedBindHost = process.env.PINDEX_BIND_HOST;

  beforeEach(() => {
    resetMockState();
    delete process.env.PINDEX_BIND_HOST;
  });

  afterEach(() => {
    if (savedBindHost === undefined) delete process.env.PINDEX_BIND_HOST;
    else process.env.PINDEX_BIND_HOST = savedBindHost;
  });

  it('binds to 127.0.0.1 on an ephemeral port', async () => {
    const { startGuiServer } = await import('../../src/gui/server.js');
    // Port 0 lets the OS pick a free ephemeral port.
    const server = await startGuiServer(0);
    try {
      const addr = server.httpServer.address();
      expect(addr).not.toBeNull();
      // address() returns an AddressInfo object when listening on a TCP socket.
      expect(typeof addr).toBe('object');
      expect((addr as { address: string }).address).toBe('127.0.0.1');
    } finally {
      await server.close();
    }
  });
});
