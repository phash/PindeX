import type Database from 'better-sqlite3';
import { normalizeRelPath } from '../util/paths.js';
import type {
  FileRecord,
  SymbolRecord,
  SessionRecord,
  SymbolKind,
  DocumentChunkRecord,
  AstSnapshotRecord,
  SessionObservationRecord,
  SessionEventRecord,
  ObservationType,
  SessionEventType,
  ParsedReference,
} from '../types.js';

/** Normalize any path to forward slashes (POSIX convention). */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Sanitizes a user query for safe use as an FTS5 MATCH expression.
 *
 * FTS5 has its own query grammar (AND/OR/NOT/NEAR, `column:term`, `*`, `^`,
 * parentheses, `+`, phrases). Common code-search tokens such as `parse()`,
 * `foo:bar`, `C++` or `@decorator` would otherwise be parsed as FTS5 syntax and
 * either raise a syntax error (silently swallowed as "no results" by the callers'
 * try/catch) or leak FTS column names via "no such column" errors. We tokenize on
 * whitespace and wrap each token as a double-quote-escaped phrase, so every term
 * is matched literally and the MATCH expression is always well-formed.
 *
 * Returns an empty-phrase expression when the query has no usable tokens.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  const parts: string[] = [];
  for (const t of tokens) {
    const base = t.replace(/\*+$/, '');
    if (base.length === 0) continue; // bare '*' carries no term
    const quoted = `"${base.replace(/"/g, '""')}"`;
    parts.push(base.length !== t.length ? `${quoted}*` : quoted);
  }
  return parts.length > 0 ? parts.join(' ') : '""';
}

// ─── File Queries ─────────────────────────────────────────────────────────────

export interface UpsertFileInput {
  path: string;
  language: string;
  hash: string;
  rawTokenEstimate: number;
  summary: string | null;
}

export function upsertFile(db: Database.Database, input: UpsertFileInput): void {
  input = { ...input, path: toForwardSlash(input.path) };
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
  const normalized = toForwardSlash(path);
  return (
    (db.prepare('SELECT * FROM files WHERE path = ?').get(normalized) as FileRecord | undefined) ?? null
  );
}

export function getAllFiles(db: Database.Database): FileRecord[] {
  return db.prepare('SELECT * FROM files ORDER BY path').all() as FileRecord[];
}

