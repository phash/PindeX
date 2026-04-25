import type { FindUsagesInput, UsageResult } from '../types.js';
import { getSymbolByName, getUsagesBySymbol } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';
import { dedupByKey } from '../federation/merge.js';

export function findUsages(repoSet: RepoSet, input: FindUsagesInput): UsageResult[] {
  const repos = repoSet.filter(input.repos);
  const all: UsageResult[] = [];

  for (const repo of repos) {
    try {
      const symbol = getSymbolByName(repo.db, input.symbol);
      if (!symbol) continue;

      const usages = getUsagesBySymbol(repo.db, symbol.id);
      for (const u of usages) {
        all.push({
          file: u.file_path,
          line: u.used_at_line,
          context: `${u.file_path}:${u.used_at_line}`,
          project: repo.name,
        });
      }
    } catch (err) {
      process.stderr.write(`[pindex] find_usages failed for repo '${repo.name}': ${String(err)}\n`);
    }
  }

  return dedupByKey(all, (r) => `${r.project}::${r.file}::${r.line}`);
}
