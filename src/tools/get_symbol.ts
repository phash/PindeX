import type Database from 'better-sqlite3';
import type { GetSymbolInput, GetSymbolOutput } from '../types.js';
import {
  getSymbolByName,
  getDependenciesByFile,
  getFileByPath,
  getObservationsByFileSymbol,
} from '../db/queries.js';

export function getSymbol(
  db: Database.Database,
  input: GetSymbolInput,
): GetSymbolOutput | null {
  const symbol = getSymbolByName(db, input.name, input.file);
  if (!symbol) return null;

  // Get the file's import dependencies as context for this symbol
  const file = getFileByPath(db, symbol.file_path);
  const dependencies = file ? getDependenciesByFile(db, file.id) : [];

  const output: GetSymbolOutput = {
    name: symbol.name,
    kind: symbol.kind,
    signature: symbol.signature,
    summary: symbol.summary,
    file: symbol.file_path,
    startLine: symbol.start_line,
    endLine: symbol.end_line,
    isExported: symbol.is_exported === 1,
    dependencies,
  };

  // Attach memory context if prior observations exist for this symbol
  const observations = getObservationsByFileSymbol(db, symbol.file_path, symbol.name, 3);
  if (observations.length > 0) {
    const hasStale = observations.some((o) => o.stale === 1);
    output.memory_context = {
      last_seen_session: observations[0]?.session_id ?? null,
      observations: observations.map((o) => o.observation),
      stale: hasStale,
    };
  }

  return output;
}
