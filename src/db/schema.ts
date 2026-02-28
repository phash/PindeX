import type Database from 'better-sqlite3';

/** Creates all tables, virtual tables, triggers, and indexes.
 *  Uses IF NOT EXISTS so it is safe to call multiple times. */
export function initSchema(db: Database.Database): void {
  db.exec(`
    -- ─── Core Tables ─────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS files (
      id                  INTEGER PRIMARY KEY,
      path                TEXT UNIQUE NOT NULL,
      language            TEXT NOT NULL,
      summary             TEXT,
      last_indexed        DATETIME,
      hash                TEXT,
      raw_token_estimate  INTEGER
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id          INTEGER PRIMARY KEY,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      signature   TEXT NOT NULL,
      summary     TEXT,
      start_line  INTEGER,
      end_line    INTEGER,
      is_exported INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      id          INTEGER PRIMARY KEY,
      from_file   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      to_file     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      symbol_name TEXT
    );

    CREATE TABLE IF NOT EXISTS usages (
      id            INTEGER PRIMARY KEY,
      symbol_id     INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      used_in_file  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      used_at_line  INTEGER
    );

    CREATE TABLE IF NOT EXISTS token_log (
      id                    INTEGER PRIMARY KEY,
      timestamp             DATETIME DEFAULT CURRENT_TIMESTAMP,
      session_id            TEXT,
      tool_name             TEXT NOT NULL,
      tokens_used           INTEGER NOT NULL,
      tokens_without_index  INTEGER NOT NULL,
      files_touched         TEXT,
      query                 TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      mode          TEXT NOT NULL,
      label         TEXT,
      total_tokens  INTEGER DEFAULT 0,
      total_savings INTEGER DEFAULT 0
    );

    -- ─── Indexes ──────────────────────────────────────────────────────────────

    CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_dependencies_from ON dependencies(from_file);
    CREATE INDEX IF NOT EXISTS idx_dependencies_to ON dependencies(to_file);
    CREATE INDEX IF NOT EXISTS idx_usages_symbol ON usages(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_token_log_session ON token_log(session_id);
  `);

  // ─── Document Tables ───────────────────────────────────────────────────────
  // Stores text chunks from non-code files (markdown, yaml, txt, etc.)

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id          INTEGER PRIMARY KEY,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      heading     TEXT,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      content     TEXT NOT NULL,
      summary     TEXT
    );

    CREATE TABLE IF NOT EXISTS context_entries (
      id          INTEGER PRIMARY KEY,
      session_id  TEXT NOT NULL,
      content     TEXT NOT NULL,
      tags        TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_documents_file_id ON documents(file_id);
    CREATE INDEX IF NOT EXISTS idx_context_entries_session ON context_entries(session_id);
  `);

  // FTS5 virtual tables (separate exec – CREATE VIRTUAL TABLE IF NOT EXISTS
  // is supported by SQLite)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts
    USING fts5(name, summary, signature, content=symbols, content_rowid=id);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
    USING fts5(content, heading, summary, content=documents, content_rowid=id);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS context_entries_fts
    USING fts5(content, tags, content=context_entries, content_rowid=id);
  `);

  // ─── FTS5 Sync Triggers ────────────────────────────────────────────────────
  // These keep symbols_fts in sync with the symbols table automatically.

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS symbols_ai
    AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, summary, signature)
      VALUES (new.id, new.name, COALESCE(new.summary, ''), new.signature);
    END;

    CREATE TRIGGER IF NOT EXISTS symbols_ad
    AFTER DELETE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, summary, signature)
      VALUES ('delete', old.id, old.name, COALESCE(old.summary, ''), old.signature);
    END;

    CREATE TRIGGER IF NOT EXISTS symbols_au
    AFTER UPDATE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, summary, signature)
      VALUES ('delete', old.id, old.name, COALESCE(old.summary, ''), old.signature);
      INSERT INTO symbols_fts(rowid, name, summary, signature)
      VALUES (new.id, new.name, COALESCE(new.summary, ''), new.signature);
    END;
  `);

  // ─── documents_fts Sync Triggers ──────────────────────────────────────────
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai
    AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, content, heading, summary)
      VALUES (new.id, new.content, COALESCE(new.heading, ''), COALESCE(new.summary, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS documents_ad
    AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, content, heading, summary)
      VALUES ('delete', old.id, old.content, COALESCE(old.heading, ''), COALESCE(old.summary, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS documents_au
    AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, content, heading, summary)
      VALUES ('delete', old.id, old.content, COALESCE(old.heading, ''), COALESCE(old.summary, ''));
      INSERT INTO documents_fts(rowid, content, heading, summary)
      VALUES (new.id, new.content, COALESCE(new.heading, ''), COALESCE(new.summary, ''));
    END;
  `);

  // ─── context_entries_fts Sync Triggers ────────────────────────────────────
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS context_entries_ai
    AFTER INSERT ON context_entries BEGIN
      INSERT INTO context_entries_fts(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS context_entries_ad
    AFTER DELETE ON context_entries BEGIN
      INSERT INTO context_entries_fts(context_entries_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS context_entries_au
    AFTER UPDATE ON context_entries BEGIN
      INSERT INTO context_entries_fts(context_entries_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags, ''));
      INSERT INTO context_entries_fts(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags, ''));
    END;
  `);

  // ─── Session Memory Tables ─────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS ast_snapshots (
      id             INTEGER PRIMARY KEY,
      file_path      TEXT NOT NULL,
      symbol_name    TEXT NOT NULL,
      kind           TEXT NOT NULL,
      signature      TEXT NOT NULL,
      signature_hash TEXT NOT NULL,
      captured_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(file_path, symbol_name)
    );

    CREATE TABLE IF NOT EXISTS session_observations (
      id           INTEGER PRIMARY KEY,
      session_id   TEXT NOT NULL,
      type         TEXT NOT NULL,
      file_path    TEXT,
      symbol_name  TEXT,
      observation  TEXT NOT NULL,
      stale        INTEGER DEFAULT 0,
      stale_reason TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id          INTEGER PRIMARY KEY,
      session_id  TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      file_path   TEXT,
      symbol_name TEXT,
      extra_json  TEXT,
      timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ast_snapshots_file ON ast_snapshots(file_path);
    CREATE INDEX IF NOT EXISTS idx_session_observations_session ON session_observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_observations_file ON session_observations(file_path);
    CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_events_file_time ON session_events(file_path, timestamp);
  `);
}
