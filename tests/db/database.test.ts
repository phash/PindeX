import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/database.js';

describe('openDatabase', () => {
  const tempDirs: string[] = [];
  const openDbs: Database.Database[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pindex-db-test-'));
    tempDirs.push(dir);
    return dir;
  }

  function track(db: Database.Database): Database.Database {
    openDbs.push(db);
    return db;
  }

  afterEach(() => {
    while (openDbs.length > 0) {
      try {
        openDbs.pop()!.close();
      } catch {
        /* already closed */
      }
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('creates a missing nested parent directory and the db file', () => {
    const base = makeTempDir();
    const dbPath = join(base, 'nested', 'deeper', 'index.db');
    expect(existsSync(join(base, 'nested'))).toBe(false);

    const db = track(openDatabase(dbPath));

    expect(existsSync(join(base, 'nested', 'deeper'))).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    expect(db.open).toBe(true);
  });

  it('sets the expected pragmas', () => {
    const base = makeTempDir();
    const dbPath = join(base, 'index.db');
    const db = track(openDatabase(dbPath));

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('works for :memory: without touching the filesystem', () => {
    const db = track(openDatabase(':memory:'));

    expect(db.open).toBe(true);
    expect(existsSync(':memory:')).toBe(false);
    // :memory: databases do not use WAL; assert the call simply succeeds.
    expect(() => db.prepare('SELECT 1').get()).not.toThrow();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('returns a usable database that can run DDL/DML', () => {
    const base = makeTempDir();
    const db = track(openDatabase(join(base, 'usable.db')));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
    const row = db.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string };
    expect(row.v).toBe('hello');
  });
});
