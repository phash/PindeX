# Changelog

## Unreleased

User-visible changes from the 2026-10-20 review-fix and call-graph branches.

### MCP tool output (smaller responses; tool names and required inputs unchanged)

- All tool results are compact JSON (no pretty-printing).
- `get_project_overview`: `mode: "brief"` returns counts only; `mode: "full"` (default) returns directory groups (top two path segments, max 50) with file/symbol counts instead of one entry per file.
- `search_symbols`: fields with default values are omitted (`summary` only when present, `isAsync`/`hasTryCatch` only when true, `project` only with more than one repository).
- `find_usages`: now backed by a resolved call graph. Entries are `{ file, line, caller, confidence }` (`project` only with more than one repository; the `context` field is gone). `confidence` is `EXTRACTED` (same file or via import) or `INFERRED` (unique name project-wide; member calls on another object only when the calling file is the target's file or imports from it). A name defined more than once without `file` returns `{ error: "ambiguous", candidates }`; an unknown name returns `{ error: "not_found" }`. Output is capped at 100 entries by default, `limit` (1–500) raises it. Only callable definitions (function, method, class, const) count.
- `get_api_endpoints`: the `handler` field is gone.
- New tool `get_call_path` (16 tools now): shortest call chain between two symbols (`from`/`to`, optional `from_file`/`to_file`, `max_depth` default 6, max 12). Returns `{ path, hops }` with edges tagged `EXTRACTED`/`INFERRED`, `{ path: null, hops: 0 }` when unreachable, `{ path: [], hops: 0 }` when `from` and `to` are the same symbol, or an `ambiguous` / `not_found` error per side. Primary repo only.
- `get_project_overview` `mode: "full"`: adds `hubs` (top 10 symbols by distinct calling files) and `communities` (top 8 file clusters from call and import edges, with label, size and top files) when the project has call edges. Member calls with common built-in method names (`arr.filter()`, `str.replace()`, …) on other objects are left out of both.
- Inputs are bounded (e.g. `limit` ≤ 100, `get_context` `range` ≤ 200, label ≤ 200 chars); out-of-range values return a validation error.
- Calls rejected in baseline mode now set `isError: true` (message unchanged). `get_token_stats` without `session_id` reports the current logging session; `start_comparison` switches logging (and baseline mode) to the new session, and the cumulative totals in live `token_event`s restart for it.

### Setup / CLI

- `.mcp.json` uses absolute paths (`command` = the `node` that ran `pindex`, `args` = absolute `dist/index.js`) and is merged instead of overwritten: other servers and keys are kept, invalid JSON is left untouched and reported.
- Re-running `pindex` rewrites `PROJECT_ROOT`, `INDEX_PATH`, `MONITORING_PORT` and `FEDERATION_REPOS` and keeps your settings for: `LANGUAGES`, `AUTO_REINDEX`, `GENERATE_SUMMARIES`, `SUMMARIZER_MODEL`, `MONITORING_AUTO_OPEN`, `EXPOSE_CORE_TOOLS_ONLY`, `OBSERVATION_RETENTION`, `PINDEX_PARSE_WORKERS`. Any other env key in the existing entry (e.g. `PINDEX_LSP`, `SUMMARIZER_API_KEY`, `SUMMARIZER_BASE_URL`, `PINDEX_BIND_HOST`, `NODE_OPTIONS`) is dropped and its name (never the value; names that are not plain `A-Z0-9_` identifiers are only counted) is printed, so a `.mcp.json` shipped with a repo cannot slip settings into your config; re-add trusted keys by hand.
- The PindeX repo's own `.mcp.json` is no longer tracked. Maintainers: run `pindex` in the repo once to regenerate it.
- The `SessionStart` hook (absolute node/script paths, `gui --no-open`) now lives in `.claude/settings.local.json`; a pindex entry in `.claude/settings.json` is moved there on the next `pindex` / `pindex reinit`. The `PreToolUse` hook lives there too (see below). `pindex remove` cleans both files. `pindex` adds `.claude/settings.local.json` to `.gitignore`.
- The GUI dashboard uses port 7841 by default (outside the per-project range 7842+); when busy it falls back to 7840…7836.
- `pindex add <path>` registers the target repo automatically if needed (alias of `pindex federate add`). `pindex add` / `pindex federate add|remove` rebuild the whole `pindex` entry in `.mcp.json` (absolute command, allowlisted env, `FEDERATION_REPOS` from the registry); hand-written `FEDERATION_REPOS` entries not in the registry are dropped.
- `FEDERATION_REPOS` is split on the OS path delimiter (`:` POSIX, `;` Windows) or may be a JSON array.
- A shutting-down server no longer deletes a PID file that a newer session has written.
- Working `PreToolUse` hook (`pindex hook`, replaces the previous no-op hook): when Claude Code reads a whole indexed, unchanged source file (no `offset`/`limit`), the hook adds a compact symbol outline (max 40 symbols) and points to `get_context`. With `PINDEX_HOOK_STRICT=1` the first such read per session and file is denied with the outline as reason. Files without symbols, documents and changed files are passed through silently. Re-run `pindex` in each project to replace an old hook entry.
- `pindex index` exits when indexing is done instead of staying alive.

### Indexing

- `PINDEX_LSP` is now **off by default**: only `PINDEX_LSP=true` enables Pyright for Python. Pyright reads the project's config and may run its configured interpreter, so enable it only for trusted repos.
- Arrow-function constants (`export const f = () => …`) are indexed with kind `function`. The first re-index after upgrading records `sig_changed` session observations for these symbols once.
- A newly added file now resolves imports of already indexed files that previously pointed at the missing file.
- Call references (calls and `new`, with the enclosing symbol) are extracted for TypeScript/JavaScript/Vue/Svelte and stored in the new `symbol_refs` table (schema v6, replaces the never-filled `usages` table). The upgrade resets the hash of TS/JS/Vue/Svelte files once so the next index run re-parses them; existing LLM summaries are reused for that run.
- On Windows, indexed paths are stored with forward slashes (`glob` now runs with `posix: true`); before, watcher-added files were not linked to their importers there.
- File watcher moved to chokidar 4 (removes the vulnerable `braces` dependency, GHSA-vfj7-8cjw-p6xm). chokidar 4 has no glob support, so the watcher now watches the project root and filters with the same globs as the initial index (`minimatch`, dot files and dot directories excluded, ignored directories such as `node_modules` are not descended).

### Dependencies

- Security updates via the lockfile: `@modelcontextprotocol/sdk` 1.32.1 (minimum raised to ^1.32.1), `express` transitive deps (`proxy-addr`, `qs`, `body-parser`, `ip-address`, `fast-uri`, `hono`, `brace-expansion`), `vitest` 4.1.12 (dev). `npm audit` reports 0 vulnerabilities.
