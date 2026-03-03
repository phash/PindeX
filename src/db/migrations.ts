import type Database from 'better-sqlite3';
import { initSchema } from './schema.js';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

/** All schema migrations in ascending version order. */
const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      // Initial schema – handled by initSchema()
      initSchema(db);
    },
  },
  {
    version: 2,
    up: (db) => {
      // Document indexing: text chunks + saved context entries
      initSchema(db);
    },
  },
  {
    version: 3,
    up: (db) => {
      // Session memory: ast_snapshots, session_observations, session_events
      initSchema(db);
    },
  },
  {
    version: 4,
    up: (db) => {
      // AST flags: is_async, has_try_catch on symbols table
      db.exec(`
        ALTER TABLE symbols ADD COLUMN is_async      INTEGER DEFAULT 0;
        ALTER TABLE symbols ADD COLUMN has_try_catch INTEGER DEFAULT 0;
      `);
    },
  },
  {
    version: 5,
    up: (db) => {
      // UNIQUE constraints to make INSERT OR IGNORE work correctly
      // + missing indexes for query performance
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dependencies_unique
          ON dependencies(from_file, to_file, symbol_name);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_usages_unique
          ON usages(symbol_id, used_in_file, used_at_line);
        CREATE INDEX IF NOT EXISTS idx_usages_used_in_file
          ON usages(used_in_file);
        CREATE INDEX IF NOT EXISTS idx_session_events_type_session
          ON session_events(event_type, session_id);
      `);
    },
  },
];

/** Returns the current schema version (0 for a fresh, unmigrated database). */
export function getCurrentVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Runs all pending migrations and updates PRAGMA user_version. */
export function runMigrations(db: Database.Database): void {
  const current = getCurrentVersion(db);

  const pending = migrations.filter((m) => m.version > current);
  for (const migration of pending) {
    migration.up(db);
    db.pragma(`user_version = ${migration.version}`);
  }
}
