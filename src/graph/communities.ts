import type { CallEdge } from './call-graph.js';

export interface Hub { symbol: string; file: string; callerFiles: number }
export interface Community { id: number; label: string; size: number; topFiles: string[] }

const MAX_TOP_FILES = 3;

/** Symbols called from the most distinct files; ties by symbol name asc (then file asc). */
export function rankHubs(edges: CallEdge[], limit: number): Hub[] {
  const callers = new Map<number, { symbol: string; file: string; files: Set<string> }>();
  for (const e of edges) {
    let entry = callers.get(e.to.id);
    if (!entry) {
      entry = { symbol: e.to.name, file: e.to.file, files: new Set() };
      callers.set(e.to.id, entry);
    }
    entry.files.add(e.fromFile);
  }
  return [...callers.values()]
    .map((c) => ({ symbol: c.symbol, file: c.file, callerFiles: c.files.size }))
    .sort(
      (a, b) =>
        b.callerFiles - a.callerFiles ||
        (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
    )
    .slice(0, limit);
}

/**
 * Deterministic label propagation (synchronous updates). Every file starts with its own
 * label (index in path-sorted order); per sweep each file adopts the neighbour label with the
 * highest summed edge weight, ties to the smallest label. Isolated files are dropped.
 * Returned ids are renumbered 0..n-1 by first appearance in path-sorted order.
 */
export function detectCommunities(
  files: string[],
  weightedEdges: Array<[string, string, number]>,
  maxIter = 20,
): Map<string, number> {
  const sorted = [...new Set(files)].sort();
  const index = new Map(sorted.map((f, i) => [f, i]));

  const adj: Map<number, number>[] = sorted.map(() => new Map());
  for (const [a, b, w] of weightedEdges) {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined || i === j || w <= 0) continue;
    adj[i].set(j, (adj[i].get(j) ?? 0) + w);
    adj[j].set(i, (adj[j].get(i) ?? 0) + w);
  }

  let labels = sorted.map((_, i) => i);
  for (let iter = 0; iter < maxIter; iter++) {
    const next = labels.slice();
    let changed = false;
    for (let i = 0; i < sorted.length; i++) {
      if (adj[i].size === 0) continue;
      const sums = new Map<number, number>();
      for (const [n, w] of adj[i]) sums.set(labels[n], (sums.get(labels[n]) ?? 0) + w);
      let best = -1;
      let bestW = -Infinity;
      for (const [label, w] of sums) {
        if (w > bestW || (w === bestW && label < best)) {
          best = label;
          bestW = w;
        }
      }
      if (best !== labels[i]) {
        next[i] = best;
        changed = true;
      }
    }
    labels = next;
    if (!changed) break;
  }

  const ids = new Map<number, number>();
  const result = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    if (adj[i].size === 0) continue;
    let id = ids.get(labels[i]);
    if (id === undefined) {
      id = ids.size;
      ids.set(labels[i], id);
    }
    result.set(sorted[i], id);
  }
  return result;
}

function dirSegments(path: string): string[] {
  const parts = path.split('/');
  parts.pop();
  return parts;
}

function commonDirPrefix(paths: string[]): string {
  let prefix = dirSegments(paths[0]);
  for (const p of paths.slice(1)) {
    const segs = dirSegments(p);
    let n = 0;
    while (n < prefix.length && n < segs.length && prefix[n] === segs[n]) n++;
    prefix = prefix.slice(0, n);
  }
  return prefix.join('/');
}

/** Largest communities first (ties by id); label = common directory prefix or top file's basename. */
export function summarizeCommunities(
  assignment: Map<string, number>,
  degree: Map<string, number>,
  limit: number,
): Community[] {
  const members = new Map<number, string[]>();
  for (const [file, id] of assignment) {
    const list = members.get(id);
    if (list) list.push(file);
    else members.set(id, [file]);
  }
  const deg = (f: string): number => degree.get(f) ?? 0;
  return [...members.entries()]
    .map(([id, files]) => {
      const ranked = files.slice().sort((a, b) => deg(b) - deg(a) || (a < b ? -1 : a > b ? 1 : 0));
      const label = commonDirPrefix(files) || ranked[0].split('/').pop()!;
      return { id, label, size: files.length, topFiles: ranked.slice(0, MAX_TOP_FILES) };
    })
    .sort((a, b) => b.size - a.size || a.id - b.id)
    .slice(0, limit);
}
