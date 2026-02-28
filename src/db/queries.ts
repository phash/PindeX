import { sep } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  FileRecord,
  SymbolRecord,
  DependencyRecord,
  UsageRecord,
  TokenLogEntry,
  SessionRecord,
  SymbolKind,
  DocumentChunkRecord,
  ContextEntryRecord,
  AstSnapshotRecord,
  SessionObservationRecord,
  SessionEventRecord,
  ObservationType,
  SessionEventType,
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
  // Normalise to the platform separator so forward-slash and backslash inputs
  // both match the paths stored by the indexer on Windows (backslash) / Unix (slash).
  const normalized = path.replace(/[\\/]/g, sep);
  return (
    (db.prepare('SELECT * FROM files WHERE path = ?').get(normalized) as FileRecord | undefined) ?? null
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
  isAsync: boolean;
  hasTryCatch: boolean;
}

export function upsertSymbol(
  db: Database.Database,
  input: UpsertSymbolInput,
): number {
  const result = db.prepare(`
    INSERT INTO symbols (file_id, name, kind, signature, summary, start_line, end_line, is_exported, is_async, has_try_catch)
    VALUES (@fileId, @name, @kind, @signature, @summary, @startLine, @endLine, @isExported, @isAsync, @hasTryCatch)
  `).run({
    ...input,
    isExported: input.isExported ? 1 : 0,
    isAsync: input.isAsync ? 1 : 0,
    hasTryCatch: input.hasTryCatch ? 1 : 0,
  });
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
  is_async: number;
  has_try_catch: number;
}

export function searchSymbolsFts(
  db: Database.Database,
  query: string,
  limit: number,
  filters?: { isAsync?: boolean; hasTryCatch?: boolean },
): FtsSearchResult[] {
  try {
    let sql = `SELECT s.id, s.name, s.kind, s.signature, s.summary, s.start_line,
                      s.is_async, s.has_try_catch, f.path AS file_path
               FROM symbols_fts fts
               JOIN symbols s ON s.id = fts.rowid
               JOIN files f ON s.file_id = f.id
               WHERE symbols_fts MATCH ?`;
    const params: unknown[] = [query];

    if (filters?.isAsync !== undefined) {
      sql += ` AND s.is_async = ?`;
      params.push(filters.isAsync ? 1 : 0);
    }
    if (filters?.hasTryCatch !== undefined) {
      sql += ` AND s.has_try_catch = ?`;
      params.push(filters.hasTryCatch ? 1 : 0);
    }

    sql += ` ORDER BY fts.rank LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params) as FtsSearchResult[];
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

// ─── Document Chunk Queries ───────────────────────────────────────────────────

export interface InsertDocumentChunkInput {
  fileId: number;
  chunkIndex: number;
  heading: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

export function insertDocumentChunk(
  db: Database.Database,
  input: InsertDocumentChunkInput,
): number {
  const result = db.prepare(`
    INSERT INTO documents (file_id, chunk_index, heading, start_line, end_line, content)
    VALUES (@fileId, @chunkIndex, @heading, @startLine, @endLine, @content)
  `).run(input);
  return result.lastInsertRowid as number;
}

export function deleteDocumentChunksByFileId(
  db: Database.Database,
  fileId: number,
): void {
  db.prepare('DELETE FROM documents WHERE file_id = ?').run(fileId);
}

export function getDocumentChunksByFileId(
  db: Database.Database,
  fileId: number,
): DocumentChunkRecord[] {
  return db
    .prepare('SELECT * FROM documents WHERE file_id = ? ORDER BY chunk_index')
    .all(fileId) as DocumentChunkRecord[];
}

export interface DocFtsResult {
  id: number;
  file_id: number;
  chunk_index: number;
  heading: string | null;
  start_line: number;
  content: string;
  file_path: string;
}

export function searchDocumentsFts(
  db: Database.Database,
  query: string,
  limit: number,
): DocFtsResult[] {
  try {
    return db
      .prepare(
        `SELECT d.id, d.file_id, d.chunk_index, d.heading, d.start_line, d.content,
                f.path AS file_path
         FROM documents_fts fts
         JOIN documents d ON d.id = fts.rowid
         JOIN files f ON d.file_id = f.id
         WHERE documents_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(query, limit) as DocFtsResult[];
  } catch {
    return [];
  }
}

