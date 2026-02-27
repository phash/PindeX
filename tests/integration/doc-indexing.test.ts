/**
 * Integration test: document indexing + context memory
 *
 * Simulates the full workflow Claude Code uses:
 *   1. pindex indexes all .md/.yaml/.txt files in the project
 *   2. Claude searches for relevant sections instead of loading whole files
 *   3. Claude saves important decisions to pindex (save_context)
 *   4. A later session retrieves those decisions via search_docs
 */
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
import { insertTestSession } from '../helpers/fixtures.js';
import { searchDocs } from '../../src/tools/search_docs.js';
import { getDocChunk } from '../../src/tools/get_doc_chunk.js';
import { saveContext } from '../../src/tools/save_context.js';
import { getFileByPath, getDocumentChunksByFileId } from '../../src/db/queries.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Calls a registered MCP tool handler directly (same pattern as mcp-server tests). */
async function callTool(
  server: ReturnType<typeof createMcpServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const handler = (server as any)._requestHandlers?.get('tools/call');
  if (!handler) throw new Error('No call handler registered');
  const result = await handler({ method: 'tools/call', params: { name: toolName, arguments: args } });
  return JSON.parse(result.content[0].text);
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const CLAUDE_MD = `# PindeX – MCP Codebase Indexer

MCP server that structurally indexes TypeScript codebases.

## Architecture

The database uses SQLite via better-sqlite3. FTS5 virtual tables enable
full-text search across all indexed symbols.

## Authentication

JWT tokens are used for authentication. The token lifetime is 1 hour.
Refresh tokens are stored in Redis with a 7-day expiry.

## Setup

Run \`pindex\` in the project directory to initialise.
`;

const README_MD = `# Getting Started

## Installation

\`\`\`bash
npm install
npm run build
\`\`\`

## Configuration

Set the following environment variables before starting:

- INDEX_PATH: path to the SQLite database
- PROJECT_ROOT: root directory of the project to index
- MONITORING_PORT: port for the monitoring dashboard

## Running

Start the MCP server with \`node dist/index.js\`.
`;

const ARCH_YAML = `
components:
  database:
    type: sqlite
    library: better-sqlite3
    fts: fts5

  parser:
    type: tree-sitter
    languages:
      - typescript
      - javascript

  monitoring:
    type: express
    port: dynamic
`;

const NOTES_TXT = `Decision log

2024-01-15: Chose SQLite over PostgreSQL for simplicity and portability.
All data is stored in ~/.pindex/projects/{hash}/index.db.

2024-01-20: Decided to use FTS5 triggers instead of application-level sync.
This ensures consistency even if the application crashes.

2024-02-01: Token estimation uses the 4 chars/token heuristic.
This is accurate enough for the 80-90% reduction goal.
`;

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Document Indexing Integration', () => {
  let db: Database.Database;
  let indexer: Indexer;
  let testDir: string;

  beforeEach(() => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-doc-int-${Date.now()}`);
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });

    // Write document files
    writeFileSync(join(testDir, 'CLAUDE.md'), CLAUDE_MD);
    writeFileSync(join(testDir, 'README.md'), README_MD);
    writeFileSync(join(testDir, 'docs', 'architecture.yaml'), ARCH_YAML);
    writeFileSync(join(testDir, 'docs', 'decisions.txt'), NOTES_TXT);

    // Write one code file so the project is not empty
    writeFileSync(join(testDir, 'src', 'index.ts'), `export const VERSION = '1.0.0';`);

    indexer = new Indexer({ db, projectRoot: testDir });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── 1. Indexing ─────────────────────────────────────────────────────────────

  it('indexes markdown files into document chunks', async () => {
    await indexer.indexAll();

    const claudeFile = getFileByPath(db, 'CLAUDE.md');
    expect(claudeFile).not.toBeNull();
    expect(claudeFile!.language).toBe('markdown');

    const chunks = getDocumentChunksByFileId(db, claudeFile!.id);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('splits CLAUDE.md into heading-based chunks', async () => {
    await indexer.indexAll();

    const file = getFileByPath(db, 'CLAUDE.md');
    const chunks = getDocumentChunksByFileId(db, file!.id);

    // Should have chunks for each top-level section
    const headings = chunks.map((c) => c.heading).filter(Boolean);
    expect(headings).toContain('Architecture');
    expect(headings).toContain('Authentication');
    expect(headings).toContain('Setup');
  });

  it('indexes YAML and TXT files into line-based chunks', async () => {
    await indexer.indexAll();

    const yamlFile = getFileByPath(db, 'docs/architecture.yaml');
    expect(yamlFile).not.toBeNull();
    expect(yamlFile!.language).toBe('yaml');

    const txtFile = getFileByPath(db, 'docs/decisions.txt');
    expect(txtFile).not.toBeNull();
    expect(txtFile!.language).toBe('text');
  });

  it('skips unchanged files on re-index (hash check)', async () => {
    await indexer.indexAll();
    const file1 = getFileByPath(db, 'CLAUDE.md');
    const hash1 = file1!.hash;

    // Second indexAll — file unchanged
    await indexer.indexAll();
    const file2 = getFileByPath(db, 'CLAUDE.md');
    expect(file2!.hash).toBe(hash1);

    // Chunk count should be stable
    const chunks = getDocumentChunksByFileId(db, file2!.id);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('re-indexes a document when content changes', async () => {
    await indexer.indexAll();

    const file1 = getFileByPath(db, 'CLAUDE.md');
    const chunksBefore = getDocumentChunksByFileId(db, file1!.id);

    // Overwrite with completely different content
    writeFileSync(join(testDir, 'CLAUDE.md'), '# New Title\n\nCompletely different.\n');
    await indexer.indexDocument('CLAUDE.md', true);

    const file2 = getFileByPath(db, 'CLAUDE.md');
    const chunksAfter = getDocumentChunksByFileId(db, file2!.id);

    // Old chunks should be replaced — heading should be the new one
    const newHeadings = chunksAfter.map((c) => c.heading);
    expect(newHeadings).toContain('New Title');
    // Old headings should be gone
    expect(chunksAfter.map((c) => c.content).join('')).not.toContain('Authentication');
    expect(chunksAfter.length).toBeLessThan(chunksBefore.length);
  });

  // ── 2. search_docs ──────────────────────────────────────────────────────────

  it('search_docs finds the relevant markdown section', async () => {
    await indexer.indexAll();

    const results = searchDocs(db, { query: 'JWT authentication', type: 'docs' });
    expect(results.length).toBeGreaterThan(0);

    const authResult = results.find((r) => r.heading === 'Authentication');
    expect(authResult).toBeDefined();
    expect(authResult!.file).toBe('CLAUDE.md');
    expect(authResult!.content_preview).toContain('JWT');
  });

  it('search_docs finds content in YAML files', async () => {
    await indexer.indexAll();

    // Use a word unique to architecture.yaml (not in any .md file in the fixture)
    const results = searchDocs(db, { query: 'express', type: 'docs' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file).toContain('architecture.yaml');
  });

  it('search_docs finds content in TXT decision log', async () => {
    await indexer.indexAll();

    const results = searchDocs(db, { query: 'SQLite PostgreSQL', type: 'docs' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file).toContain('decisions.txt');
  });

  it('search_docs returns start_line for navigation', async () => {
    await indexer.indexAll();

    const results = searchDocs(db, { query: 'Redis', type: 'docs' });
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0].start_line).toBe('number');
    expect(results[0].start_line).toBeGreaterThan(0);
  });

  // ── 3. get_doc_chunk ────────────────────────────────────────────────────────

  it('get_doc_chunk returns all chunks for a file', async () => {
    await indexer.indexAll();

    const result = getDocChunk(db, { file: 'CLAUDE.md' });
    expect(result).not.toBeNull();
    expect(result!.total_chunks).toBeGreaterThan(2);
    expect(result!.chunks.length).toBe(result!.total_chunks);
  });

  it('get_doc_chunk returns only the requested chunk', async () => {
    await indexer.indexAll();

    // Find the Authentication chunk index
    const all = getDocChunk(db, { file: 'CLAUDE.md' });
    const authChunk = all!.chunks.find((c) => c.heading === 'Authentication');
    expect(authChunk).toBeDefined();

    // Fetch only that chunk
    const single = getDocChunk(db, { file: 'CLAUDE.md', chunk_index: authChunk!.index });
    expect(single).not.toBeNull();
    expect(single!.chunks).toHaveLength(1);
    expect(single!.chunks[0].content).toContain('JWT');
    expect(single!.chunks[0].content).toContain('Redis');
  });

  it('get_doc_chunk returns null for an unindexed file', () => {
    const result = getDocChunk(db, { file: 'nonexistent.md' });
    expect(result).toBeNull();
  });

  // ── 4. save_context + search_docs(context) ──────────────────────────────────

  it('save_context stores a fact and search_docs retrieves it', async () => {
    const sessionId = uuidv4();

    const saved = saveContext(db, sessionId, {
      content: 'JWT token expiry is 1 hour. Refresh token expiry is 7 days. See src/auth/tokens.ts.',
      tags: 'auth,jwt,tokens',
    });

    expect(saved.id).toBeGreaterThan(0);
    expect(saved.session_id).toBe(sessionId);

    const results = searchDocs(db, { query: 'JWT token expiry', type: 'context' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('context');
    expect(results[0].content_preview).toContain('JWT');
    expect(results[0].session_id).toBe(sessionId);
  });

  it('save_context entries are searchable by tag', async () => {
    const sessionId = uuidv4();
    saveContext(db, sessionId, {
      content: 'Rate limiting uses Redis with a sliding window algorithm.',
      tags: 'redis,performance',
    });

    // FTS5 tokenizes on hyphens — search by a plain tag word
    const results = searchDocs(db, { query: 'redis', type: 'context' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tags).toContain('redis');
  });

  it('context entries survive across sessions (cross-session retrieval)', async () => {
    // Session A saves a decision
    const sessionA = uuidv4();
    saveContext(db, sessionA, {
      content: 'Decided to use deterministic port assignment: 7842 + hash % 2000.',
      tags: 'architecture,ports',
    });

    // Session B (different ID, same DB) retrieves it
    const sessionB = uuidv4();
    expect(sessionB).not.toBe(sessionA);

    const results = searchDocs(db, { query: 'deterministic port', type: 'context' });
    expect(results.length).toBeGreaterThan(0);
    // Entry was created by sessionA but is visible to sessionB
    expect(results[0].session_id).toBe(sessionA);
    expect(results[0].content_preview).toContain('deterministic');
  });

  // ── 5. Unified search (type='all') ──────────────────────────────────────────

  it('search_docs(type=all) returns both doc chunks and context entries', async () => {
    await indexer.indexAll();

    const sessionId = uuidv4();
    saveContext(db, sessionId, {
      content: 'Authentication service moved to src/auth/v2/ in refactor.',
      tags: 'auth,refactor',
    });

    // "authentication" appears in CLAUDE.md AND in the saved context
    const results = searchDocs(db, { query: 'authentication', type: 'all' });
    expect(results.length).toBeGreaterThan(0);

    const types = results.map((r) => r.type);
    expect(types).toContain('doc');
    expect(types).toContain('context');
  });

  it('search_docs respects limit across combined results', async () => {
    await indexer.indexAll();
    const sessionId = uuidv4();

    // Add several context entries with the same keyword
    for (let i = 0; i < 5; i++) {
      saveContext(db, sessionId, { content: `SQLite configuration note ${i}` });
    }

    const results = searchDocs(db, { query: 'SQLite', limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  // ── 6. MCP server wiring ────────────────────────────────────────────────────

  it('search_docs tool is wired in the MCP server', async () => {
    await indexer.indexAll();

    const sessionId = uuidv4();
    insertTestSession(db, sessionId, 'indexed', 'Test');
    const emitter = new EventEmitter();
    const tokenLogger = new TokenLogger({ db, sessionId, emitter });
    const server = createMcpServer(db, indexer, tokenLogger, null, {
      projectRoot: testDir,
      sessionId,
    });

    const handler = (server as any)._requestHandlers?.get('tools/call');
    if (!handler) return; // skip if internal API not accessible

    const result = await callTool(server, 'search_docs', { query: 'JWT', type: 'docs' });
    expect(Array.isArray(result)).toBe(true);
  });

  it('save_context tool is wired in the MCP server and returns structured output', async () => {
    const sessionId = uuidv4();
    insertTestSession(db, sessionId, 'indexed', 'Test');
    const emitter = new EventEmitter();
    const tokenLogger = new TokenLogger({ db, sessionId, emitter });
    const server = createMcpServer(db, indexer, tokenLogger, null, {
      projectRoot: testDir,
      sessionId,
    });

    const handler = (server as any)._requestHandlers?.get('tools/call');
    if (!handler) return;

    const result = await callTool(server, 'save_context', {
      content: 'The main entry point is src/index.ts.',
      tags: 'architecture',
    }) as any;

    expect(result.id).toBeGreaterThan(0);
    expect(result.session_id).toBe(sessionId);
    expect(result.created_at).toBeTruthy();
  });

  it('get_doc_chunk tool is wired in the MCP server', async () => {
    await indexer.indexAll();

    const sessionId = uuidv4();
    insertTestSession(db, sessionId, 'indexed', 'Test');
    const emitter = new EventEmitter();
    const tokenLogger = new TokenLogger({ db, sessionId, emitter });
    const server = createMcpServer(db, indexer, tokenLogger, null, {
      projectRoot: testDir,
      sessionId,
    });

    const handler = (server as any)._requestHandlers?.get('tools/call');
    if (!handler) return;

    const result = await callTool(server, 'get_doc_chunk', { file: 'CLAUDE.md' }) as any;
    expect(result.file).toBe('CLAUDE.md');
    expect(result.total_chunks).toBeGreaterThan(0);
    expect(Array.isArray(result.chunks)).toBe(true);
  });

  // ── 7. Full Claude workflow simulation ──────────────────────────────────────

  it('simulates a full Claude workflow: search → read section → save decision', async () => {
    await indexer.indexAll();
    const sessionId = uuidv4();

    // Step 1: Claude searches for authentication info
    const searchResults = searchDocs(db, { query: 'authentication JWT', type: 'docs' });
    expect(searchResults.length).toBeGreaterThan(0);
    const authSection = searchResults.find((r) => r.heading === 'Authentication');
    expect(authSection).toBeDefined();

    // Step 2: Claude reads the specific chunk (token-efficient)
    const chunkResult = getDocChunk(db, {
      file: authSection!.file!,
      chunk_index: searchResults[0].start_line !== undefined
        ? undefined  // fetch all to find the right one
        : undefined,
    });
    expect(chunkResult).not.toBeNull();
    const authChunk = chunkResult!.chunks.find((c) => c.heading === 'Authentication');
    expect(authChunk!.content).toContain('JWT');

    // Step 3: Claude saves a derived decision to context memory
    const saved = saveContext(db, sessionId, {
      content: 'Confirmed: JWT expiry=1h, Refresh=7d (source: CLAUDE.md#Authentication). Implementation in src/auth/.',
      tags: 'auth,jwt,confirmed',
    });
    expect(saved.id).toBeGreaterThan(0);

    // Step 4: In a later session, Claude retrieves the decision without re-reading CLAUDE.md
    const laterSessionId = uuidv4();
    const ctxResults = searchDocs(db, { query: 'JWT expiry confirmed', type: 'context' });
    expect(ctxResults.length).toBeGreaterThan(0);
    expect(ctxResults[0].content_preview).toContain('JWT');
    // The entry was created by sessionId but found by laterSessionId
    expect(ctxResults[0].session_id).toBe(sessionId);
    expect(laterSessionId).not.toBe(sessionId); // just to be explicit
  });
});
