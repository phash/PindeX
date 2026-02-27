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

const TOOL_DEFINITIONS = [
  {
    name: 'search_symbols',
    description:
      'Search for symbols (functions, classes, types) in the indexed codebase using full-text search. Returns matching symbols without loading full file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (symbol name, partial name, or keyword)' },
        limit: { type: 'number', description: 'Maximum results to return (default: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_symbol',
    description:
      'Get details of a specific symbol: signature, location, summary, and its file dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name' },
        file: { type: 'string', description: 'Optional: file path to disambiguate' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_context',
    description:
      'Load a specific line range from a file. More token-efficient than reading entire files.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path (project-relative)' },
        line: { type: 'number', description: 'Target line number (1-indexed)' },
        range: { type: 'number', description: 'Number of lines to load (default: 30)' },
      },
      required: ['file', 'line'],
    },
  },
  {
    name: 'get_file_summary',
    description:
      'Get an overview of a file: summary, symbols, imports, and exports – without loading the full content.',
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
    description: 'Find all locations where a symbol is used across the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to find usages of' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_dependencies',
    description: 'Get the import graph for a file: what it imports and what imports it.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path (project-relative)' },
        direction: {
          type: 'string',
          enum: ['imports', 'imported_by', 'both'],
          description: 'Which direction to traverse (default: both)',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'get_project_overview',
    description:
      'Get a high-level overview of the project: entry points, modules, and statistics.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'reindex',
    description: 'Rebuild the index for a specific file or the entire project.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path to reindex, or omit to reindex all' },
      },
      required: [],
    },
  },
  {
    name: 'get_token_stats',
    description: 'Get token usage statistics for the current or a specific session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (omit for current session)' },
      },
      required: [],
    },
  },
  {
    name: 'start_comparison',
    description:
      'Start a named session for A/B comparison between indexed and baseline token usage.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable label for this session' },
        mode: {
          type: 'string',
          enum: ['indexed', 'baseline'],
          description: 'Whether to use the index (indexed) or simulate without (baseline)',
        },
      },
      required: ['label', 'mode'],
    },
  },
];

export interface ServerOptions {
  projectRoot: string;
  monitoringPort?: number;
  baselineMode?: boolean;
}

export function createMcpServer(
  db: Database.Database,
  indexer: Indexer,
  tokenLogger: TokenLogger | null,
  monitoringServerInstance: MonitoringServer | null,
  options: ServerOptions,
): Server {
  const server = new Server(
    { name: 'mcp-codebase-indexer', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  const { projectRoot, monitoringPort = 7842, baselineMode = false } = options;

  // ─── List Tools ────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // ─── Handle Tool Calls ─────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Baseline mode: all query tools return an error message
    if (baselineMode && name !== 'get_token_stats' && name !== 'start_comparison') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Index disabled for baseline measurement' }) }],
      };
    }

    let result: unknown;
    let tokensWithoutIndex = 0;

    try {
      const a = args as Record<string, unknown>;
      switch (name) {
        case 'search_symbols': {
          const r = searchSymbols(db, a as unknown as Parameters<typeof searchSymbols>[1]);
          tokensWithoutIndex = estimateResponseTokens(r) * 10;
          result = r;
          break;
        }
        case 'get_symbol': {
          const r = getSymbol(db, a as unknown as Parameters<typeof getSymbol>[1]);
          tokensWithoutIndex = r ? estimateResponseTokens(r) * 15 : 0;
          result = r;
          break;
        }
        case 'get_context': {
          const r = await getContext(db, projectRoot, a as unknown as Parameters<typeof getContext>[2]);
          tokensWithoutIndex = r ? estimateResponseTokens(r) * 5 : 0;
          result = r;
          break;
        }
        case 'get_file_summary': {
          const r = getFileSummary(db, a as unknown as Parameters<typeof getFileSummary>[1]);
          tokensWithoutIndex = r ? estimateResponseTokens(r) * 8 : 0;
          result = r;
          break;
        }
        case 'find_usages': {
          result = findUsages(db, a as unknown as Parameters<typeof findUsages>[1]);
          tokensWithoutIndex = estimateResponseTokens(result) * 10;
          break;
        }
        case 'get_dependencies': {
          result = getDependencies(db, a as unknown as Parameters<typeof getDependencies>[1]);
          tokensWithoutIndex = estimateResponseTokens(result) * 10;
          break;
        }
        case 'get_project_overview': {
          result = getProjectOverview(db, projectRoot);
          tokensWithoutIndex = estimateResponseTokens(result) * 5;
          break;
        }
        case 'reindex': {
          result = await reindex(db, indexer, a as unknown as Parameters<typeof reindex>[2]);
          break;
        }
        case 'get_token_stats': {
          result = getTokenStats(db, a as unknown as Parameters<typeof getTokenStats>[1]);
          break;
        }
        case 'start_comparison': {
          result = startComparison(db, a as unknown as Parameters<typeof startComparison>[1], monitoringPort);
          break;
        }
        default:
          result = { error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      result = { error: `Tool error: ${String(err)}` };
    }

    const text = JSON.stringify(result, null, 2);
    const tokensUsed = estimateTextTokens(text);

    // Log token usage
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
        savings_percent: 0, // simplified
        cumulative_actual: tokensUsed,
        cumulative_savings: Math.max(tokensWithoutIndex - tokensUsed, 0),
      });
    }

    return { content: [{ type: 'text', text }] };
  });

  return server;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateResponseTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}
