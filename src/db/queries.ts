import type Database from 'better-sqlite3';
import type {
  FileRecord,
  SymbolRecord,
  DependencyRecord,
  UsageRecord,
  TokenLogEntry,
  SessionRecord,
  SymbolKind,
} from '../types.js';

// ─── File Queries ─────────────────────────────────────────────────────────────

export interface UpsertFileInput {
  path: string;
  language: string;
  hash: string;
  rawTokenEstimate: number;
  summary: string | null;
}

export function upsertFile(db: Database.Database, input: UpsertFileInput): void {
  db.prepare(`
    INSERT INTO files (path, language, hash, raw_token_estimate, summary, last_indexed)
    VALUES (@path, @language, @hash, @rawTokenEstimate, @summary, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      language = excluded.language,
      hash = excluded.hash,
      raw_token_estimate = excluded.raw_token_estimate,
      summary = excluded.summary,
      last_indexed = excluded.last_indexed
  `).run(input);
}

export function getFileByPath(
  db: Database.Database,
  path: string,
): FileRecord | null {
  return (
    (db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRecord | undefined) ?? null
  );
}

export function getAllFiles(db: Database.Database): FileRecord[] {
  return db.prepare('SELECT * FROM files ORDER BY path').all() as FileRecord[];
}

export function deleteFile(db: Database.Database, path: string): void {
  db.prepare('DELETE FROM files WHERE path = ?').run(path);
}

// ─── Symbol Queries ───────────────────────────────────────────────────────────

