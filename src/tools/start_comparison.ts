import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { StartComparisonInput, StartComparisonOutput } from '../types.js';
import { createSession } from '../db/queries.js';

export function startComparison(
  db: Database.Database,
  input: StartComparisonInput,
  monitoringPort: number = 7842,
): StartComparisonOutput {
  const sessionId = uuidv4();

  createSession(db, {
    id: sessionId,
    mode: input.mode,
    label: input.label,
  });

  return {
    session_id: sessionId,
    monitoring_url: `http://localhost:${monitoringPort}`,
  };
}
