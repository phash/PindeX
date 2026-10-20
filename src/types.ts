// ─── Database Record Types ────────────────────────────────────────────────────

export interface FileRecord {
  id: number;
  path: string;
  language: string;
  summary: string | null;
  last_indexed: string;
  hash: string;
  raw_token_estimate: number;
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'const'
  | 'type'
  | 'interface'
  | 'enum'
  | 'variable'
  | 'route';

export interface SymbolRecord {
  id: number;
  file_id: number;
  name: string;
  kind: SymbolKind;
  signature: string;
  summary: string | null;
  start_line: number;
  end_line: number;
  is_exported: 0 | 1;
  is_async: 0 | 1;
  has_try_catch: 0 | 1;
}

export interface SessionRecord {
  id: string;
  started_at: string;
  mode: 'indexed' | 'baseline';
  label: string | null;
  total_tokens: number;
  total_savings: number;
}

export interface DocumentChunkRecord {
  id: number;
  file_id: number;
  chunk_index: number;
  heading: string | null;
  start_line: number;
  end_line: number;
  content: string;
  summary: string | null;
}

export type ObservationType =
  | 'accessed'
  | 'sig_changed'
  | 'symbol_added'
  | 'symbol_removed'
  | 'anti_pattern'
  | 'environment';

export type SessionEventType =
  | 'accessed'
  | 'symbol_added'
  | 'symbol_removed'
  | 'sig_changed'
  | 'thrash_detected'
  | 'dead_end'
  | 'failed_search'
  | 'tool_error'
  | 'index_blind_spot'
  | 'redundant_access';

export interface AstSnapshotRecord {
  id: number;
  file_path: string;
  symbol_name: string;
  kind: string;
  signature: string;
  signature_hash: string;
  captured_at: string;
}

export interface SessionObservationRecord {
  id: number;
  session_id: string;
  type: ObservationType;
  file_path: string | null;
  symbol_name: string | null;
  observation: string;
  stale: 0 | 1;
  stale_reason: string | null;
  created_at: string;
}

export interface SessionEventRecord {
  id: number;
  session_id: string;
  event_type: SessionEventType;
  file_path: string | null;
  symbol_name: string | null;
  extra_json: string | null;
  timestamp: string;
}

// ─── Parser Types ─────────────────────────────────────────────────────────────

/** Minimal AST node interface – compatible with tree-sitter SyntaxNode. */
export interface AstNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: AstNode[];
  namedChildren: AstNode[];
  childForFieldName(fieldName: string): AstNode | null;
  descendantsOfType(type: string | string[]): AstNode[];
}

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  signature: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isAsync: boolean;
  hasTryCatch: boolean;
}

export interface ParsedImport {
  /** The module specifier, e.g. './auth/service' or 'express'. */
  source: string;
  /** Named symbols imported, e.g. ['Router', 'Request']. Empty for side-effect imports. */
  symbols: string[];
}

export interface ParsedReference {
  /** 'foo' for foo(), a.foo(), new foo(). */
  callee: string;
  /** 'this', 'a', 'a.b'; null for bare calls. Truncated to 60 chars. */
  receiver: string | null;
  kind: 'call' | 'new';
  /** 1-based line of the call. */
  line: number;
  /** Name of the innermost enclosing ParsedSymbol; null at module level. */
  caller: string | null;
  /** startLine of the enclosing symbol; null at module level. */
  callerLine: number | null;
}

export interface ParsedFile {
  language: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  references: ParsedReference[];
  rawTokenEstimate: number;
}

