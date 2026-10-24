# PindeX – MCP Codebase Indexer

## Workflow-Regeln für Claude

### Commit & Push
Wenn der User "commit", "push", "commit und push" o.ä. sagt:
1. Versuche `Skill` mit `commit-commands:commit-push`
2. Falls der Skill nicht verfügbar: direkt git-Befehle nutzen — nur relevante Dateien stagen (kein `.mcp.json`, `.claude/`, `dist/` außer explizit gewünscht), aussagekräftige Commit-Message im Stil der letzten Commits, dann `git push`

### npm publish
Wenn der User "publish", "npm publish", "release" o.ä. sagt:
1. Versuche `Skill` mit `npm-publish`
2. Manuell: Version in `package.json`, `package-lock.json` (Root-Einträge), `.claude-plugin/plugin.json` und `.claude-plugin/marketplace.json` (2×) bumpen + CHANGELOG-Überschrift → Commit `chore(release): vX.Y.Z` → `gh release create vX.Y.Z --title "vX.Y.Z" --target main --notes "..."` → Workflow via `gh run watch` beobachten
  - Kein `npm version`: lokales npm 11.4 entfernt die `libc`-Felder aus dem Lockfile (Diff-Rauschen)
- **Auth = Trusted Publishing (OIDC), kein Token.** npmjs.com → `pindex` → Settings → Trusted Publisher: GitHub Actions, `phash/PindeX`, Workflow `publish.yml`, Direkt-Publish (`npm publish`) erlaubt. Kein `NPM_TOKEN`-Secret nötig.
  - Granulare Tokens mit Bypass-2FA lassen sich auf npmjs.com nicht mehr anlegen; neue Schreib-Tokens sind „stage only“.
- Voraussetzungen im Workflow: Node ≥ 22.14, npm ≥ 11.5.1 (für `npm stage publish` ≥ 11.15) — deshalb `npm install -g npm@^11.15.0`
- Fehler-Matrix:
  - `E403 … can only publish to a staging area (E_STAGE_REQUIRED)` → Auth läuft über stage-only-Token, oder Trusted Publisher erlaubt nur Staging → Direkt-Publish beim Trusted Publisher erlauben, oder auf `npm stage publish` umstellen und auf npmjs.com („Staged Packages“) mit 2FA freigeben
  - `ENEEDAUTH` / `404 PUT .../pindex` → OIDC greift nicht: Trusted-Publisher-Daten (Repo, Workflow-Dateiname) prüfen, `id-token: write` gesetzt, npm-Version zu alt
- Nachträglich publishen: `gh workflow run publish.yml --ref main` + `gh run watch`. `--ref <tag>` nutzt die Workflow-Datei *aus dem Tag* — nach Workflow-Änderungen also `main` nehmen
- Workflow-Datei: `.github/workflows/publish.yml` (triggt bei Release + `workflow_dispatch`)

### Subagents in Worktrees
Wenn du einen Subagent in einem anderen Worktree arbeiten lässt: im Prompt explizit `cd <worktree-path>` VOR jedem Shell-Befehl erzwingen und `git rev-parse --abbrev-ref HEAD` VOR jedem `git commit` verifizieren lassen. Subagents ignorieren sonst gern den „Work from:"-Hinweis und committen im Default-Worktree.

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

