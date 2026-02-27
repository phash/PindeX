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
  // Future migrations go here, e.g.:
  // { version: 2, up: (db) => db.exec('ALTER TABLE files ADD COLUMN ...') },
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
