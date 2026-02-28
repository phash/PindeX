import type Database from 'better-sqlite3';
import type { GetApiEndpointsOutput } from '../types.js';

export function getApiEndpoints(
  db: Database.Database,
): GetApiEndpointsOutput {
  const rows = db
    .prepare(
      `SELECT s.name, s.signature, s.start_line, f.path AS file_path
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE s.kind = 'route'
       ORDER BY f.path, s.start_line`,
    )
    .all() as Array<{ name: string; signature: string; start_line: number; file_path: string }>;

  const endpoints = rows.map((row) => {
    // name is "METHOD /path", e.g. "GET /users/:id"
    const spaceIdx = row.name.indexOf(' ');
    const method = spaceIdx >= 0 ? row.name.slice(0, spaceIdx) : row.name;
    const path = spaceIdx >= 0 ? row.name.slice(spaceIdx + 1) : row.signature;
    return {
      method,
      path,
      handler: row.name,
      file: row.file_path,
      line: row.start_line,
    };
  });

  return { endpoints };
}
