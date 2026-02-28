# PindeX – MCP Codebase Indexer

## Workflow-Regeln für Claude

### Commit & Push
Wenn der User "commit", "push", "commit und push" o.ä. sagt:
1. Versuche `Skill` mit `commit-commands:commit-push`
2. Falls der Skill nicht verfügbar: direkt git-Befehle nutzen — nur relevante Dateien stagen (kein `.mcp.json`, `.claude/`, `dist/` außer explizit gewünscht), aussagekräftige Commit-Message im Stil der letzten Commits, dann `git push`

### npm publish
Wenn der User "publish", "npm publish", "release" o.ä. sagt:
1. Versuche `Skill` mit `npm-publish`
2. Manuell: `npm version patch` → `gh release create vX.Y.Z --title "vX.Y.Z" --target main --notes "..."` → Workflow via `gh run watch` beobachten
- Voraussetzung: GitHub Secret `NPM_TOKEN` (Granular Access Token mit bypass-2fa) muss gesetzt sein
- Workflow-Datei: `.github/workflows/publish.yml` (triggt bei Release + `workflow_dispatch`)

### PindeX-Tools nutzen
- **Immer** `mcp__pindex__*` Tools für Codebase-Exploration verwenden
- Pfade an die Tools immer mit Forward-Slashes übergeben (z.B. `src/gui/server.ts`)
- Falls `get_file_summary` / `get_context` null zurückgeben → MCP-Server wurde noch nicht neu gestartet nach einem Build; dann `Read`/`Grep` als Fallback nutzen
- Nach jedem `npm run build`: Claude Code neu starten damit der neue MCP-Server aktiv wird

### Serena (MCP) für Edits nutzen
- **PindeX = read-only** (navigieren, erkunden, token-tracking)
- **Serena = edits** (`replace_symbol_body`, `insert_after_symbol`, `rename_symbol` via LSP)
- Workflow: PindeX zum Navigieren → Serena zum Editieren
- Serena-Projekt aktivieren: `mcp__plugin_serena_serena__activate_project` mit `E:\claude\PindeX`

