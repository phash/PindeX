import type Database from 'better-sqlite3';
import type {
  GetProjectOverviewInput,
  GetProjectOverviewOutput,
  ProjectOverviewSnapshot,
  IndexRecommendation,
  SessionMemorySummary,
} from '../types.js';
import {
  getAllFiles,
  countStaleObservations,
  countPriorSessions,
  getAntiPatternEvents,
} from '../db/queries.js';
import { buildCallGraph, isBuiltinMethodNoise } from '../graph/call-graph.js';
import { rankHubs, detectCommunities, summarizeCommunities } from '../graph/communities.js';
import type { RepoSet } from '../federation/repo-set.js';

const MAX_MODULE_GROUPS = 50;
const MAX_HUBS = 10;
const MAX_COMMUNITIES = 8;

/** Hubs + file communities from call edges and import dependencies; undefined without call edges.
 *  Built-in-named member calls on foreign receivers (`arr.filter()`) are left out of both. */
function computeGraphInsights(
  db: Database.Database,
  files: Array<{ path: string }>,
): Pick<ProjectOverviewSnapshot, 'hubs' | 'communities'> | undefined {
  const all = buildCallGraph(db).edges;
  if (all.length === 0) return undefined;
  const edges = all.filter((e) => !isBuiltinMethodNoise(e));

  const pairWeights = new Map<string, number>();
  const bump = (a: string, b: string): void => {
    if (a === b) return;
    const k = a < b ? `${a}\0${b}` : `${b}\0${a}`;
    pairWeights.set(k, (pairWeights.get(k) ?? 0) + 1);
  };
  // Imports: weight 1 per distinct file pair (either direction counts once).
  const depPairs = new Set<string>();
  const deps = db
    .prepare(
      `SELECT DISTINCT f1.path AS a, f2.path AS b FROM dependencies d
       JOIN files f1 ON d.from_file = f1.id JOIN files f2 ON d.to_file = f2.id`,
    )
    .all() as Array<{ a: string; b: string }>;
  for (const { a, b } of deps) {
    if (a === b) continue;
    depPairs.add(a < b ? `${a}\0${b}` : `${b}\0${a}`);
  }
  for (const k of depPairs) pairWeights.set(k, 1);
  // Calls: weight 1 per call edge, aggregated by (fromFile, to.file).
  for (const e of edges) bump(e.fromFile, e.to.file);

  const weighted: Array<[string, string, number]> = [];
  const degree = new Map<string, number>();
  for (const [k, w] of [...pairWeights.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const [a, b] = k.split('\0');
    weighted.push([a, b, w]);
    degree.set(a, (degree.get(a) ?? 0) + w);
    degree.set(b, (degree.get(b) ?? 0) + w);
  }

  const assignment = detectCommunities(files.map((f) => f.path), weighted);
  return {
    hubs: rankHubs(edges, MAX_HUBS),
    communities: summarizeCommunities(assignment, degree, MAX_COMMUNITIES),
  };
}

/** Group key: first two path segments of the directory part ('.' for root files). */
function dirKey(path: string): string {
  const segments = path.split('/');
  segments.pop();
  return segments.length === 0 ? '.' : segments.slice(0, 2).join('/');
}

function groupByDirectory(
  files: Array<{ id: number; path: string; summary: string | null }>,
  symbolCounts: Map<number, number>,
): NonNullable<ProjectOverviewSnapshot['modules']> {
  type Group = NonNullable<ProjectOverviewSnapshot['modules']>[number];
  const groups = new Map<string, Group>();
  for (const f of files) {
    const dir = dirKey(f.path);
    let g = groups.get(dir);
    if (!g) {
      g = { dir, files: 0, symbols: 0 };
      groups.set(dir, g);
    }
    g.files++;
    g.symbols += symbolCounts.get(f.id) ?? 0;
    if (f.summary) (g.summaries ??= []).push({ path: f.path, summary: f.summary });
  }
  return [...groups.values()]
    .sort((a, b) => b.symbols - a.symbols || a.dir.localeCompare(b.dir))
    .slice(0, MAX_MODULE_GROUPS);
}

function buildSnapshot(
  db: Database.Database,
  name: string,
  sessionId: string,
  projectRoot?: string,
  mode: 'brief' | 'full' = 'full',
): ProjectOverviewSnapshot {
  const files = getAllFiles(db);

  if (files.length === 0) {
    return {
      project: name,
      rootPath: projectRoot ?? '',
      language: 'unknown',
      entryPoints: [],
      stats: { totalFiles: 0, totalSymbols: 0 },
    };
  }

  // Determine dominant language
  const langCounts = new Map<string, number>();
  for (const f of files) {
    langCounts.set(f.language, (langCounts.get(f.language) ?? 0) + 1);
  }
  const language =
    [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

  // Detect entry points (index files)
  const entryPoints = files
    .map((f) => f.path)
    .filter(
      (p) =>
        /\/(index|main|app)\.(ts|tsx|js)$/.test(p) ||
        /^(index|main|app)\.(ts|tsx|js)$/.test(p),
    );

  let totalSymbols = 0;
  let modules: ProjectOverviewSnapshot['modules'];
  let insights: ReturnType<typeof computeGraphInsights>;

  if (mode === 'brief') {
    // Brief mode: counts only, no per-file or per-directory data
    const row = db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number };
    totalSymbols = row.cnt;
  } else {
    const symbolCounts = new Map<number, number>();
    const rows = db.prepare('SELECT file_id, COUNT(*) as cnt FROM symbols GROUP BY file_id')
      .all() as Array<{ file_id: number; cnt: number }>;
    for (const row of rows) {
      symbolCounts.set(row.file_id, row.cnt);
      totalSymbols += row.cnt;
    }
    modules = groupByDirectory(files, symbolCounts);
    insights = computeGraphInsights(db, files);
  }

  const snapshot: ProjectOverviewSnapshot = {
    project: name,
    rootPath: projectRoot ?? '',
    language,
    entryPoints,
    stats: { totalFiles: files.length, totalSymbols },
  };

  if (modules) snapshot.modules = modules;
  if (insights) Object.assign(snapshot, insights);

  // Session memory summary (passive surfacing) — only for primary
  if (sessionId) {
    const staleCount = countStaleObservations(db);
    const priorSessions = countPriorSessions(db, sessionId);
    const antiPatterns = getAntiPatternEvents(db, sessionId).slice(0, 5).map((e) => {
      const suffix = e.file_path ? `:${e.file_path}` : '';
      return `${e.event_type}${suffix}`;
    });

    const hasContext = staleCount > 0 || antiPatterns.length > 0 || priorSessions > 0;
    const session_memory: SessionMemorySummary = {
      prior_sessions: priorSessions,
      stale_observations: staleCount,
      active_anti_patterns: antiPatterns,
      hint: hasContext ? 'call get_session_memory for details' : null,
    };
    snapshot.session_memory = session_memory;
  }

  // ── Index recommendation ──────────────────────────────────────────────────
  const BREAK_EVEN_FILES = 40;
  const BREAK_EVEN_AVG_LINES = 150;
  const tokenRow = db.prepare(
    'SELECT COALESCE(SUM(raw_token_estimate), 0) as total FROM files'
  ).get() as { total: number };
  const avgFileTokens = files.length > 0 ? (tokenRow.total as number) / files.length : 0;
  const avgFileLinesEstimate = Math.round(avgFileTokens * 4 / 50);
  const worthwhile = files.length >= BREAK_EVEN_FILES || avgFileLinesEstimate >= BREAK_EVEN_AVG_LINES;

  const recommendation: IndexRecommendation = {
    worthwhile,
    reason: worthwhile
      ? `${files.length} files, avg ~${avgFileLinesEstimate} lines/file — index tools save tokens`
      : `Small project (${files.length} files, avg ~${avgFileLinesEstimate} lines/file) — direct reads may be more efficient than index overhead`,
    avgFileLinesEstimate,
    breakEvenFiles: BREAK_EVEN_FILES,
  };
  snapshot.index_recommendation = recommendation;

  return snapshot;
}

export function getProjectOverview(
  repoSet: RepoSet,
  primaryProjectRoot: string,
  sessionId: string = 'default',
  input?: GetProjectOverviewInput,
): GetProjectOverviewOutput {
  const mode = input?.mode ?? 'full';
  const repos = repoSet.filter(input?.repos);
  const primary = repoSet.primary;

  const snapshots = repos.map((repo) =>
    buildSnapshot(
      repo.db,
      repo.name,
      repo.isPrimary ? sessionId : '',
      repo.isPrimary ? primaryProjectRoot : repo.path,
      mode,
    )
  );

  const primarySnap = snapshots.find((s) => s.project === primary.name) ?? snapshots[0];
  const federated = snapshots.filter((s) => s !== primarySnap);

  return {
    ...primarySnap,
    federated_projects: federated.length > 0 ? federated : undefined,
  };
}
