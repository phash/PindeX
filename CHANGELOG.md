# Changelog

## Unreleased

User-visible changes from the 2026-10-20 review-fix branch.

### MCP tool output (smaller responses; tool names and required inputs unchanged)

- All tool results are compact JSON (no pretty-printing).
- `get_project_overview`: `mode: "brief"` returns counts only; `mode: "full"` (default) returns directory groups (top two path segments, max 50) with file/symbol counts instead of one entry per file.
- `search_symbols`: fields with default values are omitted (`summary` only when present, `isAsync`/`hasTryCatch` only when true, `project` only with more than one repository).
- `find_usages`: entries are `{ file, line, project }`; the `context` field is gone.
- `get_api_endpoints`: the `handler` field is gone.
- Inputs are bounded (e.g. `limit` ≤ 100, `get_context` `range` ≤ 200, label ≤ 200 chars); out-of-range values return a validation error.
- Calls rejected in baseline mode now set `isError: true` (message unchanged). `get_token_stats` without `session_id` reports the current logging session; `start_comparison` switches logging (and baseline mode) to the new session, and the cumulative totals in live `token_event`s restart for it.

### Setup / CLI

- `.mcp.json` uses absolute paths (`command` = the `node` that ran `pindex`, `args` = absolute `dist/index.js`) and is merged instead of overwritten: other servers and keys are kept, invalid JSON is left untouched and reported.
- Re-running `pindex` rewrites `PROJECT_ROOT`, `INDEX_PATH`, `MONITORING_PORT` and `FEDERATION_REPOS` and keeps your settings for: `LANGUAGES`, `AUTO_REINDEX`, `GENERATE_SUMMARIES`, `SUMMARIZER_MODEL`, `MONITORING_AUTO_OPEN`, `EXPOSE_CORE_TOOLS_ONLY`, `OBSERVATION_RETENTION`, `PINDEX_PARSE_WORKERS`. Any other env key in the existing entry (e.g. `PINDEX_LSP`, `SUMMARIZER_API_KEY`, `SUMMARIZER_BASE_URL`, `PINDEX_BIND_HOST`, `NODE_OPTIONS`) is dropped and its name (never the value; names that are not plain `A-Z0-9_` identifiers are only counted) is printed, so a `.mcp.json` shipped with a repo cannot slip settings into your config; re-add trusted keys by hand.
- The PindeX repo's own `.mcp.json` is no longer tracked. Maintainers: run `pindex` in the repo once to regenerate it.
- The `SessionStart` hook (absolute node/script paths, `gui --no-open`) now lives in `.claude/settings.local.json`; a pindex entry in `.claude/settings.json` is moved there on the next `pindex` / `pindex reinit`. The `PreToolUse` hook stays in `.claude/settings.json`. `pindex remove` cleans both files. `pindex` adds `.claude/settings.local.json` to `.gitignore`.
- The GUI dashboard uses port 7841 by default (outside the per-project range 7842+); when busy it falls back to 7840…7836.
- `pindex add <path>` registers the target repo automatically if needed (alias of `pindex federate add`). `pindex add` / `pindex federate add|remove` rebuild the whole `pindex` entry in `.mcp.json` (absolute command, allowlisted env, `FEDERATION_REPOS` from the registry); hand-written `FEDERATION_REPOS` entries not in the registry are dropped.
- `FEDERATION_REPOS` is split on the OS path delimiter (`:` POSIX, `;` Windows) or may be a JSON array.
- A shutting-down server no longer deletes a PID file that a newer session has written.

### Indexing

- `PINDEX_LSP` is now **off by default**: only `PINDEX_LSP=true` enables Pyright for Python. Pyright reads the project's config and may run its configured interpreter, so enable it only for trusted repos.
- Arrow-function constants (`export const f = () => …`) are indexed with kind `function`. The first re-index after upgrading records `sig_changed` session observations for these symbols once.
- A newly added file now resolves imports of already indexed files that previously pointed at the missing file.
