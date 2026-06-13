import { z } from 'zod';

// ─── Zod Schemas for MCP Tool Input Validation ──────────────────────────────

const reposField = z.array(z.string()).optional();

/** A project-relative path that may not be absolute or contain ".." traversal
 *  segments. Defense-in-depth on top of the runtime resolveWithinRoot guard. */
const safeRelPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !/^[A-Za-z]:[\\/]/.test(p) &&
      !p.split(/[\\/]/).includes('..'),
    { message: 'Path must be project-relative and contain no ".." segments' },
  );

export const SearchSymbolsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  isAsync: z.boolean().optional(),
  hasTryCatch: z.boolean().optional(),
  snippet: z.boolean().optional(),
  repos: reposField,
});

export const GetSymbolSchema = z.object({
  name: z.string().min(1),
  file: z.string().optional(),
  repos: reposField,
});

export const GetContextSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  range: z.number().int().positive().optional(),
  repos: reposField,
});

export const GetFileSummarySchema = z.object({
  file: z.string().min(1),
  repos: reposField,
});

export const FindUsagesSchema = z.object({
  symbol: z.string().min(1),
  repos: reposField,
});

export const GetDependenciesSchema = z.object({
  target: z.string().min(1),
  direction: z.enum(['imports', 'imported_by', 'both']).optional(),
  repos: reposField,
});

export const GetProjectOverviewSchema = z.object({
  mode: z.enum(['brief', 'full']).optional(),
  repos: reposField,
});

export const ReindexSchema = z.object({
  target: safeRelPath.optional(),
});

export const GetTokenStatsSchema = z.object({
  session_id: z.string().optional(),
});

export const StartComparisonSchema = z.object({
  label: z.string().min(1).max(200),
  mode: z.enum(['indexed', 'baseline']),
});

export const SearchDocsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  type: z.enum(['docs', 'context', 'all']).optional(),
  repos: reposField,
});

export const GetDocChunkSchema = z.object({
  file: z.string().min(1),
  chunk_index: z.number().int().nonnegative().optional(),
  repos: reposField,
});

export const SaveContextSchema = z.object({
  content: z.string().min(1),
  tags: z.string().optional(),
});

export const GetSessionMemorySchema = z.object({
  session_id: z.string().optional(),
  file: z.string().optional(),
  symbol: z.string().optional(),
  include_stale: z.boolean().optional(),
});

// ─── Tool Name → Schema Map ─────────────────────────────────────────────────
// Note: get_api_endpoints has no input, so it is not included here.

export const TOOL_SCHEMAS: Record<string, z.ZodSchema> = {
  search_symbols: SearchSymbolsSchema,
  get_symbol: GetSymbolSchema,
  get_context: GetContextSchema,
  get_file_summary: GetFileSummarySchema,
  find_usages: FindUsagesSchema,
  get_dependencies: GetDependenciesSchema,
  get_project_overview: GetProjectOverviewSchema,
  reindex: ReindexSchema,
  get_token_stats: GetTokenStatsSchema,
  start_comparison: StartComparisonSchema,
  search_docs: SearchDocsSchema,
  get_doc_chunk: GetDocChunkSchema,
  save_context: SaveContextSchema,
  get_session_memory: GetSessionMemorySchema,
};
