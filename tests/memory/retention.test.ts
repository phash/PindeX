import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestSession } from '../helpers/fixtures.js';
import { applyObservationRetention } from '../../src/memory/retention.js';
import {
  insertObservation,
  insertSessionEvent,
  getAllObservations,
  getObservationsBySession,
} from '../../src/db/queries.js';

/** Counts rows in a table. */
function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/** Inserts an observation and then stamps its created_at to an explicit ISO time. */
function insertObservationAt(
  db: Database.Database,
  sessionId: string,
  observation: string,
  createdAtIso: string,
): number {
  const id = insertObservation(db, { sessionId, type: 'accessed', observation });
  db.prepare('UPDATE session_observations SET created_at = ? WHERE id = ?').run(createdAtIso, id);
  return id;
}

describe('applyObservationRetention (TST-09)', () => {
  let db: Database.Database;
  const SESSION_A = 'session-a';
  const SESSION_B = 'session-b';

  beforeEach(() => {
    db = createTestDb();
    insertTestSession(db, SESSION_A, 'indexed', 'A');
    insertTestSession(db, SESSION_B, 'indexed', 'B');
  });

  afterEach(() => {
    db.close();
  });

  it("'permanent' deletes nothing", () => {
    insertObservation(db, { sessionId: SESSION_A, type: 'accessed', observation: 'a1' });
    insertObservation(db, { sessionId: SESSION_B, type: 'accessed', observation: 'b1' });
    insertSessionEvent(db, { sessionId: SESSION_A, eventType: 'accessed' });
    insertSessionEvent(db, { sessionId: SESSION_B, eventType: 'accessed' });

    const before = count(db, 'session_observations');
    const beforeEvents = count(db, 'session_events');
    expect(before).toBe(2);

    applyObservationRetention(db, SESSION_A, 'permanent');

    expect(count(db, 'session_observations')).toBe(before);
    expect(count(db, 'session_events')).toBe(beforeEvents);
    expect(getAllObservations(db)).toHaveLength(2);
  });

  it("'session' keeps only the current session's rows across the relevant tables", () => {
    insertObservation(db, { sessionId: SESSION_A, type: 'accessed', observation: 'a1' });
    insertObservation(db, { sessionId: SESSION_A, type: 'accessed', observation: 'a2' });
    insertObservation(db, { sessionId: SESSION_B, type: 'accessed', observation: 'b1' });

    insertSessionEvent(db, { sessionId: SESSION_A, eventType: 'accessed' });
    insertSessionEvent(db, { sessionId: SESSION_B, eventType: 'accessed' });

    // token_log is also pruned by deleteObservationsExceptSession.
    db.prepare(
      'INSERT INTO token_log (session_id, tool_name, tokens_used, tokens_without_index) VALUES (?, ?, ?, ?)',
    ).run(SESSION_A, 'search_symbols', 10, 100);
    db.prepare(
      'INSERT INTO token_log (session_id, tool_name, tokens_used, tokens_without_index) VALUES (?, ?, ?, ?)',
    ).run(SESSION_B, 'search_symbols', 10, 100);

    applyObservationRetention(db, SESSION_A, 'session');

    const obs = getObservationsBySession(db, SESSION_A);
    expect(obs.map((o) => o.observation).sort()).toEqual(['a1', 'a2']);
    // Only session A remains everywhere.
    expect(count(db, 'session_observations')).toBe(2);
    expect(getObservationsBySession(db, SESSION_B)).toHaveLength(0);
    expect(count(db, 'session_events')).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?').get(SESSION_B) as { c: number }).c,
    ).toBe(0);
    expect(count(db, 'token_log')).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM token_log WHERE session_id = ?').get(SESSION_B) as { c: number }).c,
    ).toBe(0);
  });

  it("'30d' deletes observations older than the cutoff and keeps recent ones", () => {
    const now = Date.now();
    const oldIso = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    const recentIso = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

    insertObservationAt(db, SESSION_A, 'ancient', oldIso);
    insertObservationAt(db, SESSION_A, 'fresh', recentIso);

    applyObservationRetention(db, SESSION_A, '30d');

    const remaining = getAllObservations(db);
    expect(remaining.map((o) => o.observation)).toEqual(['fresh']);
    expect(count(db, 'session_observations')).toBe(1);
  });

  it("invalid value like 'bogus' deletes nothing (warning to stderr is fine)", () => {
    insertObservation(db, { sessionId: SESSION_A, type: 'accessed', observation: 'a1' });
    insertObservation(db, { sessionId: SESSION_B, type: 'accessed', observation: 'b1' });
    insertSessionEvent(db, { sessionId: SESSION_A, eventType: 'accessed' });

    // Unknown values fall back to 'permanent' — no rows are deleted. The
    // function also writes a warning to stderr; that side effect is not
    // asserted here because the vitest harness intercepts process.stderr.
    applyObservationRetention(db, SESSION_A, 'bogus');

    expect(count(db, 'session_observations')).toBe(2);
    expect(count(db, 'session_events')).toBe(1);
    expect(getAllObservations(db)).toHaveLength(2);
  });
});
