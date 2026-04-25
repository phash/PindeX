import { readFileSync, existsSync } from 'node:fs';
import type { SearchSymbolsInput, SymbolSearchResult } from '../types.js';
import { searchSymbolsFts } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';
import { dedupByKey } from '../federation/merge.js';
import { resolveWithinRoot } from '../util/paths.js';

export function searchSymbols(
  repoSet: RepoSet,
  input: SearchSymbolsInput,
): SymbolSearchResult[] {
  const limit = input.limit ?? 20;
  const filters = { isAsync: input.isAsync, hasTryCatch: input.hasTryCatch };

  const repos = repoSet.filter(input.repos);
  const all: SymbolSearchResult[] = [];

  for (const repo of repos) {
    try {
      for (const row of searchSymbolsFts(repo.db, input.query, limit, filters)) {
        const result: SymbolSearchResult = {
          name: row.name,
          kind: row.kind,
          signature: row.signature,
          summary: row.summary,
          file: row.file_path,
          line: row.start_line,
          isAsync: row.is_async === 1,
          hasTryCatch: row.has_try_catch === 1,
          project: repo.name,
        };

        if (input.snippet && repo.path) {
          const absPath = resolveWithinRoot(repo.path, row.file_path);
          if (absPath && existsSync(absPath)) {
            try {
              const lines = readFileSync(absPath, 'utf-8').split('\n');
              const startIdx = Math.max(0, row.start_line - 1);
              result.snippet = lines.slice(startIdx, startIdx + 5).join('\n');
            } catch (err) {
              process.stderr.write(`[pindex] search_symbols snippet read failed for ${absPath}: ${String(err)}\n`);
            }
          }
        }

        all.push(result);
      }
    } catch (err) {
      process.stderr.write(`[pindex] search_symbols failed for repo '${repo.name}': ${String(err)}\n`);
    }
  }

  return dedupByKey(all, (r) => `${r.project}::${r.name}::${r.kind}`).slice(0, limit * Math.max(repos.length, 1));
}
