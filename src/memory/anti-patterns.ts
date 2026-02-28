import type Database from 'better-sqlite3';
import {
  getRecentFileChangeEvents,
  getSessionEvents,
  insertSessionEvent,
  insertObservation,
} from '../db/queries.js';

/**
 * Detects anti-patterns in the current session's event stream and emits
 * observations + anti-pattern events into the DB.
 */
export class AntiPatternDetector {
  constructor(
    private readonly db: Database.Database,
    private readonly sessionId: string,
  ) {}

  /**
   * Called after a symbol_removed event.
   * Dead-end: symbol_added + symbol_removed for the same node in one session.
   */
  checkDeadEnd(filePath: string, symbolName: string): void {
    const events = getSessionEvents(this.db, this.sessionId, [
      'symbol_added',
      'symbol_removed',
    ]).filter((e) => e.file_path === filePath && e.symbol_name === symbolName);

    const hasAdd = events.some((e) => e.event_type === 'symbol_added');
    const hasRemove = events.some((e) => e.event_type === 'symbol_removed');
    if (!hasAdd || !hasRemove) return;

    // Only emit once per file+symbol
    const alreadyDetected = getSessionEvents(this.db, this.sessionId, ['dead_end']).some(
      (e) => e.file_path === filePath && e.symbol_name === symbolName,
    );
    if (alreadyDetected) return;

    insertSessionEvent(this.db, {
      sessionId: this.sessionId,
      eventType: 'dead_end',
      filePath,
      symbolName,
      extraJson: JSON.stringify({ description: `Added then removed \`${symbolName}\`` }),
    });
    insertObservation(this.db, {
      sessionId: this.sessionId,
      type: 'anti_pattern',
      filePath,
      symbolName,
      observation: `Dead-end: \`${symbolName}\` was added then removed in this session — possible false start`,
    });
  }

  /**
   * Called after any symbol change event on a file.
   * Thrash: ≥4 change events on the same file within a 5-minute window.
   */
  checkThrash(filePath: string): void {
    const recent = getRecentFileChangeEvents(this.db, filePath, this.sessionId, 5);
    if (recent.length < 4) return;

    // Don't re-emit if we already flagged thrash for this file recently
    const recentThrash = getSessionEvents(this.db, this.sessionId, ['thrash_detected']).filter(
      (e) => e.file_path === filePath,
    );
    const last = recentThrash.at(-1);
    if (last) {
      const msAgo = Date.now() - new Date(last.timestamp).getTime();
      if (msAgo < 5 * 60 * 1000) return;
    }

    insertSessionEvent(this.db, {
      sessionId: this.sessionId,
      eventType: 'thrash_detected',
      filePath,
      extraJson: JSON.stringify({ change_count: recent.length, window_minutes: 5 }),
    });
    insertObservation(this.db, {
      sessionId: this.sessionId,
      type: 'anti_pattern',
      filePath,
      observation: `File thrashing: \`${filePath}\` changed ${recent.length}× in 5 minutes`,
    });
  }

  /**
   * Called each time a file/symbol is accessed.
   * Redundant access: same node accessed ≥5 times in one session.
   */
  checkRedundantAccess(
    count: number,
    filePath?: string,
    symbolName?: string,
  ): void {
    if (count !== 5) return; // Only trigger once, at exactly 5

    insertSessionEvent(this.db, {
      sessionId: this.sessionId,
      eventType: 'redundant_access',
      filePath,
      symbolName,
      extraJson: JSON.stringify({ count }),
    });

    const what = symbolName
      ? `\`${symbolName}\` in \`${filePath}\``
      : `\`${filePath}\``;
    insertObservation(this.db, {
      sessionId: this.sessionId,
      type: 'anti_pattern',
      filePath,
      symbolName,
      observation: `Redundant access: ${what} accessed ${count}+ times — context may not be retained between calls`,
    });
  }

  /**
   * Called after a failed_search event is recorded.
   * Repeated failed search: same query returns 0 results ≥3 times.
   */
  checkRepeatedFailedSearch(query: string, attemptCount: number): void {
    if (attemptCount !== 3) return; // Only trigger once

    insertObservation(this.db, {
      sessionId: this.sessionId,
      type: 'anti_pattern',
      observation: `Repeated failed search: \`${query}\` returned no results ${attemptCount} times — symbol may be renamed or in an unindexed file`,
    });
  }

  /**
   * Called after a tool_error event is recorded.
   * Tool error loop: same tool fails ≥3 times on the same file.
   */
  checkToolErrorLoop(toolName: string, filePath: string | undefined, errorCount: number): void {
    if (errorCount !== 3) return;

    insertObservation(this.db, {
      sessionId: this.sessionId,
      type: 'environment',
      filePath,
      observation: `Tool error loop: \`${toolName}\` failed ${errorCount} times${filePath ? ` on \`${filePath}\`` : ''} — file may be unindexed, deleted, or unreadable`,
    });
  }
}
