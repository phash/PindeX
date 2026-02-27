# PindeX – MCP Codebase Indexer

**Structural codebase indexing for AI coding assistants — 80–90% fewer tokens per session.**

PindeX is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that parses your TypeScript/JavaScript project with `tree-sitter`, stores symbols, imports, and dependency graphs in a local SQLite database, and exposes 10 targeted tools so AI assistants can answer questions about your code without reading entire files.

---

## Contents

- [How It Works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [MCP Tools](#mcp-tools)
- [Environment Variables](#environment-variables)
- [Integrations](#integrations)
  - [Claude Code](#claude-code)
  - [Goose](#goose)
- [CLI Reference](#cli-reference)
- [Monitoring Dashboard](#monitoring-dashboard)
- [Development](#development)
- [Project Structure](#project-structure)

---

## How It Works

```
Your project files
       │
       ▼
  tree-sitter AST          MD5 hash → skip unchanged files
       │
       ▼
  SQLite (FTS5)
  ├── files          (path, hash, token estimate)
  ├── symbols        (name, kind, signature, lines)
  ├── dependencies   (import graph)
  ├── usages         (symbol → call sites)
  └── token_log      (per-session metrics)
       │
       ▼
  10 MCP tools  ──── stdio ────► Claude Code / Goose / any MCP client
```

Instead of sending full file contents to the AI, PindeX lets it call `search_symbols`, `get_context`, or `get_file_summary` — returning only what it actually needs.
Token savings are tracked per session and visible in a live web dashboard.

---

## Requirements

| Dependency | Version |
|---|---|
| Node.js | ≥ 18.0.0 |
| npm | ≥ 8 |
| Operating System | macOS, Linux, Windows (WSL recommended) |

> **Note:** `better-sqlite3` ships prebuilt binaries for most platforms. If your environment is unusual, `npm install` will compile from source — you'll need `python3` and a C++ compiler (`build-essential` / Xcode CLT).

---

## Installation

### Option A — Clone and build (recommended for development / local use)

```bash
git clone https://github.com/phash/PindeX.git
cd PindeX
npm install
npm run build
```

The compiled server is now at `dist/index.js` and the CLI at `dist/cli/index.js`.

### Option B — Install globally from npm

```bash
npm install -g pindex
```

This makes two commands available globally:

| Command | Purpose |
|---|---|
| `pindex` | CLI for setup, daemon management, indexing |
| `pindex-server` | Start the MCP server directly (stdio) |

### Verify the installation

```bash
node dist/index.js --help   # if cloned
pindex --help               # if installed globally
```

---

## Quick Start

### 1. Index your project

```bash
# From the PindeX repo (cloned install)
PROJECT_ROOT=/path/to/your/project \
INDEX_PATH=/path/to/your/project/.codebase-index/index.db \
node dist/index.js
```

On first launch PindeX will:
1. Create the SQLite database and run schema migrations
2. Discover all `.ts`, `.tsx`, `.js`, `.mjs` files under `PROJECT_ROOT`
3. Parse each file with tree-sitter and store symbols/imports
4. Start watching for file changes (`AUTO_REINDEX=true`)
5. Open the monitoring server on port 7842

### 2. Connect your AI assistant

See the [Integrations](#integrations) section below for Claude Code and Goose setup.

### 3. Use the tools

Once connected, your AI assistant can call tools like:

```
search_symbols("AuthService")
get_file_summary("src/auth/service.ts")
get_context("src/auth/service.ts", 42, 20)
find_usages("validateToken")
get_dependencies("src/api/routes.ts", "both")
```

---

## MCP Tools

All 10 tools are available over stdio transport.

### `search_symbols`

Full-text search across all indexed symbols (names, signatures, summaries) using SQLite FTS5.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Search term (supports FTS5 syntax) |
| `limit` | number | | Max results (default: 20) |

**Returns:** List of matching symbols with name, kind, signature, file path, and line number.

---

### `get_symbol`

Detailed information about a specific symbol including its signature, location, and the files it depends on.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Symbol name |
| `file` | string | | Narrow results to a specific file path |

**Returns:** Symbol record + file-level dependency list.

---

### `get_context`

Read a slice of a source file centred around a given line. Files are read from disk at call time — only metadata lives in the DB.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file` | string | ✓ | File path (relative to `PROJECT_ROOT`) |
| `line` | number | ✓ | Centre line |
| `range` | number | | Lines above and below (default: 30) |

**Returns:** Code snippet with detected language and line numbers.

---

### `get_file_summary`

High-level overview of a file without loading its full content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file` | string | ✓ | File path |

**Returns:** Language, summary text, all symbols (with kind + signature), imports, and exports.

---

### `find_usages`

All locations in the codebase where a symbol is referenced.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `symbol` | string | ✓ | Symbol name to look up |

**Returns:** List of `{ file, line, context }` entries.

---

### `get_dependencies`

Import graph for a file — what it imports, what imports it, or both.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `target` | string | ✓ | File path |
| `direction` | `"imports"` \| `"imported_by"` \| `"both"` | | Default: `"both"` |

**Returns:** Dependency list with resolved file paths and imported symbol names.

---

### `get_project_overview`

Project-wide statistics — no parameters required.

**Returns:** Total file count, dominant language, entry points (`index`, `main`, `app` files), module list with symbol counts, and cumulative token estimates.

---

### `reindex`

Rebuild the index for a single file or the entire project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `target` | string | | File path or omit for full project reindex |

**Returns:** Count of indexed / updated / error files.

---

### `get_token_stats`

Token usage and savings statistics for a session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | | Defaults to `"default"` |

**Returns:** Total tokens used, estimated tokens without the index, net savings, and savings percentage.

---

### `start_comparison`

Create a labelled A/B testing session to compare indexed vs. baseline token usage.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string | ✓ | Human-readable session name |
| `mode` | `"indexed"` \| `"baseline"` | ✓ | Tracking mode |

**Returns:** `session_id` and the monitoring dashboard URL.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `INDEX_PATH` | `./.codebase-index/index.db` | Path to the SQLite database |
| `PROJECT_ROOT` | `.` | Root directory of the project to index |
| `LANGUAGES` | `typescript,javascript` | Comma-separated list of languages to index |
| `AUTO_REINDEX` | `true` | Watch for file changes and reindex automatically |
| `GENERATE_SUMMARIES` | `false` | Generate LLM summaries per symbol (stub — not yet wired to a model) |
| `MONITORING_PORT` | `7842` | Port for the live dashboard + WebSocket |
| `MONITORING_AUTO_OPEN` | `false` | Open the dashboard in the browser on startup |
| `BASELINE_MODE` | `false` | Disable the index entirely (for A/B baseline sessions) |
| `TOKEN_PRICE_PER_MILLION` | `3.00` | USD price per million tokens — used for cost estimates in the dashboard |

---

## Integrations

### Claude Code

The project ships with a `.mcp.json` at the repository root. Claude Code auto-discovers it when you open the folder — no manual configuration needed.

If you want to use PindeX with a *different* project (not this repo), add or edit `.mcp.json` in that project's root:

```json
{
  "mcpServers": {
    "codebase-indexer": {
      "command": "node",
      "args": ["/absolute/path/to/PindeX/dist/index.js"],
      "env": {
        "INDEX_PATH": "./.codebase-index/index.db",
        "PROJECT_ROOT": ".",
        "LANGUAGES": "typescript,javascript",
        "AUTO_REINDEX": "true",
        "GENERATE_SUMMARIES": "false",
        "MONITORING_PORT": "7842",
        "MONITORING_AUTO_OPEN": "false",
        "BASELINE_MODE": "false",
        "TOKEN_PRICE_PER_MILLION": "3.00"
      }
    }
  }
}
```

Replace `/absolute/path/to/PindeX` with the actual path where you cloned this repo.

---

### Goose

[Goose](https://block.github.io/goose/) reads extensions from `~/.config/goose/config.yaml`.

**Step 1 — Build PindeX** (if you haven't already):

```bash
cd /path/to/PindeX && npm install && npm run build
```

**Step 2 — Edit `~/.config/goose/config.yaml`** and add the block below.
A ready-to-copy template is also available in [`goose-extension.yaml`](./goose-extension.yaml) in this repo.

```yaml
extensions:
  codebase-indexer:
    name: Codebase Indexer
    type: stdio
    cmd: node
    args:
      - /absolute/path/to/PindeX/dist/index.js
    envs:
      INDEX_PATH: /absolute/path/to/your-project/.codebase-index/index.db
      PROJECT_ROOT: /absolute/path/to/your-project
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

Replace both occurrences of `/absolute/path/to/...` with your actual paths.

**Step 3 — Restart Goose:**

```bash
goose session start
```

---

## CLI Reference

The `pindex` CLI (or `node dist/cli/index.js` when cloned) provides daemon and project management commands.

```
pindex <command> [options]
```

| Command | Description |
|---|---|
| `setup` | One-time setup: register the MCP server and configure autostart |
| `start` | Start the background daemon |
| `stop` | Stop the background daemon |
| `restart` | Restart the daemon |
| `status` | Show daemon status and list of indexed projects |
| `index [path]` | Index a directory (defaults to the current directory) |
| `index --force` | Force full reindex, bypassing MD5 hash checks |
| `monitor` | Open the monitoring dashboard in the default browser |
| `stats` | Show token statistics for the current session |
| `uninstall` | Remove all PindeX configuration and stop the daemon |

**Examples:**

```bash
# First-time setup
pindex setup

# Index the current project
pindex index

# Force reindex after a large refactor
pindex index --force

# Check what's running
pindex status

# Open the live dashboard
pindex monitor
```

---

## Monitoring Dashboard

PindeX starts an Express + WebSocket server (default port **7842**) that shows live token savings.

Open it manually: [http://localhost:7842](http://localhost:7842)

Or let it open automatically on startup:

```bash
MONITORING_AUTO_OPEN=true node dist/index.js
```

**Dashboard features:**
- Real-time chart (Chart.js) of tokens used vs. estimated cost without index
- Per-tool breakdown: which tools are used most and how much they save
- Session comparison: side-by-side indexed vs. baseline A/B data
- REST API at `/api/sessions` and `/api/sessions/:id` for programmatic access

---

## Development

### Setup

```bash
git clone https://github.com/phash/PindeX.git
cd PindeX
npm install
```

### Build

```bash
npm run build        # compile src/ → dist/
npm run build:watch  # watch mode
```

### Tests

```bash
npm test               # run full test suite (vitest, pool: forks)
npm run test:watch     # watch mode
npm run test:coverage  # coverage report — threshold: 80%
```

> Tests use `pool: 'forks'` — required because `better-sqlite3` uses native bindings that cannot share a process with the vitest worker pool.

### Lint / Type-check

```bash
npm run lint   # tsc --noEmit (type errors only, no output files)
```

### Test structure

```
tests/
├── setup.ts              # global mocks (tree-sitter, chokidar, open)
├── helpers/              # createTestDb(), fixtures, test server
├── db/                   # schema, migrations, queries
├── indexer/              # parser, indexer, watcher
├── tools/                # one file per MCP tool
├── monitoring/           # estimator, token-logger, Express server
├── cli/                  # project-detector, setup, daemon
└── integration/          # end-to-end MCP server tests
```

---

## Project Structure

```
src/
├── index.ts                  # Entry point — MCP stdio server
├── server.ts                 # Tool registration (10 tools)
├── types.ts                  # Shared TypeScript interfaces
│
├── db/
│   ├── schema.ts             # SQLite schema + FTS5 virtual table + triggers
│   ├── queries.ts            # Typed query helpers
│   ├── database.ts           # Connection management
│   └── migrations.ts         # Schema versioning (PRAGMA user_version)
│
├── indexer/
│   ├── index.ts              # Orchestrator — file discovery, incremental hashing
│   ├── parser.ts             # tree-sitter AST → symbols + imports
│   ├── summarizer.ts         # LLM summary stub (not yet active)
│   └── watcher.ts            # chokidar file watcher → auto-reindex
│
├── tools/                    # One file per MCP tool
│   ├── search_symbols.ts
│   ├── get_symbol.ts
│   ├── get_context.ts
│   ├── get_file_summary.ts
│   ├── find_usages.ts
│   ├── get_dependencies.ts
│   ├── get_project_overview.ts
│   ├── reindex.ts
│   ├── get_token_stats.ts
│   └── start_comparison.ts
│
├── monitoring/
│   ├── server.ts             # Express + WebSocket
│   ├── token-logger.ts       # Per-call token logging
│   ├── estimator.ts          # "without index" heuristic
│   └── ui/                   # Dashboard HTML / CSS / Chart.js
│
└── cli/
    ├── index.ts              # CLI router
    ├── setup.ts              # One-time setup
    ├── daemon.ts             # PID-file daemon management
    └── project-detector.ts   # Auto-detect project type
```

### Key implementation notes

- **ES Modules** — all relative imports use `.js` extensions (TypeScript ESM / NodeNext resolution).
- **FTS5 sync** — kept in sync by SQLite `AFTER INSERT/UPDATE/DELETE` triggers; no application-level bookkeeping needed.
- **Incremental reindexing** — MD5 hash per file; unchanged files are skipped on every startup and watch event.
- **Live context** — `get_context` reads from disk at call time so it always returns the current file state, not a stale cache.
- **Testability** — `createMonitoringApp()` (returns the Express `app`) and `startMonitoringServer()` (binds the HTTP/WebSocket server) are separate functions so tests can mount the app without binding a port.

---

## License

MIT
