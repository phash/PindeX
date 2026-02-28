import type Database from 'better-sqlite3';
import type {
  GetSessionMemoryInput,
  GetSessionMemoryOutput,
  ObservationType,
  SessionEventType,
} from '../types.js';
import {
  getObservationsBySession,
  getObservationsByFile,
  getObservationsByFileSymbol,
  getAntiPatternEvents,
  getSession,
} from '../db/queries.js';

export function getSessionMemory(
  db: Database.Database,
  currentSessionId: string,
  input: GetSessionMemoryInput,
): GetSessionMemoryOutput {
  const targetSessionId = input.session_id ?? currentSessionId;

  const session = getSession(db, targetSessionId);

  // Resolve observations based on optional filters
  let observations = (() => {
    if (input.file && input.symbol) {
      return getObservationsByFileSymbol(db, input.file, input.symbol, 20);
    }
    if (input.file) {
      return getObservationsByFile(db, input.file, 20);
    }
    return getObservationsBySession(db, targetSessionId);
  })();

  if (!input.include_stale) {
    observations = observations.filter((o) => o.stale === 0);
  }

  const antiPatternEvents = getAntiPatternEvents(db, targetSessionId);

  const staleCount = observations.filter((o) => o.stale === 1).length;

  return {
    current_session: {
      id: targetSessionId,
      started_at: session?.started_at ?? new Date().toISOString(),
    },
    observations: observations.map((o) => ({
      type: o.type as ObservationType,
      file: o.file_path,
      symbol: o.symbol_name,
      text: o.observation,
      stale: o.stale === 1,
      stale_reason: o.stale_reason,
      created_at: o.created_at,
    })),
    anti_patterns: antiPatternEvents.map((e) => {
      let text: string = e.event_type;
      try {
        const extra = JSON.parse(e.extra_json ?? '{}') as Record<string, unknown>;
        if (typeof extra.description === 'string') text = extra.description;
      } catch {
        // ignore
      }
      return {
        type: e.event_type as unknown as SessionEventType,
        file: e.file_path,
        symbol: e.symbol_name,
        text,
        timestamp: e.timestamp,
      };
    }),
    stale_count: staleCount,
    stale_warning:
      staleCount > 0
        ? `${staleCount} observation${staleCount > 1 ? 's' : ''} linked to code that has since changed — re-evaluate before relying on them`
        : null,
  };
}
