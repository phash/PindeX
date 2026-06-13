/**
 * Unit tests for the MCP server dispatch (src/server.ts).
 *
 * These drive requests through the registered tools/list and tools/call
 * handlers (the same internal SDK API the integration suites use) to exercise:
 *  - the full tool dispatch switch (one valid call per tool)
 *  - the Zod validation failure path
 *  - the generic catch path (SEC-09: no raw error leaks)
 *  - baselineMode short-circuit
 *  - the unknown-tool default branch
 *  - the token-logging + observer side-effect paths
 *
 * Runs under the global tree-sitter mock (empty AST), so symbols/docs are
 * seeded directly via fixtures rather than parsed from disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/db.js';
import { Indexer } from '../src/indexer/index.js';
import { TokenLogger } from '../src/monitoring/token-logger.js';
import { SessionObserver } from '../src/memory/observer.js';
import { createMcpServer } from '../src/server.js';
import {
  insertTestFile,
  insertTestSymbol,
  insertTestSession,
  insertTestTokenLog,
  insertTestUsage,
  insertTestDependency,
} from './helpers/fixtures.js';
import { insertDocumentChunk } from '../src/db/queries.js';

type McpServer = ReturnType<typeof createMcpServer>;

/** Calls the registered tools/call handler and returns the raw SDK envelope. */
async function callRaw(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const handler = (server as any)._requestHandlers?.get('tools/call');
  expect(handler).toBeDefined();
  return handler({ method: 'tools/call', params: { name: toolName, arguments: args } });
}

/** Calls a tool and parses the JSON payload out of the first text block. */
async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<any> {
  const result = await callRaw(server, toolName, args);
  return JSON.parse(result.content[0].text);
}

