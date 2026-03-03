import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import type { Indexer } from './indexer/index.js';
import type { TokenLogger } from './monitoring/token-logger.js';
import type { MonitoringServer } from './monitoring/server.js';
import { searchSymbols } from './tools/search_symbols.js';
import { getSymbol } from './tools/get_symbol.js';
import { getContext } from './tools/get_context.js';
import { getFileSummary } from './tools/get_file_summary.js';
import { findUsages } from './tools/find_usages.js';
import { getDependencies } from './tools/get_dependencies.js';
import { getProjectOverview } from './tools/get_project_overview.js';
import { reindex } from './tools/reindex.js';
import { getTokenStats } from './tools/get_token_stats.js';
import { startComparison } from './tools/start_comparison.js';
import { searchDocs } from './tools/search_docs.js';
import { getDocChunk } from './tools/get_doc_chunk.js';
import { saveContext } from './tools/save_context.js';
import { getSessionMemory } from './tools/get_session_memory.js';
import { getApiEndpoints } from './tools/get_api_endpoints.js';
import type { SessionObserver } from './memory/observer.js';
import { TOOL_SCHEMAS } from './tools/schemas.js';
import type {
  SearchSymbolsInput,
  GetSymbolInput,
  GetContextInput,
  GetFileSummaryInput,
  FindUsagesInput,
  GetDependenciesInput,
  GetProjectOverviewInput,
  ReindexInput,
  GetTokenStatsInput,
  StartComparisonInput,
  SearchDocsInput,
  GetDocChunkInput,
  SaveContextInput,
  GetSessionMemoryInput,
} from './types.js';

/**
 * MCP tool schemas exposed to the client (name, description, JSON input schema).
 * Returned verbatim by the ListTools handler and drive input validation on the
 * client side — keep in sync with the actual tool implementations in src/tools/.
 */
const TOOL_DEFINITIONS = [
  {
    name: 'search_symbols',
    description: 'FTS search for symbols (functions, classes, types) across the indexed codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or keyword' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
        isAsync: { type: 'boolean', description: 'Filter async functions' },
        hasTryCatch: { type: 'boolean', description: 'Filter by try/catch presence' },
        snippet: { type: 'boolean', description: 'Include first 5 lines of body' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_symbol',
    description: 'Symbol details: signature, location, file dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name' },
        file: { type: 'string', description: 'File path (to disambiguate)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_context',
    description: 'Read a line range from a file (token-efficient).',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path (project-relative)' },
        line: { type: 'number', description: 'Target line (1-indexed)' },
        range: { type: 'number', description: 'Lines to read (default: 30)' },
      },
      required: ['file', 'line'],
    },
  },
  {
    name: 'get_file_summary',
    description: 'File overview: symbols, imports, exports, size. No full read.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path (project-relative)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'find_usages',
    description: 'All call sites of a symbol across the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_dependencies',
    description: 'Import graph for a file (imports / imported_by / both).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path (project-relative)' },
        direction: { type: 'string', enum: ['imports', 'imported_by', 'both'], description: 'Traversal direction (default: both)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'get_project_overview',
    description: 'Project stats, entry points, module list. mode=brief for counts only.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['brief', 'full'], description: 'brief=counts only; full=per-file symbols (default)' },
      },
      required: [],
    },
  },
  {
    name: 'get_api_endpoints',
    description: 'All HTTP endpoints (Express routes): method, path, file, line.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'reindex',
    description: 'Rebuild the symbol index (one file or entire project).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path, or omit for full reindex' },
      },
      required: [],
    },
  },
  {
    name: 'get_token_stats',
    description: 'Token usage stats for this session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (omit for current)' },
      },
      required: [],
    },
  },
  {
    name: 'start_comparison',
    description: 'Start A/B session: indexed vs baseline token usage.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Session label' },
        mode: { type: 'string', enum: ['indexed', 'baseline'], description: 'indexed or baseline' },
      },
      required: ['label', 'mode'],
    },
  },
  {
    name: 'search_docs',
    description: 'FTS search across docs and saved context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
        type: { type: 'string', enum: ['docs', 'context', 'all'], description: 'Result type filter (default: all)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_doc_chunk',
    description: 'Retrieve a document section by file and optional chunk index.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path (project-relative)' },
        chunk_index: { type: 'number', description: 'Chunk index (omit for all)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'save_context',
    description: 'Persist a fact or snippet to the cross-session context store.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to save' },
        tags: { type: 'string', description: 'Comma-separated tags' },
      },
      required: ['content'],
    },
  },
  {
    name: 'get_session_memory',
    description: 'Prior session observations, staleness warnings, anti-patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (omit for current)' },
        file: { type: 'string', description: 'Filter to file path' },
        symbol: { type: 'string', description: 'Filter to symbol name' },
        include_stale: { type: 'boolean', description: 'Include stale observations (default: false)' },
      },
      required: [],
    },
  },
];

