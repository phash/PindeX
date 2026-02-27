import type Database from 'better-sqlite3';
import type { FindUsagesInput, UsageResult } from '../types.js';
import { getSymbolByName, getUsagesBySymbol } from '../db/queries.js';

export function findUsages(
  db: Database.Database,
  input: FindUsagesInput,
): UsageResult[] {
  const symbol = getSymbolByName(db, input.symbol);
  if (!symbol) return [];

  const usages = getUsagesBySymbol(db, symbol.id);

  return usages.map((u) => ({
    file: u.file_path,
    line: u.used_at_line,
    context: `${u.file_path}:${u.used_at_line}`,
  }));
}
