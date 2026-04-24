import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  insertSessionEvent,
  insertObservation,
  markObservationsStale,
} from '../db/queries.js';
import type { AstDiffResult } from './ast-diff.js';
import { AntiPatternDetector } from './anti-patterns.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionObserverOptions {
  db: Database.Database;
  sessionId: string;
  projectRoot: string;
}

// ─── SessionObserver ──────────────────────────────────────────────────────────

/**
 * Passive observer that hooks into tool calls and file change events.
 * Records session_events and auto-generates session_observations without
 * requiring Claude to cooperate.
 */
export class SessionObserver {
  private readonly db: Database.Database;
  private readonly sessionId: string;
  private readonly projectRoot: string;
  private readonly antiPatterns: AntiPatternDetector;

  /** In-memory access counters; keyed by "filePath" or "filePath::symbolName". */
  private readonly accessCounts = new Map<string, number>();
  /** Counts per tool name for tool errors; keyed by "toolName::filePath". */
  private readonly toolErrorCounts = new Map<string, number>();
  /** Failed search counts; keyed by query string. */
  private readonly failedSearchCounts = new Map<string, number>();
  /** Files accessed in this session (for diff-based observation filtering). */
  private readonly accessedFiles = new Set<string>();
  /** Symbols accessed: filePath -> Set<symbolName>. */
  private readonly accessedSymbols = new Map<string, Set<string>>();

