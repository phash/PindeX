import type { GetCallPathInput, GetCallPathOutput } from '../types.js';
import type { RepoSet } from '../federation/repo-set.js';
import { buildCallGraph, findSymbolCandidates, shortestPath, type SymbolNode } from '../graph/call-graph.js';
import { fileKeyFor } from './find_usages.js';

export const DEFAULT_MAX_DEPTH = 6;

type Endpoint = { node: SymbolNode } | Extract<GetCallPathOutput, { error: string }>;

function resolveEndpoint(
  repo: RepoSet['primary'],
  side: 'from' | 'to',
  name: string,
  fileInput: string | undefined,
): Endpoint {
  const file = fileKeyFor(repo, fileInput);
  if (file === null) return { error: 'not_found', side }; // escapes the root
  const candidates = findSymbolCandidates(repo.db, name, file);
  if (candidates.length === 0) return { error: 'not_found', side };
  if (candidates.length > 1) {
    return {
      error: 'ambiguous',
      side,
      candidates: candidates.map((c) => ({ file: c.file, line: c.line, kind: c.kind })),
    };
  }
  return { node: candidates[0] };
}

/** Shortest call chain between two symbols of the primary repo. Ambiguous or
 *  unknown endpoints are returned as data so the caller can retry with `*_file`. */
export function getCallPath(repoSet: RepoSet, input: GetCallPathInput): GetCallPathOutput {
  const repo = repoSet.primary;
  const from = resolveEndpoint(repo, 'from', input.from, input.from_file);
  if ('error' in from) return from;
  const to = resolveEndpoint(repo, 'to', input.to, input.to_file);
  if ('error' in to) return to;

  const edges = buildCallGraph(repo.db).edges;
  const found = shortestPath(edges, from.node.id, to.node.id, input.max_depth ?? DEFAULT_MAX_DEPTH);
  if (!found) return { path: null, hops: 0 };
  return {
    hops: found.length,
    path: found.map((e) => ({
      from: e.from?.name ?? from.node.name,
      to: e.to.name,
      file: e.fromFile,
      line: e.line,
      confidence: e.confidence,
    })),
  };
}
