import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestSession, insertTestTokenLog } from '../helpers/fixtures.js';
import { getTokenStats } from '../../src/tools/get_token_stats.js';

describe('getTokenStats', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertTestSession(db, 'sess-abc', 'indexed', 'My Feature');
    insertTestTokenLog(db, 'sess-abc', 'search_symbols', 50, 500);
    insertTestTokenLog(db, 'sess-abc', 'get_symbol', 80, 800);
  });

  it('returns stats for a given session ID', () => {
    const result = getTokenStats(db, { session_id: 'sess-abc' });
    expect(result.session_id).toBe('sess-abc');
    expect(result.tokens_used).toBe(130);
    expect(result.tokens_saved).toBe(1170);
  });

  it('returns savings_percent between 0 and 100', () => {
    const result = getTokenStats(db, { session_id: 'sess-abc' });
    expect(result.savings_percent).toBeGreaterThan(0);
    expect(result.savings_percent).toBeLessThanOrEqual(100);
  });

  it('returns calls array with individual tool calls', () => {
    const result = getTokenStats(db, { session_id: 'sess-abc' });
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].tool).toBe('search_symbols');
  });

  it('returns empty calls for session with no logs', () => {
    insertTestSession(db, 'empty-sess', 'indexed', null);
    const result = getTokenStats(db, { session_id: 'empty-sess' });
    expect(result.calls).toHaveLength(0);
    expect(result.tokens_used).toBe(0);
  });

  it('includes started_at timestamp', () => {
    const result = getTokenStats(db, { session_id: 'sess-abc' });
    expect(result.started_at).toBeTruthy();
  });
});
