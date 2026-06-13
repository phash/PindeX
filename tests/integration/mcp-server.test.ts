import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { Indexer } from '../../src/indexer/index.js';
import { TokenLogger } from '../../src/monitoring/token-logger.js';
import { createMcpServer } from '../../src/server.js';
import { insertTestSession, insertTestFile, insertTestSymbol } from '../helpers/fixtures.js';
import { makeTestRepoSet } from '../helpers/repo-set.js';

/** Minimal helper to call a registered MCP tool handler directly. */
async function callTool(
  server: ReturnType<typeof createMcpServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<any> {
  // Access the internal handler by sending a mock request
  // We test the tool functions directly in unit tests;
  // here we verify the server wires them up correctly. A missing handler is
  // an SDK regression, so fail loudly rather than silently skipping.
  const handler = (server as any)._requestHandlers?.get('tools/call');
  expect(handler).toBeDefined();
  const result = await handler({ method: 'tools/call', params: { name: toolName, arguments: args } });
  return JSON.parse(result.content[0].text);
}

describe('MCP Server Integration', () => {
  let db: Database.Database;
  let indexer: Indexer;
  let testDir: string;

  beforeEach(() => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-int-test-${Date.now()}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'app.ts'), `
      export function greet(name: string): string {
        return 'Hello, ' + name;
      }
      export class AppService {
        run() {}
      }
    `);
    indexer = new Indexer({ db, projectRoot: testDir });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates an MCP server with tools registered', () => {
    const sessionId = uuidv4();
    insertTestSession(db, sessionId, 'indexed', 'Test');
    const emitter = new EventEmitter();
    const tokenLogger = new TokenLogger({ db, sessionId, emitter });
    const server = createMcpServer(db, indexer, tokenLogger, null, { projectRoot: testDir });
    expect(server).toBeTruthy();
  });

  it('server handles get_project_overview after indexing', async () => {
    // Index first
    await indexer.indexAll();

    const sessionId = uuidv4();
    insertTestSession(db, sessionId, 'indexed', 'Test');
    const emitter = new EventEmitter();
    const tokenLogger = new TokenLogger({ db, sessionId, emitter });
    const server = createMcpServer(db, indexer, tokenLogger, null, { projectRoot: testDir });

    // Call via the shared callTool helper (asserts the handler is wired up).
    const overview = await callTool(server, 'get_project_overview', {});
    expect(overview.rootPath).toBe(testDir);
  });
});

describe('Tool functions smoke test (via indexed project)', () => {
  let db: Database.Database;
  let indexer: Indexer;
  let testDir: string;

  beforeEach(async () => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-smoke-${Date.now()}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(
      join(testDir, 'src', 'auth.ts'),
      `export class AuthService { login(email: string): boolean { return true; } }`,
    );
    indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('search_symbols finds a known symbol', async () => {
    // This suite runs under the global tree-sitter mock (empty AST), so the
    // real indexAll() above extracts 0 symbols. Insert a symbol directly via
    // fixtures so the FTS5 path has something concrete to find — then assert
    // the search actually returns that symbol, not merely that it returns an
    // array.
    const fileId = insertTestFile(db, { path: 'src/known.ts' });
    insertTestSymbol(db, {
      fileId,
      name: 'KnownWidget',
      kind: 'class',
      signature: 'class KnownWidget {}',
      isExported: true,
    });

    const { searchSymbols } = await import('../../src/tools/search_symbols.js');
    const results = searchSymbols(makeTestRepoSet(db), { query: 'KnownWidget' });
    expect(Array.isArray(results)).toBe(true);
    expect(results.map((r) => r.name)).toContain('KnownWidget');
    const hit = results.find((r) => r.name === 'KnownWidget');
    expect(hit?.kind).toBe('class');
    expect(hit?.file).toBe('src/known.ts');
  });

  it('get_project_overview returns correct file count', async () => {
    const { getProjectOverview } = await import('../../src/tools/get_project_overview.js');
    const overview = getProjectOverview(makeTestRepoSet(db), testDir);
    expect(overview.stats.totalFiles).toBeGreaterThan(0);
  });

  it('reindex runs without error', async () => {
    const { reindex } = await import('../../src/tools/reindex.js');
    const result = await reindex(db, indexer, {});
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
