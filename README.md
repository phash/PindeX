# PindeX – MCP Codebase Indexer

**Structural codebase indexing for AI coding assistants — 80–90% fewer tokens per session.**

PindeX is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that parses your TypeScript/JavaScript project with `tree-sitter`, stores symbols, imports, and dependency graphs in a local SQLite database, and exposes 10 targeted tools so AI assistants can answer questions about your code without reading entire files.

---

## Contents

- [How It Works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Multi-Project & Federation](#multi-project--federation)
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
  SQLite (FTS5)  ← stored in ~/.pindex/projects/{hash}/index.db
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

### Option A — Install globally from npm

```bash
npm install -g pindex
```

This makes three commands available globally:

| Command | Purpose |
|---|---|
| `pindex` | CLI — init, federation, status |
| `pindex-server` | MCP stdio server (Claude Code spawns this automatically) |
| `pindex-gui` | Aggregated dashboard for all projects |

### Option B — Clone and build (development / local use)

```bash
git clone https://github.com/phash/PindeX.git
cd PindeX
npm install
npm run build
```

The compiled server is at `dist/index.js`, the CLI at `dist/cli/index.js`, and the GUI at `dist/gui/index.js`.

---

## Quick Start

### 1. Set up a project

Run `pindex` (with no arguments) in any project directory:

```bash
cd /my/project
pindex
```

PindeX will:
1. Walk upward from your current directory to find the project root (`package.json`, `.git`, etc.)
2. Assign a dedicated monitoring port for this project
3. Write `.mcp.json` into the project root with absolute paths
4. Register the project in `~/.pindex/registry.json`

Output:
```
  ╔══════════════════════════════════════════╗
  ║           PindeX – Ready                 ║
  ╚══════════════════════════════════════════╝

  Project : /my/project
  Index   : ~/.pindex/projects/a3f8b2c1/index.db
  Port    : 7856
  Config  : .mcp.json (written)

  ── Next steps ─────────────────────────────
  1. Restart Claude Code in this directory
  2. Open the dashboard:  pindex-gui
```

### 2. Restart Claude Code

Claude Code auto-discovers `.mcp.json`. On the next startup it will spawn `pindex-server` with the correct `PROJECT_ROOT` — the index is built automatically in the background.

### 3. Use the tools

Once connected, your AI assistant can call tools like:

```
search_symbols("AuthService")
get_file_summary("src/auth/service.ts")
get_context("src/auth/service.ts", 42, 20)
find_usages("validateToken")
get_dependencies("src/api/routes.ts", "both")
```

### 4. Open the dashboard

```bash
pindex-gui
```

Opens `http://localhost:7842` — an aggregated dashboard showing token savings, symbol counts, and session stats for **all** registered projects.

---

## Multi-Project & Federation

### Multiple independent projects

Each project gets its own `.mcp.json` (pointing to its own `PROJECT_ROOT`) and its own SQLite database at `~/.pindex/projects/{hash}/index.db`. When Claude Code opens Project A, it spawns `pindex-server` with `PROJECT_ROOT=/path/to/project-a` — it never touches Project B's index.

```bash
cd /project-a && pindex   # registers project-a
cd /project-b && pindex   # registers project-b, different port + different DB
```

### Linking repos (federation)

If you work on a monorepo split into separate repositories, or if one project imports types from another, you can link them:

```bash
cd /project-a
pindex add /project-b
```

This updates `/project-a/.mcp.json` with `FEDERATION_REPOS=/project-b`. After restarting Claude Code in Project A, the MCP tools search **both** codebases:

- `search_symbols` returns results from both projects (federated results include a `project` field)
- `get_project_overview` shows stats for all linked projects

Add more repos at any time:

```bash
pindex add /project-c   # links a third repo
```

Remove a link:

```bash
pindex remove /project-b
```

### View all projects

```bash
pindex status
```

```
  3 registered project(s):

  [idle]  project-a  + 1 federated repo
           /home/user/project-a
           port: 7856  index: ~/.pindex/projects/a3f8b2c1/

  [idle]  project-b
           /home/user/project-b
           port: 7901  index: ~/.pindex/projects/f1e2d3c4/
  ...
```

---

## MCP Tools

All 10 tools are available over stdio transport.

### `search_symbols`

Full-text search across all indexed symbols (names, signatures, summaries) using SQLite FTS5.
When federation is active, results from linked repos include a `project` field.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Search term (supports FTS5 syntax) |
| `limit` | number | | Max results per project (default: 20) |

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
When federation is active, also includes stats for each linked repository.

**Returns:** Total file count, dominant language, entry points (`index`, `main`, `app` files), module list with symbol counts, and (if federated) per-repo breakdowns.

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

These are set automatically in the generated `.mcp.json` — you rarely need to change them by hand.

| Variable | Default | Description |
|---|---|---|
| `PROJECT_ROOT` | `.` | Root directory of the project to index |
| `INDEX_PATH` | `~/.pindex/projects/{hash}/index.db` | Path to the SQLite database |
| `LANGUAGES` | `typescript,javascript` | Comma-separated list of languages to index |
| `AUTO_REINDEX` | `true` | Watch for file changes and reindex automatically |
| `MONITORING_PORT` | assigned per-project | Port for the live dashboard + WebSocket |
| `MONITORING_AUTO_OPEN` | `false` | Open the dashboard in the browser on startup |
| `BASELINE_MODE` | `false` | Disable the index entirely (for A/B baseline sessions) |
| `GENERATE_SUMMARIES` | `false` | Generate LLM summaries per symbol (stub — not yet wired) |
| `TOKEN_PRICE_PER_MILLION` | `3.00` | USD price per million tokens — used for cost estimates |
| `FEDERATION_REPOS` | _(empty)_ | Colon-separated absolute paths to linked repositories |

---

## Integrations

### Claude Code

Run `pindex` in each project you want to index. The command writes `.mcp.json` automatically:

```bash
cd /my/project
pindex
# → .mcp.json written
# restart Claude Code → pindex-server starts automatically
```

The `.mcp.json` format (auto-generated, do not edit by hand):

```json
{
  "mcpServers": {
    "pindex": {
      "command": "pindex-server",
      "args": [],
      "env": {
        "PROJECT_ROOT": "/absolute/path/to/project",
        "INDEX_PATH": "/home/user/.pindex/projects/a3f8b2c1/index.db",
        "MONITORING_PORT": "7856",
        "AUTO_REINDEX": "true",
        "GENERATE_SUMMARIES": "false",
        "MONITORING_AUTO_OPEN": "false",
        "BASELINE_MODE": "false",
        "TOKEN_PRICE_PER_MILLION": "3.00"
      }
    }
  }
}
```

With federation (`pindex add /other/project`):

```json
{
  "mcpServers": {
    "pindex": {
      "command": "pindex-server",
      "args": [],
      "env": {
        "PROJECT_ROOT": "/absolute/path/to/project",
        "FEDERATION_REPOS": "/absolute/path/to/other/project",
        "..."
      }
    }
  }
}
```

---

### Goose

[Goose](https://block.github.io/goose/) reads extensions from `~/.config/goose/config.yaml`.

**Step 1 — Install PindeX:**

```bash
npm install -g pindex
```

**Step 2 — Run `pindex` in your project** to get the assigned hash and port:

```bash
cd /my/project && pindex
```

**Step 3 — Edit `~/.config/goose/config.yaml`:**

```yaml
extensions:
  pindex:
    name: PindeX
    type: stdio
    cmd: pindex-server
    args: []
    envs:
      PROJECT_ROOT: /absolute/path/to/project
      INDEX_PATH: /home/user/.pindex/projects/{hash}/index.db
      LANGUAGES: typescript,javascript
      AUTO_REINDEX: "true"
      GENERATE_SUMMARIES: "false"
      MONITORING_PORT: "{port}"
      MONITORING_AUTO_OPEN: "false"
      BASELINE_MODE: "false"
      TOKEN_PRICE_PER_MILLION: "3.00"
    enabled: true
    timeout: 300
```

Replace `{hash}` and `{port}` with the values shown by `pindex`. A ready-to-copy template is available in [`goose-extension.yaml`](./goose-extension.yaml).

**Step 4 — Restart Goose:**

```bash
goose session start
```

---

## CLI Reference

```
pindex [command] [options]
```

| Command | Description |
|---|---|
| _(no args)_ / `init` | Set up this project: write `.mcp.json`, register globally |
| `add <path>` | Link another repo for cross-repo search (federation) |
| `remove [path]` | Remove a federated repo link, or deregister the current project |
| `setup` | One-time global setup (autostart config) |
| `status` | Show all registered projects and their status |
| `list` | List all registered projects (compact) |
| `index [path]` | Manually index a directory (default: current directory) |
| `index --force` | Force full reindex, bypassing MD5 hash checks |
| `gui` | Open the aggregated monitoring dashboard in the browser |
| `stats` | Print a short stats summary |
| `uninstall` | Stop all daemons (data stays in `~/.pindex`) |

**Examples:**

```bash
# Set up a new project
cd /my/project && pindex

# Link project-b for cross-repo search
pindex add /my/project-b

# Check all registered projects
pindex status

# Manually force a full reindex
pindex index --force

# Open the dashboard
pindex-gui
```

---

## Monitoring Dashboard

### Per-project dashboard

Each `pindex-server` instance starts a monitoring server on its assigned port. Open it at:

```
http://localhost:{MONITORING_PORT}
```

Or let it open automatically on startup:

```bash
MONITORING_AUTO_OPEN=true node dist/index.js
```

### Aggregated dashboard (all projects)

```bash
pindex-gui
```

Opens `http://localhost:7842` — reads **all** registered project databases directly and shows:

- Token savings per project (bar chart)
- Indexed file and symbol counts
- Session history
- Average savings % across all projects

The GUI refreshes automatically every 15 seconds and works even when no `pindex-server` is running.

**Dashboard features (both dashboards):**
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
├── index.ts                  # Entry point — MCP stdio server + FEDERATION_REPOS
├── server.ts                 # Tool registration (10 tools, FederatedDb interface)
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
│   ├── search_symbols.ts     # FTS5 search — supports federated DBs
│   ├── get_symbol.ts
│   ├── get_context.ts
│   ├── get_file_summary.ts
│   ├── find_usages.ts
│   ├── get_dependencies.ts
│   ├── get_project_overview.ts  # federation-aware stats
│   ├── reindex.ts
│   ├── get_token_stats.ts
│   └── start_comparison.ts
│
├── monitoring/
│   ├── server.ts             # Express + WebSocket (per-project instance)
│   ├── token-logger.ts       # Per-call token logging
│   ├── estimator.ts          # "without index" heuristic
│   └── ui/                   # Dashboard HTML / CSS / Chart.js
│
├── gui/
│   ├── index.ts              # pindex-gui entry point
│   └── server.ts             # Aggregated Express app (reads all project DBs)
│
└── cli/
    ├── index.ts              # CLI router
    ├── init.ts               # initProject(), writeMcpJson(), addFederatedRepo()
    ├── setup.ts              # One-time setup (pindex setup)
    ├── daemon.ts             # Per-project PID-file daemon management
    └── project-detector.ts   # getPindexHome(), findProjectRoot(), GlobalRegistry
```

### Key implementation notes

- **ES Modules** — all relative imports use `.js` extensions (TypeScript ESM / NodeNext resolution).
- **FTS5 sync** — kept in sync by SQLite `AFTER INSERT/UPDATE/DELETE` triggers; no application-level bookkeeping needed.
- **Incremental reindexing** — MD5 hash per file; unchanged files are skipped on every startup and watch event.
- **Live context** — `get_context` reads from disk at call time so it always returns the current file state, not a stale cache.
- **Testability** — `createMonitoringApp()` (returns the Express `app`) and `startMonitoringServer()` (binds the HTTP/WebSocket server) are separate functions so tests can mount the app without binding a port.
- **Per-project ports** — assigned deterministically as `7842 + (parseInt(hash.slice(0,4), 16) % 2000)` and stored in `registry.json` so they never change.
- **`pindex-gui` reads DBs directly** — no running server required; works as a standalone dashboard even when Claude Code is not open.
- **Migration** — `getPindexHome()` automatically renames `~/.mcp-indexer` → `~/.pindex` on first call if the old directory exists.

---

## License

MIT
