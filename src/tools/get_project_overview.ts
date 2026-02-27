import type Database from 'better-sqlite3';
import type { GetProjectOverviewOutput } from '../types.js';
import { getAllFiles, getSymbolsByFileId } from '../db/queries.js';
import type { FederatedDb } from '../server.js';

export function getProjectOverview(
  db: Database.Database,
  projectRoot: string,
  federatedDbs: FederatedDb[] = [],
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

  const primaryResult: GetProjectOverviewOutput = {
    rootPath: projectRoot,
    language,
    entryPoints,
    modules,
    stats: { totalFiles: files.length, totalSymbols },
  };

  if (federatedDbs.length === 0) return primaryResult;

  // Append per-federated-repo stats
  const federatedProjects = federatedDbs.map(({ path, db: fedDb }) => {
    const fedFiles = getAllFiles(fedDb);
    let fedSymbols = 0;
    for (const f of fedFiles) {
      fedSymbols += getSymbolsByFileId(fedDb, f.id).length;
    }
    return {
      rootPath: path,
      stats: { totalFiles: fedFiles.length, totalSymbols: fedSymbols },
    };
  });

  return {
    ...primaryResult,
    federatedProjects,
  } as GetProjectOverviewOutput;
}
