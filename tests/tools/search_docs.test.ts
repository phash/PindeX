import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile } from '../helpers/fixtures.js';
import { searchDocs } from '../../src/tools/search_docs.js';
import { insertDocumentChunk, insertContextEntry } from '../../src/db/queries.js';

describe('searchDocs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns empty array when no data exists', () => {
    const results = searchDocs(db, { query: 'anything' });
    expect(results).toEqual([]);
  });

  it('finds document chunks by content', () => {
    const fileId = insertTestFile(db, { path: 'docs/guide.md', language: 'markdown' });
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 0,
      heading: 'Authentication',
      startLine: 1,
      endLine: 10,
      content: 'This section describes the JWT authentication flow.',
    });

    const results = searchDocs(db, { query: 'JWT authentication', type: 'docs' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('doc');
    expect(results[0].file).toBe('docs/guide.md');
    expect(results[0].heading).toBe('Authentication');
    expect(results[0].content_preview).toContain('JWT');
  });

  it('finds context entries by content', () => {
    insertContextEntry(db, {
      sessionId: 'test-session',
      content: 'The database uses PostgreSQL with connection pooling.',
      tags: 'database,postgres',
    });

    const results = searchDocs(db, { query: 'PostgreSQL', type: 'context' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('context');
    expect(results[0].session_id).toBe('test-session');
    expect(results[0].tags).toBe('database,postgres');
    expect(results[0].content_preview).toContain('PostgreSQL');
  });

  it('searches both docs and context when type=all (default)', () => {
    const fileId = insertTestFile(db, { path: 'README.md', language: 'markdown' });
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 0,
      heading: null,
      startLine: 1,
      endLine: 5,
      content: 'Project setup instructions for authentication module.',
    });
    insertContextEntry(db, {
      sessionId: 'sess-1',
      content: 'Authentication uses OAuth2 tokens.',
      tags: 'auth',
    });

    const results = searchDocs(db, { query: 'authentication' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const types = results.map((r) => r.type);
    expect(types).toContain('doc');
  });

  it('respects the limit parameter', () => {
    const fileId = insertTestFile(db, { path: 'notes.txt', language: 'text' });
    for (let i = 0; i < 5; i++) {
      insertDocumentChunk(db, {
        fileId,
        chunkIndex: i,
        heading: null,
        startLine: i * 10 + 1,
        endLine: (i + 1) * 10,
        content: `Authentication configuration step ${i}`,
      });
    }

    const results = searchDocs(db, { query: 'Authentication', limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('truncates long content to preview', () => {
    const fileId = insertTestFile(db, { path: 'big.md', language: 'markdown' });
    // Use real words so FTS5 tokenizer can index and match them
    const longContent = 'authorization '.repeat(40); // ~570 chars
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 0,
      heading: null,
      startLine: 1,
      endLine: 10,
      content: longContent.trim(),
    });

    const results = searchDocs(db, { query: 'authorization', type: 'docs' });
    expect(results).toHaveLength(1);
    expect(results[0].content_preview.length).toBeLessThanOrEqual(210); // 200 + ellipsis
  });

  it('returns empty array for invalid FTS query without throwing', () => {
    const results = searchDocs(db, { query: '"unclosed', type: 'docs' });
    expect(results).toEqual([]);
  });
});