MCP server that structurally indexes codebases (TypeScript, JavaScript, Java, Kotlin, Python, PHP, Vue, Svelte, Ruby, C#, Go, Rust) and provides targeted tools for significant token reduction in AI-assisted coding sessions.

**Wann lohnt sich PindeX?** Benchmarks zeigen den Break-Even bei ca. **40+ Dateien** oder **⌀ ≥150 Zeilen/Datei**. Bei kleineren Projekten überwiegt der Tool-Definition-Overhead (~800 Tokens/Turn × Anzahl Turns) die Einsparungen durch vermiedene File-Reads. `get_project_overview` liefert automatisch ein `index_recommendation`-Feld mit Einschätzung für das jeweilige Projekt.

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
| `@modelcontextprotocol/sdk` | ^1.32.1 | MCP-Protokoll (stdio transport) |
| `better-sqlite3` | ^12.10.0 | SQLite mit nativen Bindings, FTS5 (≥12.10 für Node ≥24/26-Prebuilds nötig) |
| `chokidar` | ^4.0.3 | Datei-Watcher (auto-reindex; keine Globs — Filter via `minimatch` in `src/indexer/watch-filter.ts`) |
| `minimatch` | ^9.0.9 | Glob-Matching für den Watcher-Filter |
| `express` | ^4.18.0 | HTTP-Server (Monitoring + GUI) |
| `glob` | ^10.0.0 | Datei-Pattern-Matching |
| `tree-sitter` | ^0.21.0 | AST-Parser (Basis) |
| `tree-sitter-typescript` | ^0.21.0 | TypeScript/JavaScript Grammatik |
| `uuid` | ^9.0.0 | Eindeutige IDs |
| `ws` | ^8.21.0 | WebSocket-Server |
| `open` | ^9.1.0 | Browser öffnen |
| `zod` | ^4.3.6 | Runtime Input-Validierung (MCP Tool-Argumente) |

### Dev-Tools
| Tool | Zweck |
|---|---|
| `typescript` ^5.0.0 | Compiler (`tsc`), kein Bundler |
| `vitest` ^4.0.0 | Test-Runner (`pool: forks` — nötig für native Bindings) |
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
npm test                 # run all unit tests (vitest, pool: forks)
npm run test:watch       # watch mode
npm run test:coverage    # coverage report (threshold: >80%)
npm run test:integration # echte tree-sitter-Bindings; nutzt vitest.integration.config.ts
npm run bench:index      # synth-Projekt + Timing (Envs: BENCH_FILES, BENCH_FUNCS_PER_FILE, PINDEX_PARSE_WORKERS)
npm run bench:realism    # echte A/B Claude-Calls (PindeX on/off) → benchmarks/results/*.md (--codebases/--tasks-limit/--budget; braucht 'claude' CLI)
npm run lint             # TypeScript type-check only (tsc --noEmit)
npm run build            # compile src/ → dist/
```

## Architecture

- **DB**: SQLite via `better-sqlite3` — FTS5 virtual table with triggers for symbol search
- **Parser**: `tree-sitter` + `tree-sitter-typescript` — AST-based symbol/import extraction
- **Indexer**: MD5-hash-based incremental reindexing, glob file discovery
- **MCP Tools**: 16 tools registered via `@modelcontextprotocol/sdk` (Zod-validierte Inputs)
- **Monitoring**: per-project Express + WebSocket server, per-project deterministic port
- **GUI**: `pindex-gui` binary — aggregated Express dashboard reading all project DBs directly
- **CLI**: `pindex` (init/add/remove/status), per-project daemon management
- **Global state**: `~/.pindex/registry.json` + `{project}/.pindex/index.db`

## MCP Tools

| Tool | Purpose |
|---|---|
| `search_symbols` | FTS5 full-text search across all indexed symbols (+ federated repos) |
| `get_symbol` | Symbol details: signature, location, file dependencies + memory context |
| `get_context` | Line-range snippet from a file (token-efficient) |
| `get_file_summary` | File overview: symbols, imports, exports + memory context |
| `find_usages` | Call sites of a symbol with `caller` + confidence (`EXTRACTED`/`INFERRED`); `file` disambiguates, ambiguous names return candidates, unknown → `not_found`; default 100 results (`limit` ≤ 500) |
| `get_call_path` | Shortest call chain from symbol A to B (`from`/`to`, `from_file`/`to_file`, `max_depth` default 6, max 12); edges tagged `EXTRACTED`/`INFERRED`; primary repo only |
| `get_dependencies` | Import graph for a file (imports / imported_by / both) |
| `get_api_endpoints` | Extracted HTTP/REST endpoints (Express-style route symbols) in the codebase |
| `get_project_overview` | Project-level stats, entry points, directory groups, hub symbols (top 10 by distinct caller files) and file communities (max 8; full mode, only with call edges) + session memory summary |
| `reindex` | Rebuild index for one file or the entire project |
| `get_token_stats` | Token usage statistics for a session |
| `start_comparison` | Start A/B session (indexed vs baseline) |
| `search_docs` | FTS5 search across indexed documents + saved context entries |
| `get_doc_chunk` | Retrieve specific section(s) of an indexed document |
| `save_context` | Persist a fact/decision to the cross-session context store |
| `get_session_memory` | Query passive session observations by session, file, or symbol |

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
INDEX_PATH={project}/.pindex/index.db  # SQLite DB path (set by pindex init)
PROJECT_ROOT=.                                  # project to index
LANGUAGES=typescript,javascript                 # comma-separated
AUTO_REINDEX=true                               # watch for file changes
GENERATE_SUMMARIES=false                        # LLM-Summaries (OpenAI-kompatible API)
SUMMARIZER_API_KEY=                             # API-Key für LLM-Summaries
SUMMARIZER_BASE_URL=https://api.openai.com/v1   # API-Basis-URL (OpenAI, Ollama, etc.)
SUMMARIZER_MODEL=gpt-4o-mini                    # Modell für Summaries
MONITORING_PORT=7843                            # per-project port (assigned by pindex init)
MONITORING_AUTO_OPEN=false                      # open browser on start
BASELINE_MODE=false                             # disable index (A/B testing)
PINDEX_PARSE_WORKERS=                           # parse workers (0=sync, empty=auto)
PINDEX_BIND_HOST=127.0.0.1                      # bind host (loopback default)
GUI_PORT=7841                                   # pindex gui / pindex-gui dashboard port (default 7841; `pindex gui --no-open` = background only)
EXPOSE_CORE_TOOLS_ONLY=false                    # 'true' = register only core tools (omits analytics/memory/doc tools)
PINDEX_LSP=                                     # opt-in Pyright LSP for Python: only 'true' enables it (default off = regex)
# Trust: with PINDEX_LSP=true pyright reads the project's pyrightconfig.json and may run the configured
# Python interpreter — enable only for trusted repos. Pyright is spawned with cwd=os.tmpdir().
PINDEX_HOOK_STRICT=1                            # PreToolUse hook: deny the first whole-file Read per session (outline as reason) instead of advising
FEDERATION_REPOS=/path/a:/path/b               # OS path delimiter (":" posix, ";" Windows) or a JSON array
# Federation CLI: configure via 'pindex federate add/remove/list' (preferred over editing FEDERATION_REPOS by hand).
# 9 read-only tools (search_symbols, find_usages, get_symbol, get_file_summary, get_context,
# get_dependencies, get_project_overview, search_docs, get_doc_chunk) accept an optional
# `repos: string[]` param to scope to specific federated repos.
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

The repo's `.mcp.json` is not tracked (it contains machine-specific absolute paths): run `pindex` in the repo to generate it. Re-running rewrites `PROJECT_ROOT`, `INDEX_PATH`, `MONITORING_PORT`, `FEDERATION_REPOS` and keeps only the allowlist `PRESERVED_ENV_KEYS` in `src/cli/init.ts` (`LANGUAGES`, `AUTO_REINDEX`, `GENERATE_SUMMARIES`, `SUMMARIZER_MODEL`, `MONITORING_AUTO_OPEN`, `EXPOSE_CORE_TOOLS_ONLY`, `OBSERVATION_RETENTION`, `PINDEX_PARSE_WORKERS`); every other key (e.g. `PINDEX_LSP`, `SUMMARIZER_BASE_URL`, `NODE_OPTIONS`) is dropped with a names-only warning — security: a repo may ship its own `.mcp.json`.

Hooks: `PreToolUse` goes into `.claude/settings.json`, `SessionStart` (absolute node/script paths) into `.claude/settings.local.json`.

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
      INDEX_PATH: /absolute/path/to/project/.pindex/index.db
      PROJECT_ROOT: /absolute/path/to/project
      LANGUAGES: typescript,javascript
      AUTO_REINDEX: "true"
      GENERATE_SUMMARIES: "false"
      MONITORING_PORT: "7843"
      MONITORING_AUTO_OPEN: "false"
      BASELINE_MODE: "false"
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
│   ├── summarizer.ts     # LLM summary (OpenAI-kompatible API)
│   └── watcher.ts        # chokidar file watcher
├── tools/                # one file per MCP tool + schemas.ts (Zod-Validierung)
├── monitoring/
│   ├── server.ts         # Express + WebSocket (per-project)
│   ├── token-logger.ts   # per-call token logging ("without index" = per-tool multiplier in src/server.ts)
│   └── ui/               # dashboard (Chart.js, dark theme)
├── gui/
│   ├── index.ts          # pindex-gui entry point
│   └── server.ts         # aggregated Express app (reads all project DBs)
└── cli/
    ├── index.ts          # CLI router (default=initProject, add, remove, status…)
    ├── init.ts           # initProject(), writeMcpJson()
    ├── setup.ts          # one-time setup (pindex setup)
    ├── daemon.ts         # per-project PID-file daemon management
    └── project-detector.ts  # getPindexHome(), findProjectRoot(), GlobalRegistry
tests/
├── setup.ts              # global mocks (tree-sitter, chokidar, open)
├── helpers/              # createTestDb(), fixtures, test server
├── db/                   # schema, migrations, queries tests
├── indexer/              # parser, indexer, watcher tests
├── tools/                # one test file per tool
├── monitoring/           # token-logger, server tests
├── cli/                  # project-detector, setup, daemon tests
└── integration/          # end-to-end MCP server tests
```

## Session Memory (v1.1+)

Passive memory that requires **zero cooperation from Claude** — no `save_context` calls needed.

- **AST diff engine** (`src/memory/ast-diff.ts`): compares symbol signatures on every re-index; detects `added` / `removed` / `sig_changed`
- **SessionObserver** (`src/memory/observer.ts`): hooks into MCP tool handlers + FileWatcher; auto-generates observations
- **AntiPatternDetector** (`src/memory/anti-patterns.ts`): detects dead-end exploration, file thrashing, repeated failed searches, tool error loops
- **Staleness engine**: marks observations stale when linked symbols change → surfaced as warnings next session
- **Passive surfacing**: `get_project_overview`, `get_symbol`, `get_file_summary` include memory context automatically
- New DB tables: `ast_snapshots`, `session_observations`, `session_events` (schema v3)
- Env var: `OBSERVATION_RETENTION` = `permanent` (default) | `session` | `Nd` (e.g. `30d`)

## Key Implementation Notes

- All relative imports use `.js` extension (TypeScript ESM/NodeNext resolution)
- Tests use `pool: 'forks'` in vitest — required for `better-sqlite3` native bindings
- vitest 4: `test.exclude` schlägt CLI-File-Args; excluded Tests nur über separaten Config erreichbar (→ `vitest.integration.config.ts`)
- `process.env.VITEST === 'true'` erzwingt `ParsePool`-Sync-Fallback — Worker-Threads haben eigenen Module-Cache und würden den globalen tree-sitter-Mock in `tests/setup.ts` umgehen
- FTS5 sync is handled by SQLite triggers (not application code)
- `get_context` reads files from disk at call time (DB stores only metadata)
- `createMonitoringApp()` and `startMonitoringServer()` are separate for testability
- `GlobalRegistry` manages `~/.pindex/registry.json`; port assignment is deterministic
  (`7842 + (parseInt(hash.slice(0,4), 16) % 2000)`) and stored to stay stable
- Migration from `~/.mcp-indexer` to `~/.pindex` runs automatically on first call to
  `getPindexHome()` if the old directory exists
- Pflicht für jeden Tool-Input mit User-Pfad: `resolveWithinRoot(projectRoot, userPath)` aus `src/util/paths.ts` — verhindert Path-Traversal via `..`. Rückgabe `null` heißt „escapet Root, verwerfen". Verdrahtet in `get_context.ts`, `search_symbols.ts`, `get_file_summary.ts`, `get_dependencies.ts`, `get_doc_chunk.ts` und an allen Indexer-Sinks (`Indexer.indexFile/indexDocument/indexAll/resolveDependencies`). Dashboard-Schutz (CSWSH/DNS-Rebinding/CSRF) in `src/util/net.ts`.
- CI: `.github/workflows/ci.yml` gated lint + build + `npm test` + `npm run test:integration` + `npm audit --omit=dev --audit-level=high` bei push/PR auf main; `publish.yml` macht den npm-Release.
- Native Module (`better-sqlite3`, `tree-sitter`) brauchen ein Prebuilt passend zur laufenden Node-ABI. Auf brandneuem Node (z.B. v26) muss `better-sqlite3` ≥12.10 sein (11.x kompiliert nicht); `tests/integration/parse-pool-workers.test.ts` ist dort flaky (tree-sitter `Napi`-Crash in worker_threads) und ist vom Default-`npm test` ausgeschlossen.
- Monitoring-Dashboard (`src/monitoring/ui/`): JEDER dynamische Wert, der per `innerHTML` ins DOM geht, MUSS durch `escHtml` aus `esc.js` (ESM-Modul; `dashboard.js` lädt als `<script type="module">`). Tool-Argument-abgeleitete Felder (Session-Labels, Queries) sind angreiferbeeinflussbar.

## PindeX – Codebase Navigation

Dieses Projekt ist mit PindeX indexiert.

**PFLICHT-WORKFLOW** – bei jeder Codebase-Aufgabe:
1. **Unbekannte Datei?** → `mcp__pindex__get_file_summary` ZUERST, dann ggf. `get_context`
2. **Symbol suchen?** → `mcp__pindex__search_symbols` oder `find_symbol`
3. **Abhängigkeiten?** → `mcp__pindex__get_dependencies`
4. **Wo wird etwas verwendet?** → `mcp__pindex__find_usages`
5. **Wie hängen A und B zusammen?** → `mcp__pindex__get_call_path`
6. **Projekt-Überblick?** → `mcp__pindex__get_project_overview`

**VERBOTEN** (solange PindeX verfügbar):
- `Read` auf Quellcode-Dateien ohne vorherigen `get_file_summary`-Aufruf
- `Glob`/`Grep` zur Symbol-Suche statt `search_symbols`

**Kontext auslagern:**
- Wichtige Entscheidungen / Muster → `mcp__pindex__save_context` speichern
- Zu Sessionbeginn → `mcp__pindex__search_docs` für gespeicherten Kontext

**Fallback:** Falls ein Tool `null` zurückgibt → `Read`/`Grep` als Fallback.
<!-- pindex -->
