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
import type { RepoSet } from '../federation/repo-set.js';

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
      modules: [],
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
  let modules: Array<{ path: string; summary: string | null; symbolCount: number }>;

  if (mode === 'brief') {
    // Brief mode: count all symbols in one query, skip per-file lookups
    const row = db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number };
    totalSymbols = row.cnt;
    modules = files.map((f) => ({ path: f.path, summary: null, symbolCount: 0 }));
  } else {
    // Full mode: single aggregate query instead of N+1 per-file lookups
    const symbolCounts = new Map<number, number>();
    const rows = db.prepare('SELECT file_id, COUNT(*) as cnt FROM symbols GROUP BY file_id')
      .all() as Array<{ file_id: number; cnt: number }>;
    for (const row of rows) {
      symbolCounts.set(row.file_id, row.cnt);
      totalSymbols += row.cnt;
    }
    modules = files.map((f) => ({
      path: f.path,
      summary: f.summary,
      symbolCount: symbolCounts.get(f.id) ?? 0,
    }));
  }

  const snapshot: ProjectOverviewSnapshot = {
    project: name,
    rootPath: projectRoot ?? '',
    language,
    entryPoints,
    modules,
    stats: { totalFiles: files.length, totalSymbols },
  };

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
