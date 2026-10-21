import type Database from 'better-sqlite3';
import type { GetTokenStatsInput, GetTokenStatsOutput } from '../types.js';
import { getSessionStats } from '../db/queries.js';

export function getTokenStats(
  db: Database.Database,
  input: GetTokenStatsInput,
  currentSessionId: string,
): GetTokenStatsOutput {
  const sessionId = input.session_id ?? currentSessionId;
  return getSessionStats(db, sessionId);
}
