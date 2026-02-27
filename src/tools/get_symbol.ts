import type Database from 'better-sqlite3';
import type { GetSymbolInput, GetSymbolOutput } from '../types.js';
import { getSymbolByName, getDependenciesByFile, getFileByPath } from '../db/queries.js';

export function getSymbol(
  db: Database.Database,
  input: GetSymbolInput,
): GetSymbolOutput | null {
  const symbol = getSymbolByName(db, input.name, input.file);
  if (!symbol) return null;

  // Get the file's import dependencies as context for this symbol
  const file = getFileByPath(db, symbol.file_path);
  const dependencies = file ? getDependenciesByFile(db, file.id) : [];

  return {
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
}
