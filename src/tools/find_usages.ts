import type { FindUsagesAmbiguous, FindUsagesInput, UsageResult } from '../types.js';
import type { RepoSet, Repo } from '../federation/repo-set.js';
import { getRefsByCallee } from '../db/queries.js';
import { findSymbolCandidates, resolveRefs, type SymbolNode } from '../graph/call-graph.js';
import { relative, isAbsolute } from 'node:path';
import { resolveWithinRoot } from '../util/paths.js';

/** Max usages returned (applied after resolution, so heavy decoy names can't hide real call sites). */
export const MAX_USAGES = 500;

/** Maps the user's `file` to the index's repo-relative form; null = escapes the root. */
export function fileKeyFor(repo: Repo, file: string | undefined): string | undefined | null {
  if (!file || !repo.path) return file;
  const abs = resolveWithinRoot(repo.path, file);
  if (!abs) return null;
  return isAbsolute(file) ? relative(repo.path, abs) : file;
}

/** Call sites of a symbol, resolved through the call graph. Several definitions
 *  of the name without a `file` hint yield `{ error: 'ambiguous', candidates }`
 *  (as data, not an exception) so the caller can retry with `file`. */
export function findUsages(
  repoSet: RepoSet,
  input: FindUsagesInput,
): UsageResult[] | FindUsagesAmbiguous {
  const repos = repoSet.filter(input.repos);
  const multiRepo = repoSet.filter().length > 1;

  const targets: Array<{ repo: Repo; candidates: SymbolNode[] }> = [];
  for (const repo of repos) {
    const file = fileKeyFor(repo, input.file);
    if (file === null) continue;
    const candidates = findSymbolCandidates(repo.db, input.symbol, file);
    if (candidates.length > 0) targets.push({ repo, candidates });
  }

  // With `file`, every same-named definition in that file is a target
  // (e.g. methods of two classes); without it, a repeated name is ambiguous.
  if (!input.file && targets.some((t) => t.candidates.length > 1)) {
    return {
      error: 'ambiguous',
      candidates: targets.flatMap(({ repo, candidates }) =>
        candidates.map((c) => ({
          file: c.file,
          line: c.line,
          kind: c.kind,
          ...(multiRepo ? { project: repo.name } : {}),
        })),
      ),
    };
  }

  const usages: UsageResult[] = [];
  for (const { repo, candidates } of targets) {
    const targetIds = new Set(candidates.map((c) => c.id));
    // All refs for the name (idx_symbol_refs_callee); the cap applies to the filtered result.
    const refs = getRefsByCallee(repo.db, input.symbol, -1);
    for (const edge of resolveRefs(repo.db, refs).edges) {
      if (!targetIds.has(edge.to.id)) continue;
      const usage: UsageResult = {
        file: edge.fromFile,
        line: edge.line,
        caller: edge.from?.name ?? null,
        confidence: edge.confidence,
      };
      if (multiRepo) usage.project = repo.name;
      usages.push(usage);
    }
  }
  return usages.slice(0, MAX_USAGES);
}