/** Core tools exposed when EXPOSE_CORE_TOOLS_ONLY=true (omits analytics/memory/doc tools). */
const CORE_TOOL_NAMES = new Set([
  'search_symbols', 'get_symbol', 'get_context', 'get_file_summary',
  'find_usages', 'get_dependencies', 'get_project_overview', 'get_api_endpoints',
]);

/** A secondary project whose index is searched alongside the primary DB (federation). */
export interface FederatedDb {
  /** Absolute path to the federated project root (used for result attribution). */
  path: string;
  /** Open SQLite connection to the federated project's index.db. */
  db: Database.Database;
}

/** Configuration passed to {@link createMcpServer} at startup. */
export interface ServerOptions {
  /** Absolute path to the project being indexed; used by get_context and get_project_overview. */
  projectRoot: string;
  /** HTTP port of the per-project monitoring server (default: 7842). */
  monitoringPort?: number;
  /**
   * When true, all query tools return an error instead of real data.
   * Used to measure baseline token usage without the index.
   */
  baselineMode?: boolean;
  /** Additional project indexes searched during federated queries. */
  federatedDbs?: FederatedDb[];
  /** Identifies the current Claude session for token-stat grouping (default: 'default'). */
  sessionId?: string;
  /** Passive observer that records tool calls for session memory generation. */
  observer?: SessionObserver;
}

/**
 * Creates and configures the MCP stdio server with all registered tools.
 *
 * Responsibilities:
 * - Registers ListTools and CallTools request handlers
 * - Routes each tool call to its implementation in src/tools/
 * - Tracks token usage and broadcasts live stats to the monitoring UI
 * - Notifies the session observer for passive memory generation
 *
 * @param db                     Primary project SQLite database
 * @param indexer                Indexer instance used by the reindex tool
 * @param tokenLogger            Logs per-call token estimates (null = disabled)
 * @param monitoringServerInstance  WebSocket server for live dashboard updates (null = disabled)
 * @param options                Runtime configuration (see {@link ServerOptions})
 */
