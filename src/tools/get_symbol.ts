import type { GetSymbolInput, GetSymbolOutput } from '../types.js';
import {
  getSymbolByName,
  getDependenciesByFile,
  getFileByPath,
  getObservationsByFileSymbol,
} from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';

export function getSymbol(repoSet: RepoSet, input: GetSymbolInput): GetSymbolOutput[] {
  const repos = repoSet.filter(input.repos);
  const out: GetSymbolOutput[] = [];

  for (const repo of repos) {
    const symbol = getSymbolByName(repo.db, input.name, input.file);
    if (!symbol) continue;

    // Get the file's import dependencies as context for this symbol
    const file = getFileByPath(repo.db, symbol.file_path);
    const dependencies = file ? getDependenciesByFile(repo.db, file.id) : [];

    const detail: GetSymbolOutput = {
      name: symbol.name,
      kind: symbol.kind,
      signature: symbol.signature,
      summary: symbol.summary,
      file: symbol.file_path,
      startLine: symbol.start_line,
      endLine: symbol.end_line,
      isExported: symbol.is_exported === 1,
      dependencies,
      project: repo.name,
    };

    // Attach memory context if prior observations exist for this symbol
    const observations = getObservationsByFileSymbol(repo.db, symbol.file_path, symbol.name, 3);
    if (observations.length > 0) {
      const hasStale = observations.some((o) => o.stale === 1);
      detail.memory_context = {
        last_seen_session: observations[0]?.session_id ?? null,
        observations: observations.map((o) => o.observation),
        stale: hasStale,
      };
    }

    out.push(detail);
  }

  return out;
}
