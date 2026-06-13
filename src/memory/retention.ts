import type Database from 'better-sqlite3';
import { deleteObservationsExceptSession, deleteObservationsOlderThan } from '../db/queries.js';

/**
 * Applies the OBSERVATION_RETENTION policy.
 *
 * Supported values:
 *  - 'permanent' (default) — no deletion
 *  - 'session'             — keep only the current session's observations
 *  - '<N>d' (e.g. '30d')   — delete observations older than N days
 *
 * Unknown values log a warning and fall back to 'permanent' (no deletion).
 *
 * Extracted from the entry point so the deleting branches — which perform
 * irreversible DELETEs — are unit-testable without booting the MCP server.
 */
export function applyObservationRetention(
  db: Database.Database,
  currentSessionId: string,
  policy: string,
): void {
  if (policy === 'permanent') return;

  if (policy === 'session') {
    deleteObservationsExceptSession(db, currentSessionId);
    return;
  }

  const match = /^(\d+)d$/.exec(policy);
  if (match) {
    const days = parseInt(match[1], 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    deleteObservationsOlderThan(db, cutoff.toISOString());
    return;
  }

  process.stderr.write(
    `[pindex] Unknown OBSERVATION_RETENTION value: "${policy}" — defaulting to permanent\n`,
  );
}