export function createMcpServer(
  db: Database.Database,
  indexer: Indexer,
  tokenLogger: TokenLogger | null,
  monitoringServerInstance: MonitoringServer | null,
  options: ServerOptions,
): Server {
  // Read version from package.json to stay in sync
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let version = '1.0.0';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };
    version = pkg.version;
  } catch { /* fallback */ }

  const server = new Server(
    { name: 'mcp-codebase-indexer', version },
    { capabilities: { tools: {} } },
  );

  const { projectRoot, monitoringPort = 7842, baselineMode = false, federatedDbs = [], sessionId = 'default', observer } = options;

  // ─── List Tools ────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: process.env.EXPOSE_CORE_TOOLS_ONLY === 'true'
      ? TOOL_DEFINITIONS.filter(t => CORE_TOOL_NAMES.has(t.name))
      : TOOL_DEFINITIONS,
  }));

  // ─── Handle Tool Calls ─────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs = {} } = request.params;

    // Baseline mode: all query tools return an error message
    if (baselineMode && name !== 'get_token_stats' && name !== 'start_comparison') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Index disabled for baseline measurement' }) }],
      };
    }

    // ─── Zod validation ────────────────────────────────────────────────
    let args: unknown = rawArgs;
    const schema = TOOL_SCHEMAS[name];
    if (schema) {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'Invalid arguments',
            details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
          }) }],
          isError: true,
        };
      }
      args = parsed.data;
    }

    let result: unknown;
    // Estimated token cost if the AI had to read raw source instead of using the index.
    // Each tool uses a heuristic multiplier: search results save ~10×, full-file reads ~5×, etc.
    let tokensWithoutIndex = 0;
    let heuristicMultiplier = 0;
    let toolIsError = false;

    try {
      switch (name) {
        case 'search_symbols': {
          result = searchSymbols(db, args as SearchSymbolsInput, federatedDbs, projectRoot);
          heuristicMultiplier = 10;
          break;
        }
        case 'get_symbol': {
          result = getSymbol(db, args as GetSymbolInput);
          heuristicMultiplier = result ? 15 : 0;
          break;
        }
        case 'get_context': {
          result = await getContext(db, projectRoot, args as GetContextInput);
          heuristicMultiplier = result ? 5 : 0;
          break;
        }
        case 'get_file_summary': {
          result = getFileSummary(db, args as GetFileSummaryInput);
          heuristicMultiplier = result ? 8 : 0;
          break;
        }
        case 'find_usages': {
          result = findUsages(db, args as FindUsagesInput);
          heuristicMultiplier = 10;
          break;
        }
        case 'get_dependencies': {
          result = getDependencies(db, args as GetDependenciesInput);
          heuristicMultiplier = 10;
          break;
        }
        case 'get_project_overview': {
          result = getProjectOverview(db, projectRoot, federatedDbs, sessionId, args as GetProjectOverviewInput);
          heuristicMultiplier = 5;
          break;
        }
        case 'get_api_endpoints': {
          result = getApiEndpoints(db);
          heuristicMultiplier = 8;
          break;
        }
        case 'reindex': {
          result = await reindex(db, indexer, args as ReindexInput);
          break;
        }
        case 'get_token_stats': {
          result = getTokenStats(db, args as GetTokenStatsInput);
          break;
        }
        case 'start_comparison': {
          result = startComparison(db, args as StartComparisonInput, monitoringPort);
          break;
        }
        case 'search_docs': {
          result = searchDocs(db, args as SearchDocsInput);
          heuristicMultiplier = 8;
          break;
        }
        case 'get_doc_chunk': {
          result = getDocChunk(db, args as GetDocChunkInput);
          heuristicMultiplier = result ? 3 : 0;
          break;
        }
        case 'save_context': {
          result = saveContext(db, sessionId, args as SaveContextInput);
          break;
        }
        case 'get_session_memory': {
          result = getSessionMemory(db, sessionId, args as GetSessionMemoryInput);
          break;
        }
        default:
          result = { error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      result = { error: `Tool error: ${String(err)}` };
      toolIsError = true;
    }

    // Passive observation (fire-and-forget, never throws)
    if (observer) {
      try {
        observer.onToolCall(name, args as Record<string, unknown>, result, toolIsError);
      } catch {
        // Observer failures must never affect tool responses
      }
    }

    const text = JSON.stringify(result, null, 2);
    const tokensUsed = estimateTextTokens(text);
    tokensWithoutIndex = tokensUsed * heuristicMultiplier;

    // Record token usage for this call; reindex is write-only so excluded from stats.
    if (tokenLogger && name !== 'reindex') {
      tokenLogger.log({
        toolName: name,
        tokensUsed,
        tokensWithoutIndex: Math.max(tokensWithoutIndex, tokensUsed),
        query: (args as Record<string, unknown>).query as string | undefined,
      });

      // Broadcast to monitoring UI
      monitoringServerInstance?.broadcast({
        type: 'tool_call',
        session_id: tokenLogger.getCurrentSessionId(),
        timestamp: new Date().toISOString(),
        tool: name,
        tokens_actual: tokensUsed,
        tokens_estimated: Math.max(tokensWithoutIndex, tokensUsed),
        savings: Math.max(tokensWithoutIndex - tokensUsed, 0),
        savings_percent: 0, // computed client-side in the dashboard from cumulative totals
        cumulative_actual: tokensUsed,
        cumulative_savings: Math.max(tokensWithoutIndex - tokensUsed, 0),
      });
    }

    return { content: [{ type: 'text', text }] };
  });

  return server;
}

/** Rough token estimate for a string: ~4 characters per token (GPT-style heuristic). */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Serialises `value` to JSON and delegates to {@link estimateTextTokens}. */
