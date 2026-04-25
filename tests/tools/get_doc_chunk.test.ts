import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile } from '../helpers/fixtures.js';
import { getDocChunk } from '../../src/tools/get_doc_chunk.js';
import { insertDocumentChunk } from '../../src/db/queries.js';
import { makeTestRepoSet, makeFederatedTestRepoSet } from '../helpers/repo-set.js';

describe('getDocChunk', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns empty array for unknown file', () => {
    const result = getDocChunk(makeTestRepoSet(db), { file: 'nonexistent.md' });
    expect(result).toEqual([]);
  });

  it('returns empty array for file with no chunks', () => {
    insertTestFile(db, { path: 'empty.md', language: 'markdown' });
    const result = getDocChunk(makeTestRepoSet(db), { file: 'empty.md' });
    expect(result).toEqual([]);
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

    const result = getDocChunk(makeTestRepoSet(db), { file: 'CLAUDE.md' });
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('CLAUDE.md');
    expect(result[0].total_chunks).toBe(2);
    expect(result[0].chunks).toHaveLength(2);
    expect(result[0].chunks[0].heading).toBe('Setup');
    expect(result[0].chunks[1].heading).toBe('Usage');
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

    const result = getDocChunk(makeTestRepoSet(db), { file: 'README.md', chunk_index: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].total_chunks).toBe(2);
    expect(result[0].chunks).toHaveLength(1);
    expect(result[0].chunks[0].index).toBe(1);
    expect(result[0].chunks[0].heading).toBe('Details');
    expect(result[0].chunks[0].content).toBe('Detailed content.');
  });

  it('returns entry with empty chunks array when chunk_index does not match', () => {
    const fileId = insertTestFile(db, { path: 'doc.txt', language: 'text' });
    insertDocumentChunk(db, {
      fileId,
      chunkIndex: 0,
      heading: null,
      startLine: 1,
      endLine: 50,
      content: 'Some content.',
    });

    const result = getDocChunk(makeTestRepoSet(db), { file: 'doc.txt', chunk_index: 99 });
    expect(result).toHaveLength(1);
    expect(result[0].chunks).toHaveLength(0);
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

    const result = getDocChunk(makeTestRepoSet(db), { file: 'guide.md', chunk_index: 0 });
    expect(result[0].chunks[0].start_line).toBe(5);
    expect(result[0].chunks[0].end_line).toBe(25);
  });
});

describe('getDocChunk — federation', () => {
  it('returns one entry per repo where the file exists', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();

    const primaryFileId = insertTestFile(primaryDb, { path: 'CLAUDE.md', language: 'markdown' });
    insertDocumentChunk(primaryDb, {
      fileId: primaryFileId,
      chunkIndex: 0,
      heading: 'Main Setup',
      startLine: 1,
      endLine: 10,
      content: 'Main repo setup.',
    });

    const fedFileId = insertTestFile(federatedDb, { path: 'CLAUDE.md', language: 'markdown' });
    insertDocumentChunk(federatedDb, {
      fileId: fedFileId,
      chunkIndex: 0,
      heading: 'Auth Setup',
      startLine: 1,
      endLine: 10,
      content: 'Auth repo setup.',
    });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = getDocChunk(repoSet, { file: 'CLAUDE.md' });
    expect(results).toHaveLength(2);
    const projects = results.map((r) => r.project).sort();
    expect(projects).toContain('main');
    expect(projects).toContain('auth');
  });

  it('scopes by repos param', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();

    const primaryFileId = insertTestFile(primaryDb, { path: 'README.md', language: 'markdown' });
    insertDocumentChunk(primaryDb, {
      fileId: primaryFileId,
      chunkIndex: 0,
      heading: null,
      startLine: 1,
      endLine: 5,
      content: 'Primary readme.',
    });

    const fedFileId = insertTestFile(federatedDb, { path: 'README.md', language: 'markdown' });
    insertDocumentChunk(federatedDb, {
      fileId: fedFileId,
      chunkIndex: 0,
      heading: null,
      startLine: 1,
      endLine: 5,
      content: 'Auth readme.',
    });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = getDocChunk(repoSet, { file: 'README.md', repos: ['auth'] });
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe('auth');
  });

  it('skips repos where the file does not exist', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();

    // Only federated repo has the file
    const fedFileId = insertTestFile(federatedDb, { path: 'only-in-auth.md', language: 'markdown' });
    insertDocumentChunk(federatedDb, {
      fileId: fedFileId,
      chunkIndex: 0,
      heading: null,
      startLine: 1,
      endLine: 5,
      content: 'Auth-only content.',
    });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = getDocChunk(repoSet, { file: 'only-in-auth.md' });
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe('auth');
  });
});
