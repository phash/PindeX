import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';

describe('initSchema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  it('creates the files table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the symbols table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbols'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the dependencies table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dependencies'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the usages table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usages'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the token_log table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_log'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the sessions table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the symbols_fts virtual table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbols_fts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('files table has a UNIQUE constraint on path', () => {
    initSchema(db);
    const insert = db.prepare(
      "INSERT INTO files (path, language, last_indexed, hash, raw_token_estimate) VALUES (?, 'ts', datetime('now'), 'h1', 100)",
    );
    insert.run('src/a.ts');
    expect(() => insert.run('src/a.ts')).toThrow();
  });

  it('enforces NOT NULL on files.path', () => {
    initSchema(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO files (path, language, last_indexed, hash, raw_token_estimate) VALUES (NULL, 'ts', datetime('now'), 'h', 0)",
        )
        .run(),
    ).toThrow();
  });

  it('enforces NOT NULL on files.language', () => {
    initSchema(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO files (path, language, last_indexed, hash, raw_token_estimate) VALUES ('x.ts', NULL, datetime('now'), 'h', 0)",
        )
        .run(),
    ).toThrow();
  });

  it('is idempotent – calling initSchema twice does not throw', () => {
    expect(() => {
      initSchema(db);
      initSchema(db);
    }).not.toThrow();
  });

  it('FTS5 triggers sync symbols into symbols_fts on INSERT', () => {
    initSchema(db);
    db.prepare(
      "INSERT INTO files (path, language, last_indexed, hash, raw_token_estimate) VALUES ('a.ts', 'ts', datetime('now'), 'h', 0)",
    ).run();
    const fileId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;
    db.prepare(
      "INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line) VALUES (?, 'myFunc', 'function', 'myFunc(): void', 1, 5)",
    ).run(fileId);

    const results = db
      .prepare("SELECT * FROM symbols_fts WHERE symbols_fts MATCH 'myFunc'")
      .all();
    expect(results.length).toBeGreaterThan(0);
  });

  it('FTS5 triggers remove symbols from symbols_fts on DELETE', () => {
    initSchema(db);
    db.prepare(
      "INSERT INTO files (path, language, last_indexed, hash, raw_token_estimate) VALUES ('b.ts', 'ts', datetime('now'), 'h', 0)",
    ).run();
    const fileId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;
    db.prepare(
      "INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line) VALUES (?, 'deleteMe', 'function', 'deleteMe(): void', 1, 5)",
    ).run(fileId);
    const symbolId = (
      db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }
    ).id;
    db.prepare('DELETE FROM symbols WHERE id = ?').run(symbolId);

    const results = db
      .prepare("SELECT * FROM symbols_fts WHERE symbols_fts MATCH 'deleteMe'")
      .all();
    expect(results).toHaveLength(0);
  });

  it('sessions table defaults mode and enforces NOT NULL', () => {
    initSchema(db);
    expect(() =>
      db.prepare('INSERT INTO sessions (id, mode) VALUES (?, ?)').run('sid', null),
    ).toThrow();
  });

  it('creates the documents table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the context_entries table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_entries'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the documents_fts virtual table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the context_entries_fts virtual table', () => {
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_entries_fts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('FTS5 triggers sync documents into documents_fts on INSERT', () => {
    initSchema(db);
    db.prepare(
      "INSERT INTO files (path, language, last_indexed, hash, raw_token_estimate) VALUES ('README.md', 'markdown', datetime('now'), 'h1', 200)",
    ).run();
    const fileId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;
    db.prepare(
      "INSERT INTO documents (file_id, chunk_index, start_line, end_line, content) VALUES (?, 0, 1, 10, 'How to configure authentication using JWT tokens')",
    ).run(fileId);

    const results = db
      .prepare("SELECT * FROM documents_fts WHERE documents_fts MATCH 'authentication'")
      .all();
    expect(results.length).toBeGreaterThan(0);
  });

  it('FTS5 triggers sync context_entries into context_entries_fts on INSERT', () => {
    initSchema(db);
    db.prepare(
      "INSERT INTO context_entries (session_id, content) VALUES ('sess-1', 'PostgreSQL is used for persistent storage')",
    ).run();

    const results = db
      .prepare("SELECT * FROM context_entries_fts WHERE context_entries_fts MATCH 'PostgreSQL'")
      .all();
    expect(results.length).toBeGreaterThan(0);
  });

  it('documents cascade-delete when the file is deleted', () => {
    initSchema(db);
    db.pragma('foreign_keys = ON');
    db.prepare(
      "INSERT INTO files (path, language, last_indexed, hash, raw_token_estimate) VALUES ('guide.md', 'markdown', datetime('now'), 'h', 0)",
    ).run();
    const fileId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;
    db.prepare(
      "INSERT INTO documents (file_id, chunk_index, start_line, end_line, content) VALUES (?, 0, 1, 5, 'Some content')",
    ).run(fileId);

    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);

    const remaining = db.prepare('SELECT * FROM documents WHERE file_id = ?').all(fileId);
    expect(remaining).toHaveLength(0);
  });
});
