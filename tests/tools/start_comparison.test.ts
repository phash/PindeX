import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { startComparison } from '../../src/tools/start_comparison.js';
import { getSession } from '../../src/db/queries.js';

describe('startComparison', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates a new session and returns its ID', () => {
    const result = startComparison(db, { label: 'My Feature', mode: 'indexed' }, 7842);
    expect(result.session_id).toBeTruthy();
    expect(typeof result.session_id).toBe('string');
  });

  it('stores the session in the database', () => {
    const result = startComparison(db, { label: 'Test', mode: 'indexed' }, 7842);
    const session = getSession(db, result.session_id);
    expect(session).not.toBeNull();
    expect(session!.label).toBe('Test');
    expect(session!.mode).toBe('indexed');
  });

  it('returns the monitoring URL', () => {
    const result = startComparison(db, { label: 'Test', mode: 'indexed' }, 7842);
    expect(result.monitoring_url).toBe('http://localhost:7842');
  });

  it('supports baseline mode', () => {
    const result = startComparison(db, { label: 'Baseline', mode: 'baseline' }, 7842);
    const session = getSession(db, result.session_id);
    expect(session!.mode).toBe('baseline');
  });

  it('generates unique session IDs', () => {
    const r1 = startComparison(db, { label: 'A', mode: 'indexed' }, 7842);
    const r2 = startComparison(db, { label: 'B', mode: 'indexed' }, 7842);
    expect(r1.session_id).not.toBe(r2.session_id);
  });
});
