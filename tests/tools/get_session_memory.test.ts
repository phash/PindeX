import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestSession } from '../helpers/fixtures.js';
import { getSessionMemory } from '../../src/tools/get_session_memory.js';
import { insertObservation, insertSessionEvent } from '../../src/db/queries.js';

const SESSION = 'mem-test-session';

describe('getSessionMemory', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertTestSession(db, SESSION);
  });

  it('returns empty observations for a fresh session', () => {
    const result = getSessionMemory(db, SESSION, {});
    expect(result.observations).toHaveLength(0);
    expect(result.anti_patterns).toHaveLength(0);
    expect(result.stale_count).toBe(0);
    expect(result.stale_warning).toBeNull();
  });

  it('returns observations for the current session', () => {
    insertObservation(db, {
      sessionId: SESSION,
      type: 'sig_changed',
      filePath: 'src/auth.ts',
      symbolName: 'AuthService',
      observation: 'AuthService signature changed',
    });
    const result = getSessionMemory(db, SESSION, {});
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].text).toBe('AuthService signature changed');
    expect(result.observations[0].stale).toBe(false);
  });

  it('filters by file', () => {
    insertObservation(db, { sessionId: SESSION, type: 'accessed', filePath: 'src/auth.ts', observation: 'auth accessed' });
    insertObservation(db, { sessionId: SESSION, type: 'accessed', filePath: 'src/utils.ts', observation: 'utils accessed' });

    const result = getSessionMemory(db, SESSION, { file: 'src/auth.ts' });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].file).toBe('src/auth.ts');
  });

  it('filters by file + symbol', () => {
    insertObservation(db, { sessionId: SESSION, type: 'accessed', filePath: 'src/auth.ts', symbolName: 'AuthService', observation: 'class accessed' });
    insertObservation(db, { sessionId: SESSION, type: 'accessed', filePath: 'src/auth.ts', symbolName: 'login', observation: 'fn accessed' });

    const result = getSessionMemory(db, SESSION, { file: 'src/auth.ts', symbol: 'AuthService' });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].symbol).toBe('AuthService');
  });

  it('excludes stale observations by default', () => {
    const stmt = db.prepare(`
      INSERT INTO session_observations (session_id, type, file_path, observation, stale)
      VALUES (?, 'sig_changed', 'src/auth.ts', 'old observation', 1)
    `);
    stmt.run(SESSION);

    const result = getSessionMemory(db, SESSION, {});
    expect(result.observations).toHaveLength(0);
    expect(result.stale_count).toBe(0); // stale_count counts filtered observations
  });

  it('includes stale observations when include_stale=true', () => {
    const stmt = db.prepare(`
      INSERT INTO session_observations (session_id, type, file_path, observation, stale, stale_reason)
      VALUES (?, 'sig_changed', 'src/auth.ts', 'old observation', 1, 'signature changed')
    `);
    stmt.run(SESSION);

    const result = getSessionMemory(db, SESSION, { include_stale: true });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].stale).toBe(true);
    expect(result.observations[0].stale_reason).toBe('signature changed');
    expect(result.stale_count).toBe(1);
    expect(result.stale_warning).not.toBeNull();
  });

  it('returns anti-pattern events', () => {
    insertSessionEvent(db, {
      sessionId: SESSION,
      eventType: 'dead_end',
      filePath: 'src/auth.ts',
      symbolName: 'foo',
      extraJson: JSON.stringify({ description: 'Added then removed `foo`' }),
    });

    const result = getSessionMemory(db, SESSION, {});
    expect(result.anti_patterns).toHaveLength(1);
    expect(result.anti_patterns[0].type).toBe('dead_end');
    expect(result.anti_patterns[0].text).toBe('Added then removed `foo`');
  });

  it('uses session_id override when provided', () => {
    const otherSession = 'other-session';
    insertTestSession(db, otherSession);
    insertObservation(db, {
      sessionId: otherSession,
      type: 'accessed',
      filePath: 'src/foo.ts',
      observation: 'from other session',
    });

    const result = getSessionMemory(db, SESSION, { session_id: otherSession });
    expect(result.current_session.id).toBe(otherSession);
    expect(result.observations).toHaveLength(1);
  });

  it('stale_warning is null when no stale observations', () => {
    insertObservation(db, { sessionId: SESSION, type: 'accessed', observation: 'fresh obs' });
    const result = getSessionMemory(db, SESSION, {});
    expect(result.stale_warning).toBeNull();
  });
});
