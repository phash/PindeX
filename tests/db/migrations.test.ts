import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getCurrentVersion } from '../../src/db/migrations.js';

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  it('runs without error on a fresh database', () => {
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('sets user_version pragma after running migrations', () => {
    runMigrations(db);
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBeGreaterThanOrEqual(0);
  });

  it('is idempotent – running migrations twice does not throw', () => {
    expect(() => {
      runMigrations(db);
      runMigrations(db);
    }).not.toThrow();
  });

  it('getCurrentVersion returns 0 for fresh database', () => {
    expect(getCurrentVersion(db)).toBe(0);
  });

  it('getCurrentVersion returns correct version after migrations', () => {
    runMigrations(db);
    const version = getCurrentVersion(db);
    expect(typeof version).toBe('number');
    expect(version).toBeGreaterThanOrEqual(0);
  });
});

describe('schema v6 (symbol_refs)', () => {
  function tables(db: Database.Database): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
  }
  function indexes(db: Database.Database, table: string): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(table) as Array<{ name: string }>).map((r) => r.name);
  }
  function symbolRefsSql(db: Database.Database): string {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'symbol_refs'").get() as { sql: string }).sql;
  }

  /** Builds a DB as a v5 install would look: old schema incl. usages. */
  function makeV5Db(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, language TEXT NOT NULL,
        summary TEXT, last_indexed DATETIME, hash TEXT, raw_token_estimate INTEGER);
      CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, summary TEXT, start_line INTEGER,
        end_line INTEGER, is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0, has_try_catch INTEGER DEFAULT 0);
      CREATE TABLE usages (id INTEGER PRIMARY KEY, symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        used_in_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, used_at_line INTEGER);
      CREATE INDEX idx_usages_symbol ON usages(symbol_id);
      INSERT INTO files (id, path, language, hash) VALUES (1, 'a.ts', 'typescript', 'x');
      INSERT INTO symbols (id, file_id, name, kind, signature) VALUES (1, 1, 's', 'function', 's()');
      INSERT INTO usages (symbol_id, used_in_file, used_at_line) VALUES (1, 1, 3);
    `);
    db.pragma('user_version = 5');
    return db;
  }

  it('fresh DB ends at v6 with symbol_refs and without usages', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(6);
    expect(tables(db)).toContain('symbol_refs');
    expect(tables(db)).not.toContain('usages');
    expect(indexes(db, 'symbol_refs')).toEqual(['idx_symbol_refs_callee', 'idx_symbol_refs_file']);
  });

  it('v5 DB: usages dropped, symbol_refs created', () => {
    const db = makeV5Db();
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(6);
    expect(tables(db)).not.toContain('usages');
    expect(tables(db)).toContain('symbol_refs');
  });

  it('v5 DB: files.hash reset to NULL so the next indexAll re-parses', () => {
    const db = makeV5Db();
    runMigrations(db);
    expect((db.prepare('SELECT hash FROM files WHERE id = 1').get() as { hash: string | null }).hash).toBeNull();
  });

  it('fresh and upgraded DBs have identical symbol_refs definition and indexes', () => {
    const fresh = new Database(':memory:');
    runMigrations(fresh);
    const upgraded = makeV5Db();
    runMigrations(upgraded);
    expect(symbolRefsSql(upgraded)).toBe(symbolRefsSql(fresh));
    expect(indexes(upgraded, 'symbol_refs')).toEqual(indexes(fresh, 'symbol_refs'));
  });
});
