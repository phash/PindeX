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
  | 'variable';

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
}

export interface DependencyRecord {
  id: number;
  from_file: number;
  to_file: number;
  symbol_name: string | null;
}

export interface UsageRecord {
  id: number;
  symbol_id: number;
  used_in_file: number;
  used_at_line: number;
}

export interface TokenLogEntry {
  id: number;
  timestamp: string;
  session_id: string;
  tool_name: string;
  tokens_used: number;
  tokens_without_index: number;
  files_touched: string | null;
  query: string | null;
}

export interface SessionRecord {
  id: string;
  started_at: string;
  mode: 'indexed' | 'baseline';
  label: string | null;
  total_tokens: number;
  total_savings: number;
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
}

export interface ParsedImport {
  /** The module specifier, e.g. './auth/service' or 'express'. */
  source: string;
  /** Named symbols imported, e.g. ['Router', 'Request']. Empty for side-effect imports. */
  symbols: string[];
}

export interface ParsedFile {
  language: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  rawTokenEstimate: number;
}

// ─── Tool Input / Output Types ────────────────────────────────────────────────

export interface SearchSymbolsInput {
  query: string;
  limit?: number;
}

export interface SymbolSearchResult {
  name: string;
  kind: SymbolKind;
  signature: string;
  summary: string | null;
  file: string;
  line: number;
}

export interface GetSymbolInput {
  name: string;
  file?: string;
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
}

export interface GetContextInput {
  file: string;
  line: number;
  range?: number;
}

export interface GetContextOutput {
  code: string;
  language: string;
  startLine: number;
  endLine: number;
}

export interface GetFileSummaryInput {
  file: string;
}

export interface GetFileSummaryOutput {
  summary: string | null;
  language: string;
  symbols: Array<{ name: string; kind: SymbolKind; signature: string }>;
  imports: string[];
  exports: string[];
}

export interface FindUsagesInput {
  symbol: string;
}

export interface UsageResult {
  file: string;
  line: number;
  context: string;
}

export interface GetDependenciesInput {
  target: string;
  direction?: 'imports' | 'imported_by' | 'both';
}

export interface GetDependenciesOutput {
  imports: string[];
  importedBy: string[];
}

export interface GetProjectOverviewOutput {
  rootPath: string;
  language: string;
  entryPoints: string[];
  modules: Array<{ path: string; summary: string | null; symbolCount: number }>;
  stats: { totalFiles: number; totalSymbols: number };
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

export interface IndexerConfig {
  projectRoot: string;
  languages: string[];
  ignorePatterns: string[];
  generateSummaries: boolean;
}

export interface IndexResult {
  indexed: number;
  updated: number;
  skipped: number;
  errors: string[];
}