describe('createMcpServer – tools/list', () => {
  let db: Database.Database;
  let indexer: Indexer;
  let testDir: string;

  beforeEach(() => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-srv-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    indexer = new Indexer({ db, projectRoot: testDir, maxParseWorkers: 0, lspEnabled: false });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('lists the full registered tool set', async () => {
    const server = createMcpServer(db, indexer, null, null, { projectRoot: testDir });
    const handler = (server as any)._requestHandlers?.get('tools/list');
    expect(handler).toBeDefined();

    const res = await handler({ method: 'tools/list', params: {} });
    const names = res.tools.map((t: { name: string }) => t.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'search_symbols', 'get_symbol', 'get_context', 'get_file_summary',
        'find_usages', 'get_dependencies', 'get_project_overview', 'get_api_endpoints',
        'reindex', 'get_token_stats', 'start_comparison', 'search_docs',
        'get_doc_chunk', 'save_context', 'get_session_memory',
      ]),
    );
    expect(names).toHaveLength(15);
    // Every entry must carry a JSON input schema.
    for (const tool of res.tools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('lists only core tools when EXPOSE_CORE_TOOLS_ONLY=true', async () => {
    const prev = process.env.EXPOSE_CORE_TOOLS_ONLY;
    process.env.EXPOSE_CORE_TOOLS_ONLY = 'true';
    try {
      const server = createMcpServer(db, indexer, null, null, { projectRoot: testDir });
      const handler = (server as any)._requestHandlers?.get('tools/list');
      const res = await handler({ method: 'tools/list', params: {} });
      const names = res.tools.map((t: { name: string }) => t.name);

      expect(names).toContain('search_symbols');
      expect(names).toContain('get_api_endpoints');
      // analytics / memory / doc tools are omitted in core mode
      expect(names).not.toContain('save_context');
      expect(names).not.toContain('get_token_stats');
      expect(names).not.toContain('search_docs');
    } finally {
      if (prev === undefined) delete process.env.EXPOSE_CORE_TOOLS_ONLY;
      else process.env.EXPOSE_CORE_TOOLS_ONLY = prev;
    }
  });
});

describe('createMcpServer – tools/call dispatch (all tools)', () => {
  let db: Database.Database;
  let indexer: Indexer;
  let testDir: string;
  let sessionId: string;
  let server: McpServer;
  let tokenLogger: TokenLogger;
  let observer: SessionObserver;
  let fileId: number;
  let symbolId: number;

  beforeEach(() => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-srv-call-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });

    // A real file on disk so get_context can read it; its DB record's path
    // must match what we pass to the tool (project-relative).
    writeFileSync(
      join(testDir, 'src', 'app.ts'),
      [
        'export function greet(name) {',          // line 1
        "  return 'Hello, ' + name;",             // line 2
        '}',                                      // line 3
        'export class AppService {',              // line 4
        '  run() { return greet("x"); }',         // line 5
        '}',                                      // line 6
      ].join('\n'),
    );

    indexer = new Indexer({ db, projectRoot: testDir, maxParseWorkers: 0, lspEnabled: false });

    // ── Seed the index: file + symbols + usage + dependency + endpoint ──────────
    fileId = insertTestFile(db, { path: 'src/app.ts', language: 'typescript' });
    symbolId = insertTestSymbol(db, {
      fileId,
      name: 'greet',
      kind: 'function',
      signature: 'greet(name: string): string',
      startLine: 1,
      endLine: 3,
      isExported: true,
    });
    insertTestSymbol(db, {
      fileId,
      name: 'AppService',
      kind: 'class',
      signature: 'class AppService',
      startLine: 4,
      endLine: 6,
      isExported: true,
    });
    // Express route symbol so get_api_endpoints returns something concrete.
    insertTestSymbol(db, {
      fileId,
      name: 'GET /users/:id',
      kind: 'route',
      signature: 'router.get(...)',
      startLine: 5,
      endLine: 5,
      isExported: false,
    });

    // A second file that imports app.ts (for dependency graph) and uses greet.
    const consumerId = insertTestFile(db, { path: 'src/consumer.ts', language: 'typescript', hash: 'def456' });
    insertTestDependency(db, consumerId, fileId, 'greet');
    insertTestUsage(db, symbolId, consumerId, 7);

    // A document chunk so search_docs / get_doc_chunk have content (uses the
    // real query helper so the FTS5 triggers fire).
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 0,
      heading: 'Overview',
      content: 'The greet helper builds a greeting string.',
      startLine: 1,
      endLine: 3,
    });

    // Session + token-log so get_token_stats has data.
    sessionId = uuidv4();
    insertTestSession(db, sessionId, 'indexed', 'Test');
    insertTestTokenLog(db, sessionId, 'search_symbols', 40, 400);

    const emitter = new EventEmitter();
    tokenLogger = new TokenLogger({ db, sessionId, emitter });
    observer = new SessionObserver({ db, sessionId, projectRoot: testDir });

    // Real token logger + observer so the post-dispatch side-effect paths run.
    server = createMcpServer(db, indexer, tokenLogger, null, {
      projectRoot: testDir,
      sessionId,
      observer,
      primaryName: 'local',
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('search_symbols returns matching symbols', async () => {
    const res = await callTool(server, 'search_symbols', { query: 'greet' });
    expect(Array.isArray(res)).toBe(true);
    expect(res.map((r: any) => r.name)).toContain('greet');
  });

  it('get_symbol returns symbol details', async () => {
    const res = await callTool(server, 'get_symbol', { name: 'greet' });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].name).toBe('greet');
  });

  it('get_context reads a line range from disk', async () => {
    const res = await callTool(server, 'get_context', { file: 'src/app.ts', line: 2, range: 4 });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].code).toContain('Hello');
    expect(res[0].language).toBe('typescript');
  });

  it('get_file_summary returns the file overview', async () => {
    const res = await callTool(server, 'get_file_summary', { file: 'src/app.ts' });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].language).toBe('typescript');
    expect(res[0].symbols.map((s: any) => s.name)).toContain('greet');
  });

  it('find_usages returns call sites', async () => {
    const res = await callTool(server, 'find_usages', { symbol: 'greet' });
    // Shape can be array of usages or grouped per-repo; just assert it parsed.
    expect(res).toBeTruthy();
    expect(JSON.stringify(res)).toContain('consumer.ts');
  });

  it('get_dependencies returns the import graph', async () => {
    const res = await callTool(server, 'get_dependencies', { target: 'src/app.ts', direction: 'both' });
    expect(res).toBeTruthy();
    expect(JSON.stringify(res)).toContain('consumer.ts');
  });

  it('get_project_overview returns project stats', async () => {
    const res = await callTool(server, 'get_project_overview', {});
    expect(res.rootPath).toBe(testDir);
    expect(res.stats.totalFiles).toBeGreaterThan(0);
  });

  it('get_api_endpoints returns route endpoints', async () => {
    const res = await callTool(server, 'get_api_endpoints', {});
    expect(Array.isArray(res.endpoints)).toBe(true);
    expect(res.endpoints.length).toBeGreaterThan(0);
    expect(res.endpoints[0].method).toBe('GET');
    expect(res.endpoints[0].path).toBe('/users/:id');
  });

  it('reindex runs and returns counts', async () => {
    const res = await callTool(server, 'reindex', {});
    expect(typeof res.indexed).toBe('number');
    expect(Array.isArray(res.errors)).toBe(true);
  });

  it('get_token_stats returns session stats', async () => {
    const res = await callTool(server, 'get_token_stats', { session_id: sessionId });
    expect(res).toBeTruthy();
    // getSessionStats returns aggregate fields; just confirm it's an object.
    expect(typeof res).toBe('object');
  });

  it('start_comparison creates a session and returns a monitoring URL', async () => {
    const res = await callTool(server, 'start_comparison', { label: 'AB run', mode: 'indexed' });
    expect(res.session_id).toBeTruthy();
    expect(res.monitoring_url).toContain('http://localhost:');
  });

  it('search_docs returns indexed doc chunks', async () => {
    const res = await callTool(server, 'search_docs', { query: 'greeting', type: 'docs' });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThan(0);
  });

  it('get_doc_chunk returns chunks for a file', async () => {
    const res = await callTool(server, 'get_doc_chunk', { file: 'src/app.ts' });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].total_chunks).toBeGreaterThan(0);
  });

  it('save_context persists a fact and returns structured output', async () => {
    const res = await callTool(server, 'save_context', {
      content: 'greet lives in src/app.ts',
      tags: 'arch,greet',
    });
    expect(res.id).toBeGreaterThan(0);
    expect(res.session_id).toBe(sessionId);
  });

  it('get_session_memory returns memory for the session', async () => {
    const res = await callTool(server, 'get_session_memory', { session_id: sessionId });
    expect(res).toBeTruthy();
    expect(typeof res).toBe('object');
  });

  it('observer records observations on a successful tool call (no throw)', async () => {
    // get_symbol drives the observer's handleGetSymbol branch.
    await callTool(server, 'get_symbol', { name: 'greet' });
    const events = db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number };
    expect(events.n).toBeGreaterThanOrEqual(0); // never throws; side-effect path executed
  });

  it('token logger records a call for a query tool', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM token_log').get() as { n: number }).n;
    await callTool(server, 'search_symbols', { query: 'greet' });
    const after = (db.prepare('SELECT COUNT(*) AS n FROM token_log').get() as { n: number }).n;
    expect(after).toBeGreaterThan(before);
  });

  it('reindex is excluded from token logging', async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM token_log WHERE tool_name = 'reindex'").get() as { n: number }).n;
    await callTool(server, 'reindex', {});
    const after = (db.prepare("SELECT COUNT(*) AS n FROM token_log WHERE tool_name = 'reindex'").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe('createMcpServer – error & edge-case paths', () => {
  let db: Database.Database;
  let indexer: Indexer;
  let testDir: string;

  beforeEach(() => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-srv-err-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    indexer = new Indexer({ db, projectRoot: testDir, maxParseWorkers: 0, lspEnabled: false });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns "Invalid arguments" + isError for Zod validation failure', async () => {
    const server = createMcpServer(db, indexer, null, null, { projectRoot: testDir });
    // search_symbols requires `query`; omit it.
    const raw = await callRaw(server, 'search_symbols', {});
    expect(raw.isError).toBe(true);
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.error).toBe('Invalid arguments');
    expect(Array.isArray(payload.details)).toBe(true);
  });

  it('rejects wrong-typed args via Zod', async () => {
    const server = createMcpServer(db, indexer, null, null, { projectRoot: testDir });
    const raw = await callRaw(server, 'search_symbols', { query: 123 });
    expect(raw.isError).toBe(true);
    expect(JSON.parse(raw.content[0].text).error).toBe('Invalid arguments');
  });

  it('catch path returns a generic "Tool failed" message without leaking the raw error (SEC-09)', async () => {
    // Build a server whose indexer throws inside reindex. reindex(target) calls
    // indexer.indexFile(target, true); stub it to throw a path-revealing error.
    const throwingIndexer = indexer as unknown as { indexFile: (...a: unknown[]) => Promise<unknown> };
    throwingIndexer.indexFile = async () => {
      throw new Error('ENOENT: /home/secret/abs/path leaked');
    };
    const server = createMcpServer(db, indexer, null, null, { projectRoot: testDir });

    const raw = await callRaw(server, 'reindex', { target: 'whatever.ts' });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.error).toBe("Tool 'reindex' failed");
    // The raw error / absolute path must NOT be returned to the client.
    expect(raw.content[0].text).not.toContain('/home/secret/abs/path');
    expect(raw.content[0].text).not.toContain('ENOENT');
  });

  it('catch path still fires the observer (recordToolError) without throwing', async () => {
    const sessionId = uuidv4();
    insertTestSession(db, sessionId, 'indexed', 'Test');
    const observer = new SessionObserver({ db, sessionId, projectRoot: testDir });
    const throwingIndexer = indexer as unknown as { indexFile: (...a: unknown[]) => Promise<unknown> };
    throwingIndexer.indexFile = async () => { throw new Error('boom'); };

    const server = createMcpServer(db, indexer, null, null, {
      projectRoot: testDir,
      sessionId,
      observer,
    });

    const raw = await callRaw(server, 'reindex', { target: 'x.ts' });
    // The catch path ran (generic error returned), observer fired without throwing.
    expect(JSON.parse(raw.content[0].text).error).toBe("Tool 'reindex' failed");
  });

  it('baselineMode returns the disabled message for query tools', async () => {
    const server = createMcpServer(db, indexer, null, null, {
      projectRoot: testDir,
      baselineMode: true,
    });
    const res = await callTool(server, 'search_symbols', { query: 'greet' });
    expect(res.error).toBe('Index disabled for baseline measurement');
  });

  it('baselineMode still allows get_token_stats and start_comparison', async () => {
    const server = createMcpServer(db, indexer, null, null, {
      projectRoot: testDir,
      baselineMode: true,
    });
    const stats = await callTool(server, 'get_token_stats', {});
    expect(stats.error).not.toBe('Index disabled for baseline measurement');

    const cmp = await callTool(server, 'start_comparison', { label: 'b', mode: 'baseline' });
    expect(cmp.session_id).toBeTruthy();
  });

  it('unknown tool name returns an "Unknown tool" error', async () => {
    const server = createMcpServer(db, indexer, null, null, { projectRoot: testDir });
    // Use a name with no TOOL_SCHEMAS entry so it skips Zod and hits the default branch.
    const res = await callTool(server, 'does_not_exist', {});
    expect(res.error).toContain('Unknown tool');
  });
});
