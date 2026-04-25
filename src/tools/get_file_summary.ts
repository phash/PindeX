import type { GetFileSummaryInput, GetFileSummaryOutput, SymbolKind } from '../types.js';
import {
  getFileByPath,
  getSymbolsByFileId,
  getDependenciesByFile,
  getObservationsByFile,
} from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';

export function getFileSummary(
  repoSet: RepoSet,
  input: GetFileSummaryInput,
): GetFileSummaryOutput[] {
  const repos = repoSet.filter(input.repos);
  const out: GetFileSummaryOutput[] = [];

  for (const repo of repos) {
    const file = getFileByPath(repo.db, input.file);
    if (!file) continue;

    const symbols = getSymbolsByFileId(repo.db, file.id);
    const imports = getDependenciesByFile(repo.db, file.id);
    const exports = symbols.filter((s) => s.is_exported === 1).map((s) => s.name);

    const summary: GetFileSummaryOutput = {
      summary: file.summary,
      language: file.language,
      symbols: symbols.map((s) => ({
        name: s.name,
        kind: s.kind as SymbolKind,
        signature: s.signature,
      })),
      imports,
      exports,
      tokenEstimate: file.raw_token_estimate ?? undefined,
      project: repo.name,
    };

    // Compute line count from token estimate (rough: 1 token ≈ 4 chars ≈ 0.5 lines)
    // Better: count lines stored via raw_token_estimate proxy. We expose both.
    // raw_token_estimate is already stored; derive line count from it if needed.
    // For files that have been indexed, we can read the line count from the DB.
    // Since line count is not stored, derive an estimate: ~80 chars per line.
    if (file.raw_token_estimate != null) {
      const estimatedChars = file.raw_token_estimate * 4;
      summary.lineCount = Math.round(estimatedChars / 50); // ~50 chars per line avg
    }

    // Attach memory context if prior observations exist for this file
    const observations = getObservationsByFile(repo.db, input.file, 3);
    if (observations.length > 0) {
      const hasStale = observations.some((o) => o.stale === 1);
      summary.memory_context = {
        last_seen_session: observations[0]?.session_id ?? null,
        observations: observations.map((o) => o.observation),
        stale: hasStale,
      };
    }

    out.push(summary);
  }

  return out;
}