export interface DocumentChunk {
  chunkIndex: number;
  heading: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ParsedDocument {
  language: string;
  chunks: DocumentChunk[];
  rawTokenEstimate: number;
}

// ─── Tool Input / Output Types ────────────────────────────────────────────────

export interface SearchSymbolsInput {
  query: string;
  limit?: number;
  isAsync?: boolean;
  hasTryCatch?: boolean;
  snippet?: boolean;
  repos?: string[];
}

export interface SymbolSearchResult {
  name: string;
  kind: SymbolKind;
  signature: string;
  /** Omitted when null. */
  summary?: string;
  file: string;
  line: number;
  /** Omitted when false. */
  isAsync?: boolean;
  /** Omitted when false. */
  hasTryCatch?: boolean;
  snippet?: string;
  /** Repo name; omitted when only one repo is configured. */
  project?: string;
}

export interface GetSymbolInput {
  name: string;
  file?: string;
  repos?: string[];
}

export interface MemoryContext {
  last_seen_session: string | null;
  observations: string[];
  stale: boolean;
}

export interface GetSymbolOutput {
  name: string;
  kind: SymbolKind;
  signature: string;
  summary: string | null;
  file: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  dependencies: string[];
  memory_context?: MemoryContext;
  project: string;
}

export interface GetContextInput {
  file: string;
  line: number;
  range?: number;
  repos?: string[];
}

export interface GetContextOutput {
  code: string;
  language: string;
  startLine: number;
  endLine: number;
  project: string;
}

export interface GetFileSummaryInput {
  file: string;
  repos?: string[];
}

export interface GetFileSummaryOutput {
  summary: string | null;
  language: string;
  symbols: Array<{ name: string; kind: SymbolKind; signature: string }>;
  imports: string[];
  exports: string[];
  lineCount?: number;
  tokenEstimate?: number;
  memory_context?: MemoryContext;
  project: string;
}

export interface FindUsagesInput {
  symbol: string;
  repos?: string[];
}

export interface UsageResult {
  file: string;
  line: number;
  project: string;
}

export interface GetDependenciesInput {
  target: string;
  direction?: 'imports' | 'imported_by' | 'both';
  repos?: string[];
}

export interface GetDependenciesOutput {
  file: string;
  project: string;
  imports: string[];
  importedBy: string[];
}

export interface SessionMemorySummary {
  prior_sessions: number;
  stale_observations: number;
  active_anti_patterns: string[];
  hint: string | null;
}

export interface GetProjectOverviewInput {
  mode?: 'brief' | 'full';
  repos?: string[];
}

export interface GetApiEndpointsOutput {
  endpoints: Array<{
    method: string;
    path: string;
    file: string;
    line: number;
  }>;
}

export interface IndexRecommendation {
  /** Whether using PindeX tools is expected to save tokens vs direct file reads. */
  worthwhile: boolean;
  /** Human-readable explanation with key metrics. */
  reason: string;
  /** Estimated average lines per file (derived from token estimates). */
  avgFileLinesEstimate: number;
  /** Minimum file count at which the index typically breaks even. */
  breakEvenFiles: number;
}

export interface ProjectOverviewSnapshot {
  project: string;
  rootPath: string;
  language: string;
  entryPoints: string[];
  /** Directory groups (top two path segments); present in full mode only. */
  modules?: Array<{
    dir: string;
    files: number;
    symbols: number;
    /** Only files that have a summary; omitted when none do. */
    summaries?: Array<{ path: string; summary: string }>;
  }>;
  stats: { totalFiles: number; totalSymbols: number };
  session_memory?: SessionMemorySummary;
  index_recommendation?: IndexRecommendation;
}

export interface GetProjectOverviewOutput extends ProjectOverviewSnapshot {
  /** Present when the server is configured with FEDERATION_REPOS */
  federated_projects?: ProjectOverviewSnapshot[];
}

export interface ReindexInput {
  target?: string;
}

export interface ReindexOutput {
  indexed: number;
  updated: number;
  errors: string[];
}

export interface GetTokenStatsInput {
  session_id?: string;
}

export interface TokenCallStat {
  tool: string;
  tokens_used: number;
  tokens_without_index: number;
  timestamp: string;
}

export interface GetTokenStatsOutput {
  session_id: string;
  started_at: string;
  tokens_used: number;
  tokens_saved: number;
  savings_percent: number;
  calls: TokenCallStat[];
}

export interface StartComparisonInput {
  label: string;
  mode: 'indexed' | 'baseline';
}

export interface StartComparisonOutput {
  session_id: string;
  monitoring_url: string;
}

export interface SearchDocsInput {
  query: string;
  limit?: number;
  type?: 'docs' | 'context' | 'all';
  repos?: string[];
}

export interface DocSearchResult {
  type: 'doc' | 'context';
  id: number;
  content_preview: string;
  project: string;
  /** Present for type='doc' */
  file?: string;
  /** Present for type='doc' */
  heading?: string | null;
  /** Present for type='doc' */
  start_line?: number;
  /** Present for type='context' */
  tags?: string | null;
  /** Present for type='context' */
  session_id?: string;
  /** Present for type='context' */
  created_at?: string;
}

export interface GetDocChunkInput {
  file: string;
  chunk_index?: number;
  repos?: string[];
}

export interface DocChunk {
  index: number;
  heading: string | null;
  start_line: number;
  end_line: number;
  content: string;
}

export interface GetDocChunkOutput {
  file: string;
  total_chunks: number;
  chunks: DocChunk[];
  project: string;
}

export interface SaveContextInput {
  content: string;
  tags?: string;
}

export interface SaveContextOutput {
  id: number;
  session_id: string;
  created_at: string;
}

export interface MemoryObservation {
  type: ObservationType;
  file: string | null;
  symbol: string | null;
  text: string;
  stale: boolean;
  stale_reason: string | null;
  created_at: string;
}

export interface MemoryAntiPattern {
  type: SessionEventType;
  file: string | null;
  symbol: string | null;
  text: string;
  timestamp: string;
}

export interface GetSessionMemoryInput {
  session_id?: string;
  file?: string;
  symbol?: string;
  include_stale?: boolean;
}

export interface GetSessionMemoryOutput {
  current_session: { id: string; started_at: string };
  observations: MemoryObservation[];
  anti_patterns: MemoryAntiPattern[];
  stale_count: number;
  stale_warning: string | null;
}

// ─── Monitoring / WebSocket Event Types ──────────────────────────────────────

export interface TokenEvent {
  type: 'tool_call';
  session_id: string;
  timestamp: string;
  tool: string;
  query?: string;
  tokens_actual: number;
  tokens_estimated: number;
  savings: number;
  savings_percent: number;
  cumulative_actual: number;
  cumulative_savings: number;
}

export interface SessionEvent {
  type: 'session_update' | 'session_start' | 'session_end';
  session: SessionRecord;
}

export type MonitoringEvent = TokenEvent | SessionEvent;

// ─── Indexer / Config Types ───────────────────────────────────────────────────

export interface IndexResult {
  indexed: number;
  updated: number;
  skipped: number;
  /** Rows pruned because the file no longer exists on disk. */
  removed: number;
  errors: string[];
}