export function deleteFile(db: Database.Database, path: string): void {
  const p = toForwardSlash(path);
  db.prepare('DELETE FROM ast_snapshots WHERE file_path = ?').run(p);
  db.prepare('DELETE FROM files WHERE path = ?').run(p);
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
    INSERT OR REPLACE INTO symbols (file_id, name, kind, signature, summary, start_line, end_line, is_exported, is_async, has_try_catch)
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

export function getSymbolsByName(
  db: Database.Database,
  name: string,
  filePath?: string,
): SymbolWithFile[] {
  const base =
    'SELECT s.*, f.path AS file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ?';
  const order = ' ORDER BY s.is_exported DESC, f.path ASC, s.start_line ASC';
  if (filePath) {
    return db
      .prepare(base + ' AND f.path = ?' + order)
      .all(name, normalizeRelPath(filePath)) as SymbolWithFile[];
  }
  return db.prepare(base + order).all(name) as SymbolWithFile[];
}

export function getSymbolByName(
  db: Database.Database,
  name: string,
  filePath?: string,
): SymbolWithFile | null {
  return getSymbolsByName(db, name, filePath)[0] ?? null;
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
    const params: unknown[] = [sanitizeFtsQuery(query)];

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
  } catch (err) {
    process.stderr.write(`[pindex] FTS symbol search error: ${err}\n`);
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
    VALUES (@fromFile, @toFile, COALESCE(@symbolName, ''))
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

/** Deletes only the edges a file declares (its imports), never edges pointing at it. */
export function deleteOutgoingDependencies(
  db: Database.Database,
  fileId: number,
): void {
  db.prepare('DELETE FROM dependencies WHERE from_file = ?').run(fileId);
}

// ─── Call Reference Queries ───────────────────────────────────────────────────

export interface SymbolRefRow {
  id: number;
  file_id: number;
  file_path: string;
  caller_symbol_id: number | null;
  caller_name: string | null;
  callee_name: string;
  receiver: string | null;
  kind: 'call' | 'new';
  line: number;
}

const SYMBOL_REF_SELECT = `
  SELECT r.id, r.file_id, f.path AS file_path, r.caller_symbol_id, s.name AS caller_name,
         r.callee_name, r.receiver, r.kind, r.line
  FROM symbol_refs r
  JOIN files f ON r.file_id = f.id
  LEFT JOIN symbols s ON r.caller_symbol_id = s.id`;

/** Replaces all call references of a file. `symbolIdByKey` maps
 *  `${name}:${startLine}` to a symbol id so same-named symbols stay distinct. */
export function replaceSymbolRefs(
  db: Database.Database,
  fileId: number,
  refs: ParsedReference[],
  symbolIdByKey: Map<string, number>,
): void {
  db.prepare('DELETE FROM symbol_refs WHERE file_id = ?').run(fileId);
  const insert = db.prepare(`
    INSERT INTO symbol_refs (file_id, caller_symbol_id, callee_name, receiver, kind, line)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const ref of refs) {
    const callerId =
      ref.caller !== null && ref.callerLine !== null
        ? (symbolIdByKey.get(`${ref.caller}:${ref.callerLine}`) ?? null)
        : null;
    insert.run(fileId, callerId, ref.callee, ref.receiver, ref.kind, ref.line);
  }
}

export function getRefsByCallee(
  db: Database.Database,
  calleeName: string,
  limit = 500,
): SymbolRefRow[] {
  return db
    .prepare(`${SYMBOL_REF_SELECT} WHERE r.callee_name = ? ORDER BY f.path, r.line LIMIT ?`)
    .all(calleeName, limit) as SymbolRefRow[];
}

export function getAllRefs(db: Database.Database): SymbolRefRow[] {
  return db.prepare(`${SYMBOL_REF_SELECT} ORDER BY f.path, r.line`).all() as SymbolRefRow[];
}

// ─── Token Log Queries ────────────────────────────────────────────────────────

export interface InsertTokenLogInput {
  sessionId: string;
  toolName: string;
  tokensUsed: number;
  tokensWithoutIndex: number;
  query?: string;
}

export function insertTokenLog(
  db: Database.Database,
  input: InsertTokenLogInput,
): void {
  db.prepare(`
    INSERT INTO token_log (session_id, tool_name, tokens_used, tokens_without_index, query)
    VALUES (@sessionId, @toolName, @tokensUsed, @tokensWithoutIndex, @query)
  `).run({
    sessionId: input.sessionId,
    toolName: input.toolName,
    tokensUsed: input.tokensUsed,
    tokensWithoutIndex: input.tokensWithoutIndex,
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
      .all(sanitizeFtsQuery(query), limit) as DocFtsResult[];
  } catch (err) {
    process.stderr.write(`[pindex] FTS document search error: ${err}\n`);
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
      .all(sanitizeFtsQuery(query), limit) as ContextFtsResult[];
  } catch (err) {
    process.stderr.write(`[pindex] FTS context search error: ${err}\n`);
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
    .all(toForwardSlash(filePath)) as AstSnapshotRecord[];
}

export function deleteSnapshotsByFile(db: Database.Database, filePath: string): void {
  db.prepare('DELETE FROM ast_snapshots WHERE file_path = ?').run(toForwardSlash(filePath));
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
  includeStale = true,
  limit = 500,
): SessionObservationRecord[] {
  const staleClause = includeStale ? '' : ' AND stale = 0';
  return db
    .prepare(`SELECT * FROM session_observations WHERE session_id = ?${staleClause} ORDER BY created_at LIMIT ?`)
    .all(sessionId, limit) as SessionObservationRecord[];
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
    .all(toForwardSlash(filePath), limit) as SessionObservationRecord[];
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
    .all(toForwardSlash(filePath), symbolName, limit) as SessionObservationRecord[];
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
  `).run(reason, toForwardSlash(filePath), symbolName);
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

/**
 * Parses a SQLite CURRENT_TIMESTAMP value ('YYYY-MM-DD HH:MM:SS', UTC, no zone
 * marker) as a UTC Date. `new Date(ts)` would read it as local time.
 */
export function parseSqliteUtc(ts: string): Date {
  return new Date(ts.replace(' ', 'T') + 'Z');
}

/** Deletes rows older than `days` days. Comparison happens in SQL (same format as CURRENT_TIMESTAMP). */
export function deleteObservationsOlderThan(
  db: Database.Database,
  days: number,
): void {
  const modifier = `-${Math.trunc(days)} days`;
  db.prepare("DELETE FROM session_observations WHERE created_at < datetime('now', ?)").run(modifier);
  db.prepare("DELETE FROM session_events WHERE timestamp < datetime('now', ?)").run(modifier);
  db.prepare("DELETE FROM token_log WHERE timestamp < datetime('now', ?)").run(modifier);
}

export function deleteObservationsExceptSession(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare('DELETE FROM session_observations WHERE session_id != ?').run(sessionId);
  db.prepare('DELETE FROM session_events WHERE session_id != ?').run(sessionId);
  db.prepare('DELETE FROM token_log WHERE session_id != ?').run(sessionId);
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
         AND timestamp >= datetime('now', ?)
       ORDER BY timestamp`,
    )
    .all(sessionId, toForwardSlash(filePath), `-${windowMinutes} minutes`) as SessionEventRecord[];
}

/**
 * Check if at least one session event matching the given criteria exists.
 * Uses EXISTS + LIMIT 1 for efficiency — avoids fetching the entire event stream.
 */
export function hasMatchingSessionEvent(
  db: Database.Database,
  sessionId: string,
  eventType: SessionEventType,
  filePath?: string,
  symbolName?: string,
): boolean {
  let sql = 'SELECT 1 FROM session_events WHERE session_id = ? AND event_type = ?';
  const params: unknown[] = [sessionId, eventType];
  if (filePath) {
    sql += ' AND file_path = ?';
    params.push(toForwardSlash(filePath));
  }
  if (symbolName) {
    sql += ' AND symbol_name = ?';
    params.push(symbolName);
  }
  sql += ' LIMIT 1';
  return db.prepare(sql).get(...params) !== undefined;
}

/**
 * Get the most recent session event of a given type for a specific file.
 */
export function getLatestSessionEvent(
  db: Database.Database,
  sessionId: string,
  eventType: SessionEventType,
  filePath: string,
): SessionEventRecord | undefined {
  return db.prepare(
    `SELECT * FROM session_events
     WHERE session_id = ? AND event_type = ? AND file_path = ?
     ORDER BY timestamp DESC LIMIT 1`,
  ).get(sessionId, eventType, toForwardSlash(filePath)) as SessionEventRecord | undefined;
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