// ─── Context Entry Queries ────────────────────────────────────────────────────

export interface InsertContextEntryInput {
  sessionId: string;
  content: string;
  tags: string | null;
}

export function insertContextEntry(
  db: Database.Database,
  input: InsertContextEntryInput,
): number {
  const result = db.prepare(`
    INSERT INTO context_entries (session_id, content, tags)
    VALUES (@sessionId, @content, @tags)
  `).run(input);
  return result.lastInsertRowid as number;
}

export interface ContextFtsResult {
  id: number;
  session_id: string;
  content: string;
  tags: string | null;
  created_at: string;
}

export function searchContextEntriesFts(
  db: Database.Database,
  query: string,
  limit: number,
): ContextFtsResult[] {
  try {
    return db
      .prepare(
        `SELECT ce.id, ce.session_id, ce.content, ce.tags, ce.created_at
         FROM context_entries_fts fts
         JOIN context_entries ce ON ce.id = fts.rowid
         WHERE context_entries_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(query, limit) as ContextFtsResult[];
  } catch {
    return [];
  }
}

// ─── AST Snapshot Queries ──────────────────────────────────────────────────────

export interface UpsertAstSnapshotInput {
  filePath: string;
  symbolName: string;
  kind: string;
  signature: string;
  signatureHash: string;
}

export function upsertAstSnapshot(
  db: Database.Database,
  input: UpsertAstSnapshotInput,
): void {
  db.prepare(`
    INSERT INTO ast_snapshots (file_path, symbol_name, kind, signature, signature_hash, captured_at)
    VALUES (@filePath, @symbolName, @kind, @signature, @signatureHash, CURRENT_TIMESTAMP)
    ON CONFLICT(file_path, symbol_name) DO UPDATE SET
      kind = excluded.kind,
      signature = excluded.signature,
      signature_hash = excluded.signature_hash,
      captured_at = CURRENT_TIMESTAMP
  `).run(input);
}

export function getSnapshotsByFile(
  db: Database.Database,
  filePath: string,
): AstSnapshotRecord[] {
  return db
    .prepare('SELECT * FROM ast_snapshots WHERE file_path = ?')
    .all(filePath) as AstSnapshotRecord[];
}

export function deleteSnapshotsByFile(db: Database.Database, filePath: string): void {
  db.prepare('DELETE FROM ast_snapshots WHERE file_path = ?').run(filePath);
}

// ─── Session Observation Queries ───────────────────────────────────────────────

export interface InsertObservationInput {
  sessionId: string;
  type: ObservationType;
  filePath?: string;
  symbolName?: string;
  observation: string;
}

export function insertObservation(
  db: Database.Database,
  input: InsertObservationInput,
): number {
  const result = db.prepare(`
    INSERT INTO session_observations (session_id, type, file_path, symbol_name, observation)
    VALUES (@sessionId, @type, @filePath, @symbolName, @observation)
  `).run({
    sessionId: input.sessionId,
    type: input.type,
    filePath: input.filePath ?? null,
    symbolName: input.symbolName ?? null,
    observation: input.observation,
  });
  return result.lastInsertRowid as number;
}

export function getObservationsBySession(
  db: Database.Database,
  sessionId: string,
): SessionObservationRecord[] {
  return db
    .prepare('SELECT * FROM session_observations WHERE session_id = ? ORDER BY created_at')
    .all(sessionId) as SessionObservationRecord[];
}

export function getObservationsByFile(
  db: Database.Database,
  filePath: string,
  limit = 5,
): SessionObservationRecord[] {
  return db
    .prepare(
      'SELECT * FROM session_observations WHERE file_path = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(filePath, limit) as SessionObservationRecord[];
}

export function getObservationsByFileSymbol(
  db: Database.Database,
  filePath: string,
  symbolName: string,
  limit = 5,
): SessionObservationRecord[] {
  return db
    .prepare(
      `SELECT * FROM session_observations
       WHERE file_path = ? AND symbol_name = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(filePath, symbolName, limit) as SessionObservationRecord[];
}

export function markObservationsStale(
  db: Database.Database,
  filePath: string,
  symbolName: string,
  reason: string,
): void {
  db.prepare(`
    UPDATE session_observations
    SET stale = 1, stale_reason = ?
    WHERE file_path = ? AND symbol_name = ? AND stale = 0
  `).run(reason, filePath, symbolName);
}

export function countStaleObservations(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM session_observations WHERE stale = 1')
    .get() as { cnt: number };
  return row.cnt;
}

export function countPriorSessions(
  db: Database.Database,
  excludeSessionId: string,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(DISTINCT session_id) as cnt FROM session_observations WHERE session_id != ?',
    )
    .get(excludeSessionId) as { cnt: number };
  return row.cnt;
}

export function deleteObservationsOlderThan(
  db: Database.Database,
  cutoffIso: string,
): void {
  db.prepare('DELETE FROM session_observations WHERE created_at < ?').run(cutoffIso);
}

export function deleteObservationsExceptSession(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare('DELETE FROM session_observations WHERE session_id != ?').run(sessionId);
  db.prepare('DELETE FROM session_events WHERE session_id != ?').run(sessionId);
}

// ─── Session Event Queries ─────────────────────────────────────────────────────

export interface InsertSessionEventInput {
  sessionId: string;
  eventType: SessionEventType;
  filePath?: string;
  symbolName?: string;
  extraJson?: string;
}

export function insertSessionEvent(
  db: Database.Database,
  input: InsertSessionEventInput,
): number {
  const result = db.prepare(`
    INSERT INTO session_events (session_id, event_type, file_path, symbol_name, extra_json)
    VALUES (@sessionId, @eventType, @filePath, @symbolName, @extraJson)
  `).run({
    sessionId: input.sessionId,
    eventType: input.eventType,
    filePath: input.filePath ?? null,
    symbolName: input.symbolName ?? null,
    extraJson: input.extraJson ?? null,
  });
  return result.lastInsertRowid as number;
}

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

export function getRecentFileChangeEvents(
  db: Database.Database,
  filePath: string,
  sessionId: string,
  windowMinutes: number,
): SessionEventRecord[] {
  return db
    .prepare(
      `SELECT * FROM session_events
       WHERE session_id = ?
         AND file_path = ?
         AND event_type IN ('symbol_added', 'symbol_removed', 'sig_changed')
         AND timestamp >= datetime('now', '-' || ? || ' minutes')
       ORDER BY timestamp`,
    )
    .all(sessionId, filePath, windowMinutes) as SessionEventRecord[];
}

export function getAntiPatternEvents(
  db: Database.Database,
  sessionId: string,
): SessionEventRecord[] {
  return db
    .prepare(
      `SELECT * FROM session_events
       WHERE session_id = ?
         AND event_type IN ('thrash_detected','dead_end','failed_search','tool_error','index_blind_spot','redundant_access')
       ORDER BY timestamp DESC`,
    )
    .all(sessionId) as SessionEventRecord[];
}

/** Returns anti-pattern events across ALL sessions, newest first. Used by the monitoring dashboard. */
export function getAllAntiPatternEvents(
  db: Database.Database,
  limit = 100,
): SessionEventRecord[] {
  return db
    .prepare(
      `SELECT * FROM session_events
       WHERE event_type IN ('thrash_detected','dead_end','failed_search','tool_error','index_blind_spot','redundant_access')
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit) as SessionEventRecord[];
}

/** Returns observations across ALL sessions, newest first. Used by the monitoring dashboard. */
export function getAllObservations(
  db: Database.Database,
  limit = 50,
): SessionObservationRecord[] {
  return db
    .prepare('SELECT * FROM session_observations ORDER BY created_at DESC LIMIT ?')
    .all(limit) as SessionObservationRecord[];
}