export interface UpsertSymbolInput {
  fileId: number;
  name: string;
  kind: SymbolKind;
  signature: string;
  summary: string | null;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export function upsertSymbol(
  db: Database.Database,
  input: UpsertSymbolInput,
): number {
  const result = db.prepare(`
    INSERT INTO symbols (file_id, name, kind, signature, summary, start_line, end_line, is_exported)
    VALUES (@fileId, @name, @kind, @signature, @summary, @startLine, @endLine, @isExported)
  `).run({ ...input, isExported: input.isExported ? 1 : 0 });
  return result.lastInsertRowid as number;
}

export function getSymbolsByFileId(
  db: Database.Database,
  fileId: number,
): SymbolRecord[] {
  return db
    .prepare('SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line')
    .all(fileId) as SymbolRecord[];
}

export interface SymbolWithFile extends SymbolRecord {
  file_path: string;
}

export function getSymbolByName(
  db: Database.Database,
  name: string,
  filePath?: string,
): SymbolWithFile | null {
  if (filePath) {
    return (
      (db
        .prepare(
          'SELECT s.*, f.path AS file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? AND f.path = ? LIMIT 1',
        )
        .get(name, filePath) as SymbolWithFile | undefined) ?? null
    );
  }
  return (
    (db
      .prepare(
        'SELECT s.*, f.path AS file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? LIMIT 1',
      )
      .get(name) as SymbolWithFile | undefined) ?? null
  );
}

export function deleteSymbolsByFileId(
  db: Database.Database,
  fileId: number,
): void {
  db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
}

// ─── FTS5 Search ──────────────────────────────────────────────────────────────

export interface FtsSearchResult {
  id: number;
  name: string;
  kind: SymbolKind;
  signature: string;
  summary: string | null;
  start_line: number;
  file_path: string;
}

export function searchSymbolsFts(
  db: Database.Database,
  query: string,
  limit: number,
): FtsSearchResult[] {
  try {
    return db
      .prepare(
        `SELECT s.id, s.name, s.kind, s.signature, s.summary, s.start_line,
                f.path AS file_path
         FROM symbols_fts fts
         JOIN symbols s ON s.id = fts.rowid
         JOIN files f ON s.file_id = f.id
         WHERE symbols_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(query, limit) as FtsSearchResult[];
  } catch {
    // FTS query syntax errors – return empty rather than throw
    return [];
  }
}

// ─── Dependency Queries ───────────────────────────────────────────────────────

export interface UpsertDependencyInput {
  fromFile: number;
  toFile: number;
  symbolName: string | null;
}

export function upsertDependency(
  db: Database.Database,
  input: UpsertDependencyInput,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO dependencies (from_file, to_file, symbol_name)
    VALUES (@fromFile, @toFile, @symbolName)
  `).run(input);
}

export function getDependenciesByFile(
  db: Database.Database,
  fileId: number,
): string[] {
  const rows = db
    .prepare(
      'SELECT f.path FROM dependencies d JOIN files f ON d.to_file = f.id WHERE d.from_file = ?',
    )
    .all(fileId) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

export function getImportedByFile(
  db: Database.Database,
  fileId: number,
): string[] {
  const rows = db
    .prepare(
      'SELECT f.path FROM dependencies d JOIN files f ON d.from_file = f.id WHERE d.to_file = ?',
    )
    .all(fileId) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

export function deleteDependenciesByFile(
  db: Database.Database,
  fileId: number,
): void {
  db.prepare('DELETE FROM dependencies WHERE from_file = ? OR to_file = ?').run(fileId, fileId);
}

// ─── Usage Queries ────────────────────────────────────────────────────────────

export interface UpsertUsageInput {
  symbolId: number;
  usedInFile: number;
  usedAtLine: number;
}

export function upsertUsage(
  db: Database.Database,
  input: UpsertUsageInput,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO usages (symbol_id, used_in_file, used_at_line)
    VALUES (@symbolId, @usedInFile, @usedAtLine)
  `).run(input);
}

export interface UsageWithFile extends UsageRecord {
  file_path: string;
}

export function getUsagesBySymbol(
  db: Database.Database,
  symbolId: number,
): UsageWithFile[] {
  return db
    .prepare(
      `SELECT u.*, f.path AS file_path
       FROM usages u JOIN files f ON u.used_in_file = f.id
       WHERE u.symbol_id = ?
       ORDER BY f.path, u.used_at_line`,
    )
    .all(symbolId) as UsageWithFile[];
}

export function deleteUsagesByFile(db: Database.Database, fileId: number): void {
  db.prepare('DELETE FROM usages WHERE used_in_file = ?').run(fileId);
}

// ─── Token Log Queries ────────────────────────────────────────────────────────

export interface InsertTokenLogInput {
  sessionId: string;
  toolName: string;
  tokensUsed: number;
  tokensWithoutIndex: number;
  filesTouched?: string[];
  query?: string;
}

export function insertTokenLog(
  db: Database.Database,
  input: InsertTokenLogInput,
): void {
  db.prepare(`
    INSERT INTO token_log (session_id, tool_name, tokens_used, tokens_without_index, files_touched, query)
    VALUES (@sessionId, @toolName, @tokensUsed, @tokensWithoutIndex, @filesTouched, @query)
  `).run({
    sessionId: input.sessionId,
    toolName: input.toolName,
    tokensUsed: input.tokensUsed,
    tokensWithoutIndex: input.tokensWithoutIndex,
    filesTouched: input.filesTouched ? JSON.stringify(input.filesTouched) : null,
    query: input.query ?? null,
  });

  // Update session totals
  const savings = input.tokensWithoutIndex - input.tokensUsed;
  db.prepare(`
    UPDATE sessions
    SET total_tokens = total_tokens + @tokensUsed,
        total_savings = total_savings + @savings
    WHERE id = @sessionId
  `).run({ tokensUsed: input.tokensUsed, savings, sessionId: input.sessionId });
}

export interface SessionStats {
  session_id: string;
  started_at: string;
  tokens_used: number;
  tokens_saved: number;
  savings_percent: number;
  calls: Array<{
    tool: string;
    tokens_used: number;
    tokens_without_index: number;
    timestamp: string;
  }>;
}

export function getSessionStats(
  db: Database.Database,
  sessionId: string,
): SessionStats {
  const session = getSession(db, sessionId);
  const calls = db
    .prepare(
      'SELECT tool_name as tool, tokens_used, tokens_without_index, timestamp FROM token_log WHERE session_id = ? ORDER BY timestamp',
    )
    .all(sessionId) as Array<{
      tool: string;
      tokens_used: number;
      tokens_without_index: number;
      timestamp: string;
    }>;

  const tokensUsed = calls.reduce((s, c) => s + c.tokens_used, 0);
  const tokensSaved = calls.reduce((s, c) => s + (c.tokens_without_index - c.tokens_used), 0);
  const total = tokensUsed + tokensSaved;
  const savingsPercent = total > 0 ? Math.round((tokensSaved / total) * 1000) / 10 : 0;

  return {
    session_id: sessionId,
    started_at: session?.started_at ?? new Date().toISOString(),
    tokens_used: tokensUsed,
    tokens_saved: tokensSaved,
    savings_percent: savingsPercent,
    calls,
  };
}

// ─── Session Queries ──────────────────────────────────────────────────────────

export interface CreateSessionInput {
  id: string;
  mode: 'indexed' | 'baseline';
  label: string | null;
}

export function createSession(
  db: Database.Database,
  input: CreateSessionInput,
): void {
  db.prepare(`
    INSERT INTO sessions (id, mode, label)
    VALUES (@id, @mode, @label)
  `).run(input);
}

export interface UpdateSessionInput {
  totalTokens: number;
  totalSavings: number;
}

export function updateSession(
  db: Database.Database,
  sessionId: string,
  input: UpdateSessionInput,
): void {
  db.prepare(`
    UPDATE sessions SET total_tokens = @totalTokens, total_savings = @totalSavings
    WHERE id = @sessionId
  `).run({ ...input, sessionId });
}

export function getSession(
  db: Database.Database,
  sessionId: string,
): SessionRecord | null {
  return (
    (db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as SessionRecord | undefined) ?? null
  );
}

export function listSessions(db: Database.Database): SessionRecord[] {
  return db
    .prepare('SELECT * FROM sessions ORDER BY started_at DESC')
    .all() as SessionRecord[];
}