  constructor(options: SessionObserverOptions) {
    this.db = options.db;
    this.sessionId = options.sessionId;
    this.projectRoot = options.projectRoot;
    this.antiPatterns = new AntiPatternDetector(options.db, options.sessionId);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called after each MCP tool invocation.
   *
   * @param toolName  The tool that was called.
   * @param args      The raw tool arguments.
   * @param result    The tool's return value (or the error object if isError=true).
   * @param isError   Whether the tool threw / returned an error object.
   */
  onToolCall(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    isError: boolean,
  ): void {
    if (isError) {
      this.recordToolError(toolName, args);
      return;
    }

    switch (toolName) {
      case 'get_symbol':
        this.handleGetSymbol(args, result);
        break;
      case 'get_file_summary':
        this.handleGetFileSummary(args, result);
        break;
      case 'get_context':
        this.handleGetContext(args);
        break;
      case 'find_usages':
        this.handleFindUsages(args);
        break;
      case 'search_symbols':
        this.handleSearchSymbols(args, result);
        break;
    }
  }

  /**
   * Called by the FileWatcher after a file is re-indexed.
   * Converts AST changes into session events and observations.
   */
  onFileDiff(diff: AstDiffResult): void {
    if (!diff.hasChanges) return;

    for (const change of diff.changes) {
      const eventType =
        change.type === 'added'
          ? 'symbol_added'
          : change.type === 'removed'
            ? 'symbol_removed'
            : 'sig_changed';

      insertSessionEvent(this.db, {
        sessionId: this.sessionId,
        eventType,
        filePath: diff.filePath,
        symbolName: change.name,
        extraJson: JSON.stringify({ description: change.description }),
      });

      // Only generate observations for symbols Claude actually accessed
      if (this.wasSymbolAccessed(diff.filePath, change.name)) {
        insertObservation(this.db, {
          sessionId: this.sessionId,
          type: eventType === 'symbol_added' ? 'symbol_added' : eventType === 'symbol_removed' ? 'symbol_removed' : 'sig_changed',
          filePath: diff.filePath,
          symbolName: change.name,
          observation: change.description,
        });
      }

      // Mark prior observations stale for changed/removed symbols
      if (change.type === 'sig_changed' || change.type === 'removed') {
        markObservationsStale(
          this.db,
          diff.filePath,
          change.name,
          change.description,
        );
      }

      // Anti-pattern: dead-end (symbol removed after being added in same session)
      if (change.type === 'removed') {
        this.antiPatterns.checkDeadEnd(diff.filePath, change.name);
      }
    }

    // Anti-pattern: file thrashing
    this.antiPatterns.checkThrash(diff.filePath);
  }

  // ─── Private handlers ────────────────────────────────────────────────────────

  private handleGetSymbol(args: Record<string, unknown>, result: unknown): void {
    const name = args.name as string;
    const sym = result as ({ file: string } | null);

    if (!sym) {
      // Symbol not found — check if it's an unindexed file
      const file = args.file as string | undefined;
      if (file && existsSync(join(this.projectRoot, file))) {
        insertSessionEvent(this.db, {
          sessionId: this.sessionId,
          eventType: 'index_blind_spot',
          filePath: file,
          symbolName: name,
          extraJson: JSON.stringify({ tool: 'get_symbol' }),
        });
      }
      return;
    }

    this.recordAccess(sym.file, name);
  }

  private handleGetFileSummary(args: Record<string, unknown>, result: unknown): void {
    const file = args.file as string;

    if (!result) {
      // Not indexed — check if it actually exists on disk
      if (existsSync(join(this.projectRoot, file))) {
        insertSessionEvent(this.db, {
          sessionId: this.sessionId,
          eventType: 'index_blind_spot',
          filePath: file,
          extraJson: JSON.stringify({ tool: 'get_file_summary' }),
        });
        insertObservation(this.db, {
          sessionId: this.sessionId,
          type: 'environment',
          filePath: file,
          observation: `\`${file}\` exists on disk but is not indexed — consider running reindex`,
        });
      }
      return;
    }

    // A file summary exposes every symbol of the file to Claude. Record each
    // one explicitly so staleness / signature-change observations are scoped
    // to symbols Claude has actually seen, not every symbol in a touched file.
    const summary = result as { symbols?: Array<{ name?: unknown }> };
    const names = (summary.symbols ?? [])
      .map((s) => (typeof s.name === 'string' ? s.name : null))
      .filter((n): n is string => n !== null);

    if (names.length === 0) {
      // No symbol detail — fall back to file-level access (e.g. an empty file).
      this.recordAccess(file);
      return;
    }

    for (const name of names) {
      this.recordAccess(file, name);
    }
  }

  private handleGetContext(args: Record<string, unknown>): void {
    const file = args.file as string;
    this.recordAccess(file);
  }

  private handleFindUsages(args: Record<string, unknown>): void {
    const symbol = args.symbol as string;
    insertSessionEvent(this.db, {
      sessionId: this.sessionId,
      eventType: 'accessed',
      symbolName: symbol,
    });
  }

  private handleSearchSymbols(args: Record<string, unknown>, result: unknown): void {
    const query = args.query as string;
    const results = result as unknown[];
    if (results && results.length > 0) return;

    const count = (this.failedSearchCounts.get(query) ?? 0) + 1;
    this.failedSearchCounts.set(query, count);

    insertSessionEvent(this.db, {
      sessionId: this.sessionId,
      eventType: 'failed_search',
      extraJson: JSON.stringify({ query, attempt: count }),
    });

    this.antiPatterns.checkRepeatedFailedSearch(query, count);
  }

  private recordToolError(toolName: string, args: Record<string, unknown>): void {
    const filePath =
      (args.file as string | undefined) ??
      (args.target as string | undefined);
    const key = `${toolName}::${filePath ?? ''}`;
    const count = (this.toolErrorCounts.get(key) ?? 0) + 1;
    this.toolErrorCounts.set(key, count);

    insertSessionEvent(this.db, {
      sessionId: this.sessionId,
      eventType: 'tool_error',
      filePath,
      extraJson: JSON.stringify({ tool: toolName }),
    });

    this.antiPatterns.checkToolErrorLoop(toolName, filePath, count);
  }

  // ─── Access tracking ─────────────────────────────────────────────────────────

  private recordAccess(filePath: string, symbolName?: string): void {
    this.accessedFiles.add(filePath);

    insertSessionEvent(this.db, {
      sessionId: this.sessionId,
      eventType: 'accessed',
      filePath,
      symbolName,
    });

    if (symbolName) {
      let syms = this.accessedSymbols.get(filePath);
      if (!syms) {
        syms = new Set();
        this.accessedSymbols.set(filePath, syms);
      }
      syms.add(symbolName);

      const key = `${filePath}::${symbolName}`;
      const count = (this.accessCounts.get(key) ?? 0) + 1;
      this.accessCounts.set(key, count);
      this.antiPatterns.checkRedundantAccess(count, filePath, symbolName);
    } else {
      const count = (this.accessCounts.get(filePath) ?? 0) + 1;
      this.accessCounts.set(filePath, count);
      this.antiPatterns.checkRedundantAccess(count, filePath);
    }
  }

  private wasSymbolAccessed(filePath: string, symbolName: string): boolean {
    // A symbol counts as "accessed" only if Claude explicitly looked at it
    // (via get_symbol / search_symbols) or saw it in a file summary result.
    // Previously, any file-level access (e.g. get_context line range) marked
    // ALL symbols in that file as accessed, which produced noisy sig_changed
    // observations for symbols Claude never actually inspected.
    return this.accessedSymbols.get(filePath)?.has(symbolName) ?? false;
  }
}
