import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';

/** Creates a fresh in-memory SQLite database with the full schema applied.
 *  Each call returns an isolated database – safe to use in parallel tests. */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
