import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { saveContext } from '../../src/tools/save_context.js';
import { searchContextEntriesFts } from '../../src/db/queries.js';

describe('saveContext', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('persists a context entry and returns its id', () => {
    const result = saveContext(db, 'session-abc', {
      content: 'JWT tokens expire after 1 hour.',
    });

    expect(result.id).toBeGreaterThan(0);
    expect(result.session_id).toBe('session-abc');
    expect(result.created_at).toBeTruthy();
  });

  it('stores tags when provided', () => {
    const result = saveContext(db, 'session-abc', {
      content: 'Redis is used for rate limiting.',
      tags: 'redis,cache,rate-limit',
    });

    expect(result.id).toBeGreaterThan(0);

    // Verify it is searchable via FTS
    const rows = searchContextEntriesFts(db, 'Redis', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toBe('redis,cache,rate-limit');
  });

  it('stores entry without tags', () => {
    const result = saveContext(db, 'sess-1', {
      content: 'The main entry point is src/index.ts.',
    });

    expect(result.id).toBeGreaterThan(0);

    const rows = searchContextEntriesFts(db, 'entry point', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toBeNull();
  });

  it('saves multiple entries independently', () => {
    saveContext(db, 'sess-1', { content: 'First fact about authentication.' });
    saveContext(db, 'sess-2', { content: 'Second fact about authentication.' });

    const rows = searchContextEntriesFts(db, 'authentication', 10);
    expect(rows).toHaveLength(2);
  });

  it('entries are searchable by tag content', () => {
    saveContext(db, 'sess-1', {
      content: 'Some architectural decision.',
      tags: 'architecture,decision,adr',
    });

    const byTag = searchContextEntriesFts(db, 'adr', 10);
    expect(byTag).toHaveLength(1);
    expect(byTag[0].content).toContain('architectural decision');
  });
});
