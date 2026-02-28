import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { SearchSymbolsInput, SymbolSearchResult } from '../types.js';
import { searchSymbolsFts } from '../db/queries.js';
import type { FederatedDb } from '../server.js';

export function searchSymbols(
  db: Database.Database,
  input: SearchSymbolsInput,
  federatedDbs: FederatedDb[] = [],
  projectRoot?: string,
): SymbolSearchResult[] {
  const limit = input.limit ?? 20;
  const filters = {
    isAsync: input.isAsync,
    hasTryCatch: input.hasTryCatch,
  };

  function mapRow(row: ReturnType<typeof searchSymbolsFts>[number], root?: string): SymbolSearchResult {
    const result: SymbolSearchResult = {
      name: row.name,
      kind: row.kind,
      signature: row.signature,
      summary: row.summary,
      file: row.file_path,
      line: row.start_line,
      isAsync: row.is_async === 1,
      hasTryCatch: row.has_try_catch === 1,
    };

    if (input.snippet && root) {
      const absPath = join(root, row.file_path);
      if (existsSync(absPath)) {
        try {
          const lines = readFileSync(absPath, 'utf-8').split('\n');
          const startIdx = Math.max(0, row.start_line - 1);
          result.snippet = lines.slice(startIdx, startIdx + 5).join('\n');
        } catch {
          // ignore read errors
        }
      }
    }

    return result;
  }

  // Search primary DB
  const primary = searchSymbolsFts(db, input.query, limit, filters).map((row) =>
    mapRow(row, projectRoot),
  );

  if (federatedDbs.length === 0) return primary;

  // Search each federated DB and tag results with project name
  const federated = federatedDbs.flatMap(({ path, db: fedDb }) => {
    try {
      return searchSymbolsFts(fedDb, input.query, limit, filters).map((row) => ({
        ...mapRow(row),
        project: path.split('/').pop() ?? path,
      }));
    } catch {
      return [];
    }
  });

  // Merge; each DB contributes up to `limit` results
  return [...primary, ...federated].slice(0, limit * (1 + federatedDbs.length));
}
