import type Database from 'better-sqlite3';
import type { GetFileSummaryInput, GetFileSummaryOutput, SymbolKind } from '../types.js';
import {
  getFileByPath,
  getSymbolsByFileId,
  getDependenciesByFile,
} from '../db/queries.js';

export function getFileSummary(
  db: Database.Database,
  input: GetFileSummaryInput,
): GetFileSummaryOutput | null {
  const file = getFileByPath(db, input.file);
  if (!file) return null;

  const symbols = getSymbolsByFileId(db, file.id);
  const imports = getDependenciesByFile(db, file.id);
  const exports = symbols
    .filter((s) => s.is_exported === 1)
    .map((s) => s.name);

  return {
    summary: file.summary,
    language: file.language,
    symbols: symbols.map((s) => ({
      name: s.name,
      kind: s.kind as SymbolKind,
      signature: s.signature,
    })),
    imports,
    exports,
  };
}
