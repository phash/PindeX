# PindeX – MCP Codebase Indexer

MCP server that structurally indexes TypeScript/JavaScript codebases and provides targeted tools for 80–90% token reduction in AI-assisted coding sessions.

## Local Setup

```bash
npm install
npm run build
```

## Development Commands

```bash
npm test              # run all unit tests (vitest, pool: forks)
npm run test:watch    # watch mode
npm run test:coverage # coverage report (threshold: >80%)
npm run lint          # TypeScript type-check only (tsc --noEmit)
npm run build         # compile src/ → dist/
```

## Architecture

- **DB**: SQLite via `better-sqlite3` — FTS5 virtual table with triggers for symbol search
- **Parser**: `tree-sitter` + `tree-sitter-typescript` — AST-based symbol/import extraction
- **Indexer**: MD5-hash-based incremental reindexing, glob file discovery
- **MCP Tools**: 10 tools registered via `@modelcontextprotocol/sdk`
- **Monitoring**: Express + WebSocket server on port 7842 with live dashboard
- **CLI**: setup, daemon management, project indexing commands

## MCP Tools

| Tool | Purpose |
|---|---|
| `search_symbols` | FTS5 full-text search across all indexed symbols |
| `get_symbol` | Symbol details: signature, location, file dependencies |
| `get_context` | Line-range snippet from a file (token-efficient) |
| `get_file_summary` | File overview: symbols, imports, exports |
| `find_usages` | All locations where a symbol is used |
| `get_dependencies` | Import graph for a file (imports / imported_by / both) |
| `get_project_overview` | Project-level stats, entry points, module list |
| `reindex` | Rebuild index for one file or the entire project |
| `get_token_stats` | Token usage statistics for a session |
| `start_comparison` | Start A/B session (indexed vs baseline) |

## Running the MCP Server

```bash
# Start directly (stdio transport)
node dist/index.js

# Environment variables
INDEX_PATH=./.codebase-index/index.db   # SQLite DB path
PROJECT_ROOT=.                           # project to index
LANGUAGES=typescript,javascript          # comma-separated
AUTO_REINDEX=true                        # watch for file changes
GENERATE_SUMMARIES=false                 # LLM summaries (stub)
MONITORING_PORT=7842                     # dashboard port
MONITORING_AUTO_OPEN=false               # open browser on start
BASELINE_MODE=false                      # disable index (A/B testing)
TOKEN_PRICE_PER_MILLION=3.00             # for cost estimates
```

## Claude Code Setup

The `.mcp.json` in the project root is pre-configured. Claude Code picks it up automatically when you open the project.

## Goose Setup

Config file: `~/.config/goose/config.yaml`

Add the following block (replace paths):

```yaml
extensions:
  codebase-indexer:
    name: Codebase Indexer
    type: stdio
    cmd: node
    args:
      - /absolute/path/to/PindeX/dist/index.js
    envs:
      INDEX_PATH: /absolute/path/to/project/.codebase-index/index.db
      PROJECT_ROOT: /absolute/path/to/project
      LANGUAGES: typescript,javascript
      AUTO_REINDEX: "true"
      GENERATE_SUMMARIES: "false"
      MONITORING_PORT: "7842"
      MONITORING_AUTO_OPEN: "false"
      BASELINE_MODE: "false"
      TOKEN_PRICE_PER_MILLION: "3.00"
    enabled: true
    timeout: 300
```

A ready-to-copy snippet is also available in `goose-extension.yaml`.

Then restart your Goose session:
```bash
goose session start
```

## Project Structure

```
src/
├── index.ts              # entry point (MCP stdio server)
├── server.ts             # MCP tool registration
├── types.ts              # shared TypeScript interfaces
├── db/
│   ├── schema.ts         # SQLite schema + FTS5 triggers
│   ├── queries.ts        # typed DB query helpers
│   └── migrations.ts     # schema migrations (PRAGMA user_version)
├── indexer/
│   ├── index.ts          # Indexer orchestrator
│   ├── parser.ts         # tree-sitter AST parsing
│   ├── summarizer.ts     # LLM summary stub
│   └── watcher.ts        # chokidar file watcher
├── tools/                # one file per MCP tool
├── monitoring/
│   ├── server.ts         # Express + WebSocket
│   ├── token-logger.ts   # per-call token logging
│   ├── estimator.ts      # "without index" heuristic
│   └── ui/               # dashboard (Chart.js, dark theme)
└── cli/
    ├── index.ts          # CLI router
    ├── setup.ts          # one-time setup
    ├── daemon.ts         # PID-file daemon management
    └── project-detector.ts
tests/
├── setup.ts              # global mocks (tree-sitter, chokidar, open)
├── helpers/              # createTestDb(), fixtures, test server
├── db/                   # schema, migrations, queries tests
├── indexer/              # parser, indexer, watcher tests
├── tools/                # one test file per tool
├── monitoring/           # estimator, token-logger, server tests
├── cli/                  # project-detector, setup, daemon tests
└── integration/          # end-to-end MCP server tests
```

## Key Implementation Notes

- All relative imports use `.js` extension (TypeScript ESM/NodeNext resolution)
- Tests use `pool: 'forks'` in vitest — required for `better-sqlite3` native bindings
- FTS5 sync is handled by SQLite triggers (not application code)
- `get_context` reads files from disk at call time (DB stores only metadata)
- `createMonitoringApp()` and `startMonitoringServer()` are separate for testability
