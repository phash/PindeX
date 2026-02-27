import type Database from 'better-sqlite3';
import type { GetProjectOverviewOutput } from '../types.js';
import { getAllFiles, getSymbolsByFileId } from '../db/queries.js';

export function getProjectOverview(
  db: Database.Database,
  projectRoot: string,
): GetProjectOverviewOutput {
  const files = getAllFiles(db);

  if (files.length === 0) {
    return {
      rootPath: projectRoot,
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
  const language = [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

  // Detect entry points (index files)
  const entryPoints = files
    .map((f) => f.path)
    .filter((p) => /\/(index|main|app)\.(ts|tsx|js)$/.test(p) || /^(index|main|app)\.(ts|tsx|js)$/.test(p));

  // Build module summaries
  let totalSymbols = 0;
  const modules = files.map((f) => {
    const symbols = getSymbolsByFileId(db, f.id);
    totalSymbols += symbols.length;
    return {
      path: f.path,
      summary: f.summary,
      symbolCount: symbols.length,
    };
  });

  return {
    rootPath: projectRoot,
    language,
    entryPoints,
    modules,
    stats: { totalFiles: files.length, totalSymbols },
  };
}
