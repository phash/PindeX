import type Database from 'better-sqlite3';
import type { SearchSymbolsInput, SymbolSearchResult } from '../types.js';
import { searchSymbolsFts } from '../db/queries.js';
import type { FederatedDb } from '../server.js';

export function searchSymbols(
  db: Database.Database,
  input: SearchSymbolsInput,
  federatedDbs: FederatedDb[] = [],
): SymbolSearchResult[] {
  const limit = input.limit ?? 20;

  // Search primary DB
  const primary = searchSymbolsFts(db, input.query, limit).map((row) => ({
    name: row.name,
    kind: row.kind,
    signature: row.signature,
    summary: row.summary,
    file: row.file_path,
    line: row.start_line,
  }));

  if (federatedDbs.length === 0) return primary;

  // Search each federated DB and tag results with project name
  const federated = federatedDbs.flatMap(({ path, db: fedDb }) => {
    const projectName = path.split('/').pop() ?? path;
    try {
      return searchSymbolsFts(fedDb, input.query, limit).map((row) => ({
        name: row.name,
        kind: row.kind,
        signature: row.signature,
        summary: row.summary,
        file: row.file_path,
        line: row.start_line,
        project: projectName,
      }));
    } catch {
      return [];
    }
  });

  // Merge; each DB contributes up to `limit` results
  return [...primary, ...federated].slice(0, limit * (1 + federatedDbs.length));
}
