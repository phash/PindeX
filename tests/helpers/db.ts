import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { SessionEventRecord, SessionEventType } from '../../src/types.js';

/** Creates a fresh in-memory SQLite database with the full schema applied.
 *  Each call returns an isolated database – safe to use in parallel tests. */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Test-only reader for session_events (production code has no consumer). */
export function getSessionEvents(
  db: Database.Database,
  sessionId: string,
  eventTypes?: SessionEventType[],
): SessionEventRecord[] {
  if (eventTypes && eventTypes.length > 0) {
    const placeholders = eventTypes.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT * FROM session_events
         WHERE session_id = ? AND event_type IN (${placeholders})
         ORDER BY timestamp`,
      )
      .all(sessionId, ...eventTypes) as SessionEventRecord[];
  }
  return db
    .prepare('SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp')
    .all(sessionId) as SessionEventRecord[];
}
