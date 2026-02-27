import type Database from 'better-sqlite3';
import type { SearchSymbolsInput, SymbolSearchResult } from '../types.js';
import { searchSymbolsFts } from '../db/queries.js';

export function searchSymbols(
  db: Database.Database,
  input: SearchSymbolsInput,
): SymbolSearchResult[] {
  const limit = input.limit ?? 20;

  const rows = searchSymbolsFts(db, input.query, limit);

  return rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    signature: row.signature,
    summary: row.summary,
    file: row.file_path,
    line: row.start_line,
  }));
}
