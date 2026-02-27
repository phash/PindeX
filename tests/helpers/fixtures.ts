import type Database from 'better-sqlite3';
import type { SymbolKind } from '../../src/types.js';

// ─── File Fixtures ────────────────────────────────────────────────────────────

export interface TestFileOptions {
  path?: string;
  language?: string;
  summary?: string | null;
  hash?: string;
  rawTokenEstimate?: number;
}

export function insertTestFile(
  db: Database.Database,
  options: TestFileOptions = {},
): number {
  const {
    path = 'src/test.ts',
    language = 'typescript',
    summary = null,
    hash = 'abc123',
    rawTokenEstimate = 100,
  } = options;

  const stmt = db.prepare(`
    INSERT INTO files (path, language, summary, last_indexed, hash, raw_token_estimate)
    VALUES (?, ?, ?, datetime('now'), ?, ?)
  `);
  const result = stmt.run(path, language, summary, hash, rawTokenEstimate);
  return result.lastInsertRowid as number;
}

// ─── Symbol Fixtures ──────────────────────────────────────────────────────────

export interface TestSymbolOptions {
  fileId: number;
  name?: string;
  kind?: SymbolKind;
  signature?: string;
  summary?: string | null;
  startLine?: number;
  endLine?: number;
  isExported?: boolean;
}

export function insertTestSymbol(
  db: Database.Database,
  options: TestSymbolOptions,
): number {
  const {
    fileId,
    name = 'testFunction',
    kind = 'function',
    signature = 'testFunction(): void',
    summary = null,
    startLine = 1,
    endLine = 10,
    isExported = false,
  } = options;

  const stmt = db.prepare(`
    INSERT INTO symbols (file_id, name, kind, signature, summary, start_line, end_line, is_exported)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    fileId,
    name,
    kind,
    signature,
    summary,
    startLine,
    endLine,
    isExported ? 1 : 0,
  );
  return result.lastInsertRowid as number;
}

// ─── Dependency Fixtures ──────────────────────────────────────────────────────

export function insertTestDependency(
  db: Database.Database,
  fromFile: number,
  toFile: number,
  symbolName: string | null = null,
): number {
  const stmt = db.prepare(`
    INSERT INTO dependencies (from_file, to_file, symbol_name)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(fromFile, toFile, symbolName);
  return result.lastInsertRowid as number;
}

// ─── Usage Fixtures ───────────────────────────────────────────────────────────

export function insertTestUsage(
  db: Database.Database,
  symbolId: number,
  usedInFile: number,
  usedAtLine: number,
): number {
  const stmt = db.prepare(`
    INSERT INTO usages (symbol_id, used_in_file, used_at_line)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(symbolId, usedInFile, usedAtLine);
  return result.lastInsertRowid as number;
}

// ─── Session Fixtures ─────────────────────────────────────────────────────────

export function insertTestSession(
  db: Database.Database,
  id: string = 'test-session-1',
  mode: 'indexed' | 'baseline' = 'indexed',
  label: string | null = 'Test Session',
): string {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, mode, label)
    VALUES (?, ?, ?)
  `);
  stmt.run(id, mode, label);
  return id;
}

// ─── Token Log Fixtures ───────────────────────────────────────────────────────

export function insertTestTokenLog(
  db: Database.Database,
  sessionId: string,
  toolName: string = 'search_symbols',
  tokensUsed: number = 50,
  tokensWithoutIndex: number = 500,
): number {
  const stmt = db.prepare(`
    INSERT INTO token_log (session_id, tool_name, tokens_used, tokens_without_index)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(sessionId, toolName, tokensUsed, tokensWithoutIndex);
  return result.lastInsertRowid as number;
}
