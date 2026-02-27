import type Database from 'better-sqlite3';
import { getFileByPath, getAllFiles, getDependenciesByFile } from '../db/queries.js';

// ─── Token Estimation ─────────────────────────────────────────────────────────

/** Estimates token count for a raw string using ~4 chars/token heuristic. */
export function estimateFileTokens(content: string): number {
  if (!content) return 0;
  return Math.ceil(content.length / 4);
}

// ─── Tool Call Context for Estimation ────────────────────────────────────────

export interface ToolCallContext {
  tool: string;
  /** Query string (for search_symbols) */
  query?: string;
  /** Symbol name (for get_symbol) */
  name?: string;
  /** Target file path (for get_symbol, get_context, get_dependencies) */
  targetFile?: string;
  /** Actual tokens used (fallback multiplier) */
  tokensUsed?: number;
}

/** Estimates how many tokens the same request would have used WITHOUT the index.
 *
 *  This is a heuristic – not an exact measurement. The intent is to give a
 *  conservative lower bound for the "without index" scenario. */
export function estimateWithoutIndex(
  db: Database.Database,
  ctx: ToolCallContext,
): number {
  switch (ctx.tool) {
    case 'search_symbols': {
      // Without index: Claude would load all files matching the query.
      // Approximate by summing token estimates for all files that contain
      // the query string in their path (proxy for "likely relevant").
      const query = (ctx.query ?? '').toLowerCase();
      const allFiles = getAllFiles(db);

      if (!query) {
        // No query context → sum all files as worst case
        return allFiles.reduce((sum, f) => sum + (f.raw_token_estimate ?? 0), 0);
      }

      const matchingFiles = allFiles.filter((f) => f.path.toLowerCase().includes(query));
      if (matchingFiles.length === 0) {
        // Fallback: average file size * 3 files
        const avgTokens = allFiles.length > 0
          ? allFiles.reduce((s, f) => s + (f.raw_token_estimate ?? 0), 0) / allFiles.length
          : 0;
        return Math.round(avgTokens * 3);
      }
      return matchingFiles.reduce((sum, f) => sum + (f.raw_token_estimate ?? 0), 0);
    }

    case 'get_symbol': {
      // Without index: load at least the host file
      const filePath = ctx.targetFile;
      if (!filePath) return (ctx.tokensUsed ?? 50) * 10;
      const file = getFileByPath(db, filePath);
      return file?.raw_token_estimate ?? (ctx.tokensUsed ?? 50) * 10;
    }

    case 'get_context': {
      // Without index: load the entire file instead of just the snippet
      const filePath = ctx.targetFile;
      if (!filePath) return (ctx.tokensUsed ?? 150) * 5;
      const file = getFileByPath(db, filePath);
      return file?.raw_token_estimate ?? (ctx.tokensUsed ?? 150) * 5;
    }

    case 'get_file_summary': {
      // Without index: load the entire file
      const filePath = ctx.targetFile;
      if (!filePath) return (ctx.tokensUsed ?? 100) * 8;
      const file = getFileByPath(db, filePath);
      return file?.raw_token_estimate ?? (ctx.tokensUsed ?? 100) * 8;
    }

    case 'get_dependencies': {
      // Without index: load all transitive dependencies
      const filePath = ctx.targetFile;
      if (!filePath) return (ctx.tokensUsed ?? 80) * 10;
      const file = getFileByPath(db, filePath);
      if (!file) return (ctx.tokensUsed ?? 80) * 10;

      const depPaths = getDependenciesByFile(db, file.id);
      let total = file.raw_token_estimate ?? 0;
      for (const depPath of depPaths) {
        const depFile = getFileByPath(db, depPath);
        total += depFile?.raw_token_estimate ?? 0;
      }
      return total;
    }

    case 'find_usages': {
      // Without index: search through many files manually
      const allFiles = getAllFiles(db);
      const avgTokens = allFiles.length > 0
        ? allFiles.reduce((s, f) => s + (f.raw_token_estimate ?? 0), 0) / allFiles.length
        : 0;
      return Math.round(avgTokens * Math.min(allFiles.length, 5));
    }

    case 'get_project_overview': {
      // Without index: read all file headers / package.json
      const allFiles = getAllFiles(db);
      return allFiles.reduce((sum, f) => sum + Math.round((f.raw_token_estimate ?? 0) * 0.3), 0);
    }

    default: {
      // Fallback: 10× multiplier
      return (ctx.tokensUsed ?? 50) * 10;
    }
  }
}
