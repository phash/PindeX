import type Database from 'better-sqlite3';
import type { SaveContextInput, SaveContextOutput } from '../types.js';
import { insertContextEntry } from '../db/queries.js';

export function saveContext(
  db: Database.Database,
  sessionId: string,
  input: SaveContextInput,
): SaveContextOutput {
  const id = insertContextEntry(db, {
    sessionId,
    content: input.content,
    tags: input.tags ?? null,
  });

  const row = db
    .prepare('SELECT created_at FROM context_entries WHERE id = ?')
    .get(id) as { created_at: string } | undefined;

  return {
    id,
    session_id: sessionId,
    created_at: row?.created_at ?? new Date().toISOString(),
  };
}