MCP server that structurally indexes codebases (TypeScript, JavaScript, Java, Kotlin, Python, PHP, Vue, Svelte, Ruby, C#, Go, Rust) and provides targeted tools for 80–90% token reduction in AI-assisted coding sessions.

## Tech Stack

### Languages
- **TypeScript 5.x** — Primärsprache, ES2022 target, NodeNext module resolution, strict mode
- **JavaScript** — kompilierter Output (`dist/`), auch von PindeX selbst indexiert
- **SQL** — SQLite FTS5 virtual tables & triggers
- **HTML/CSS** — Monitoring-Dashboard UI (Chart.js, dark theme)

### Runtime & Platform
- **Node.js** >= 18.0.0
- **ESM modules** (`"type": "module"` in package.json)

### Produktions-Dependencies
| Paket | Version | Zweck |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.0.0 | MCP-Protokoll (stdio transport) |
| `better-sqlite3` | ^9.0.0 | SQLite mit nativen Bindings, FTS5 |
| `chokidar` | ^3.6.0 | Datei-Watcher (auto-reindex) |
| `express` | ^4.18.0 | HTTP-Server (Monitoring + GUI) |
| `glob` | ^10.0.0 | Datei-Pattern-Matching |
| `tree-sitter` | ^0.21.0 | AST-Parser (Basis) |
| `tree-sitter-typescript` | ^0.21.0 | TypeScript/JavaScript Grammatik |
| `uuid` | ^9.0.0 | Eindeutige IDs |
| `ws` | ^8.16.0 | WebSocket-Server |
| `open` | ^9.1.0 | Browser öffnen |

### Dev-Tools
| Tool | Zweck |
|---|---|
| `typescript` ^5.0.0 | Compiler (`tsc`), kein Bundler |
| `vitest` ^1.0.0 | Test-Runner (`pool: forks` — nötig für native Bindings) |
| `@vitest/coverage-v8` | Code Coverage (Schwelle: >80%) |
| `supertest` ^6.0.0 | HTTP Integration Testing |
| `tsc --noEmit` | Lint (nur Type-Check) |

### Build-System
- Nur TypeScript Compiler (`tsc`), **kein Bundler** (kein webpack/esbuild/rollup)
- Source: `src/` → Output: `dist/`
- Source Maps + Declaration Files werden generiert

---

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
- **MCP Tools**: 13 tools registered via `@modelcontextprotocol/sdk`
- **Monitoring**: per-project Express + WebSocket server, per-project deterministic port
- **GUI**: `pindex-gui` binary — aggregated Express dashboard reading all project DBs directly
- **CLI**: `pindex` (init/add/remove/status), per-project daemon management
- **Global state**: `~/.pindex/registry.json` + `~/.pindex/projects/{hash}/index.db`

## MCP Tools

| Tool | Purpose |
|---|---|
| `search_symbols` | FTS5 full-text search across all indexed symbols (+ federated repos) |
| `get_symbol` | Symbol details: signature, location, file dependencies |
| `get_context` | Line-range snippet from a file (token-efficient) |
| `get_file_summary` | File overview: symbols, imports, exports |
| `find_usages` | All locations where a symbol is used |
| `get_dependencies` | Import graph for a file (imports / imported_by / both) |
| `get_project_overview` | Project-level stats, entry points, module list (+ federated repos) |
| `reindex` | Rebuild index for one file or the entire project |
| `get_token_stats` | Token usage statistics for a session |
| `start_comparison` | Start A/B session (indexed vs baseline) |

## Binaries

| Binary | Entry point | Purpose |
|---|---|---|
| `pindex` | `dist/cli/index.js` | User-facing CLI |
| `pindex-server` | `dist/index.js` | MCP stdio server (spawned by Claude Code) |
| `pindex-gui` | `dist/gui/index.js` | Aggregated dashboard (all projects) |

## Running the MCP Server

```bash
# Start directly (stdio transport)
node dist/index.js

# Environment variables
INDEX_PATH=~/.pindex/projects/{hash}/index.db  # SQLite DB path (set by pindex init)
PROJECT_ROOT=.                                  # project to index
LANGUAGES=typescript,javascript                 # comma-separated
AUTO_REINDEX=true                               # watch for file changes
GENERATE_SUMMARIES=false                        # LLM summaries (stub)
MONITORING_PORT=7843                            # per-project port (assigned by pindex init)
MONITORING_AUTO_OPEN=false                      # open browser on start
BASELINE_MODE=false                             # disable index (A/B testing)
TOKEN_PRICE_PER_MILLION=3.00                    # for cost estimates
FEDERATION_REPOS=/path/a:/path/b               # colon-separated extra repos (optional)
```

## Claude Code Setup

Run `pindex` in the project directory — it auto-generates `.mcp.json` with the correct
absolute paths and registers the project globally:

```bash
cd /my/project
pindex
# → writes .mcp.json, registers in ~/.pindex/registry.json
# → restart Claude Code to activate
```

The `.mcp.json` in the PindeX repo itself is pre-configured for working on PindeX.

## Goose Setup

Config file: `~/.config/goose/config.yaml`

Add the following block (replace paths):

```yaml
extensions:
  pindex:
    name: PindeX
    type: stdio
    cmd: pindex-server
    args: []
    envs:
      INDEX_PATH: /home/user/.pindex/projects/{hash}/index.db
      PROJECT_ROOT: /absolute/path/to/project
      LANGUAGES: typescript,javascript
      AUTO_REINDEX: "true"
      GENERATE_SUMMARIES: "false"
      MONITORING_PORT: "7843"
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
├── index.ts              # entry point (MCP stdio server + FEDERATION_REPOS handling)
├── server.ts             # MCP tool registration (FederatedDb interface)
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
│   ├── server.ts         # Express + WebSocket (per-project)
│   ├── token-logger.ts   # per-call token logging
│   ├── estimator.ts      # "without index" heuristic
│   └── ui/               # dashboard (Chart.js, dark theme)
├── gui/
│   ├── index.ts          # pindex-gui entry point
│   └── server.ts         # aggregated Express app (reads all project DBs)
└── cli/
    ├── index.ts          # CLI router (default=initProject, add, remove, status…)
    ├── init.ts           # initProject(), writeMcpJson(), addFederatedRepo()
    ├── setup.ts          # one-time setup (pindex setup)
    ├── daemon.ts         # per-project PID-file daemon management
    └── project-detector.ts  # getPindexHome(), findProjectRoot(), GlobalRegistry
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
- `GlobalRegistry` manages `~/.pindex/registry.json`; port assignment is deterministic
  (`7842 + (parseInt(hash.slice(0,4), 16) % 2000)`) and stored to stay stable
- Migration from `~/.mcp-indexer` to `~/.pindex` runs automatically on first call to
  `getPindexHome()` if the old directory exists

## PindeX – Codebase Navigation

Dieses Projekt ist mit PindeX indexiert.

**PFLICHT-WORKFLOW** – bei jeder Codebase-Aufgabe:
1. **Unbekannte Datei?** → `mcp__pindex__get_file_summary` ZUERST, dann ggf. `get_context`
2. **Symbol suchen?** → `mcp__pindex__search_symbols` oder `find_symbol`
3. **Abhängigkeiten?** → `mcp__pindex__get_dependencies`
4. **Wo wird etwas verwendet?** → `mcp__pindex__find_usages`
5. **Projekt-Überblick?** → `mcp__pindex__get_project_overview`

**VERBOTEN** (solange PindeX verfügbar):
- `Read` auf Quellcode-Dateien ohne vorherigen `get_file_summary`-Aufruf
- `Glob`/`Grep` zur Symbol-Suche statt `search_symbols`

**Kontext auslagern:**
- Wichtige Entscheidungen / Muster → `mcp__pindex__save_context` speichern
- Zu Sessionbeginn → `mcp__pindex__search_docs` für gespeicherten Kontext

**Fallback:** Falls ein Tool `null` zurückgibt → `Read`/`Grep` als Fallback.
<!-- pindex -->
