import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile } from '../helpers/fixtures.js';
import { getDocChunk } from '../../src/tools/get_doc_chunk.js';
import { insertDocumentChunk } from '../../src/db/queries.js';

describe('getDocChunk', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns null for unknown file', () => {
    const result = getDocChunk(db, { file: 'nonexistent.md' });
    expect(result).toBeNull();
  });

  it('returns null for file with no chunks', () => {
    insertTestFile(db, { path: 'empty.md', language: 'markdown' });
    const result = getDocChunk(db, { file: 'empty.md' });
    expect(result).toBeNull();
  });

  it('returns all chunks when chunk_index is omitted', () => {
    const fileId = insertTestFile(db, { path: 'CLAUDE.md', language: 'markdown' });
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 0,
      heading: 'Setup',
      startLine: 1,
      endLine: 20,
      content: 'Installation instructions here.',
    });
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 1,
      heading: 'Usage',
      startLine: 21,
      endLine: 40,
      content: 'Usage guide here.',
    });

    const result = getDocChunk(db, { file: 'CLAUDE.md' });
    expect(result).not.toBeNull();
    expect(result!.file).toBe('CLAUDE.md');
    expect(result!.total_chunks).toBe(2);
    expect(result!.chunks).toHaveLength(2);
    expect(result!.chunks[0].heading).toBe('Setup');
    expect(result!.chunks[1].heading).toBe('Usage');
  });

  it('returns only the requested chunk when chunk_index is given', () => {
    const fileId = insertTestFile(db, { path: 'README.md', language: 'markdown' });
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 0,
      heading: 'Introduction',
      startLine: 1,
      endLine: 15,
      content: 'Introduction content.',
    });
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 1,
      heading: 'Details',
      startLine: 16,
      endLine: 30,
      content: 'Detailed content.',
    });

    const result = getDocChunk(db, { file: 'README.md', chunk_index: 1 });
    expect(result).not.toBeNull();
    expect(result!.total_chunks).toBe(2);
    expect(result!.chunks).toHaveLength(1);
    expect(result!.chunks[0].index).toBe(1);
    expect(result!.chunks[0].heading).toBe('Details');
    expect(result!.chunks[0].content).toBe('Detailed content.');
  });

  it('returns empty chunks array when chunk_index does not match', () => {
    const fileId = insertTestFile(db, { path: 'doc.txt', language: 'text' });
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 0,
      heading: null,
      startLine: 1,
      endLine: 50,
      content: 'Some content.',
    });

    const result = getDocChunk(db, { file: 'doc.txt', chunk_index: 99 });
    expect(result).not.toBeNull();
    expect(result!.chunks).toHaveLength(0);
  });

  it('returns correct line range metadata', () => {
    const fileId = insertTestFile(db, { path: 'guide.md', language: 'markdown' });
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 0,
      heading: 'Section',
      startLine: 5,
      endLine: 25,
      content: 'Section body.',
    });

    const result = getDocChunk(db, { file: 'guide.md', chunk_index: 0 });
    expect(result!.chunks[0].start_line).toBe(5);
    expect(result!.chunks[0].end_line).toBe(25);
  });
});
