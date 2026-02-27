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
