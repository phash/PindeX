# Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken features, risky write paths, token waste and dead code found by the full review on 2026-10-20, before the call-graph feature plan (`2026-10-20-call-graph-hook-architecture.md`) builds on top.

**Architecture:** No new subsystems. Each task fixes one defect cluster at the narrowest layer, with a regression test that fails on today's `main`.

**Tech Stack:** TypeScript 5.x (ESM/NodeNext), `better-sqlite3`, Vitest 4 (`pool: 'forks'`), Zod 4. No new dependencies.

**Spec:** Review findings of 2026-10-20 (session transcript). Each task quotes the finding it fixes.

## Global Constraints

- Node >= 18, ESM, relative imports end in `.js`. No new npm dependencies.
- Every user path through `resolveWithinRoot` (`src/util/paths.ts`).
- Do not commit `.claude/`, `dist/`. `.mcp.json` gets untracked in Task 6.
- Public MCP tool names and required inputs stay unchanged (no breaking change for clients). Output shapes may shrink only where the task says so.
- Update `CLAUDE.md` / `README.md` in the task that changes documented behavior.
- Each task ends with `npm run lint && npm test` green.

## Review Focus

1. Existing user DBs (schema v5) must keep working after every task — no migration in this plan. → covered by not touching schema; Task 1 test uses an existing-DB fixture.
2. `.mcp.json` with other servers (`serena`, custom) must survive `pindex init`, `add`, `remove`, `migrate`. → Task 6 test.
3. Two processes writing `registry.json` at once must never yield a registry with fewer projects. → Task 7 test.
4. Windows paths (`E:\x`) in `FEDERATION_REPOS` must round-trip. → Task 11 test.
5. Compact JSON output must still be valid JSON for every tool, incl. errors. → Task 8 test over all tool names.

---

### Task 1: Reliable import edges

Findings: `.js` specifiers never map to `.ts`; `deleteDependenciesByFile` deletes `from_file = ? OR to_file = ?` so `resolveDependencies` wipes edges it wrote earlier; watcher reindex deletes a file's edges and nothing rebuilds them; no transaction around edge inserts; document files get re-parsed.

**Files:** Modify `src/indexer/index.ts` (`resolveImportPath`, `resolveDependencies`, `processParsedFile`), `src/db/queries.ts`. Test `tests/indexer/indexer.test.ts`, `tests/db/queries.test.ts`.

**Interfaces:**
- Produces: `deleteOutgoingDependencies(db, fileId: number): void` (`WHERE from_file = ?` only); `Indexer.resolveFileDependencies(relativePath: string, imports: ParsedImport[]): void`, called at the end of `processParsedFile`. Feature plan Task 4 relies on correct `dependencies` rows.

- [ ] **Step 1: Failing tests** (`describe('resolveDependencies — import specifiers')`, hand-built imports cache passed to `resolveDependencies`):
  - `src/a.ts` imports `{ source:'./b.js', symbols:['b'] }`, `src/b.ts` exists → edge `a→b`, `symbol_name='b'`.
  - `'./c.js'` with `src/c.tsx` → edge to `c.tsx`. `'./d.js'` with both `src/d.js` and `src/d.ts` → `src/d.js` (exact wins). `'./dir'` with `src/dir/index.tsx` → edge.
  - `a→b` and `z→b` → both edges exist after resolve.
  - After full resolve: `indexFile('src/b.ts', true)` with new content → `a→b` still there; `indexFile('src/a.ts', true)` → `a→b` re-created.
- [ ] **Step 2: Run** `npx vitest run tests/indexer/indexer.test.ts -t "import specifiers"` → FAIL.
- [ ] **Step 3: Implement.** Candidate order: exact → `+['.ts','.tsx','.js','.jsx','.mjs','.cjs']` → swap `.js|.jsx|.mjs|.cjs` to `.ts|.tsx|.mts|.cts` → `/index` + `['.ts','.tsx','.js','.jsx']`. Use `deleteOutgoingDependencies` in both places; remove `deleteDependenciesByFile` if unused. One `db.transaction` around the resolve loop. Skip `isDocumentLanguage(file.language)`.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(indexer): keep import edges intact and resolve NodeNext .js specifiers`

### Task 2: Watcher and indexer hygiene

Findings: watcher calls `indexFile(path, true)` (bypasses hash, re-runs LLM summaries); watcher ignore list differs from `DEFAULT_IGNORE`; documents are not watched; files deleted while the server was down are never pruned; `deleteFile` leaves `ast_snapshots`; watcher `emit('error')` with no listener crashes.

**Files:** Modify `src/indexer/watcher.ts`, `src/indexer/index.ts` (`indexAll`), `src/index.ts` (error listener), `src/db/queries.ts` (`deleteFile` also deletes `ast_snapshots WHERE file_path = ?`). Test `tests/indexer/watcher.test.ts`, `tests/indexer/indexer.test.ts`.

**Interfaces:**
- Produces: `Indexer.ignorePatterns: readonly string[]` (public getter) consumed by `FileWatcher`; `IndexAllResult.removed: number`.

- [ ] **Step 1: Failing tests:** watcher change event calls `indexFile(path, false)`; watcher passes `indexer.ignorePatterns` to chokidar `ignored`; `.md` change event routes to `indexDocument`; `indexAll` with a DB row for a file missing on disk → row deleted, `result.removed === 1`, its `ast_snapshots` gone; watcher error with no listener does not throw (`src/index.ts` attaches `watcher.on('error', …)` writing to stderr — assert via a test that `FileWatcher` emits and the handler is registered, or by unit-testing the attach helper).
- [ ] **Step 2: Run** `npx vitest run tests/indexer` → FAIL.
- [ ] **Step 3: Implement** as listed. Pruning runs after the glob, only for code + document languages the indexer handles.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(indexer): hash-checked watcher reindex, shared ignores, prune deleted files`

### Task 3: Timestamp comparisons in session memory

Findings: `getRecentFileChangeEvents` (`src/db/queries.ts:~755`) compares `CURRENT_TIMESTAMP` strings (`YYYY-MM-DD HH:MM:SS`) with `toISOString()` → thrash detection never fires; `new Date(last.timestamp)` reads UTC as local; retention (`src/memory/retention.ts:~34`) has the same mismatch.

**Files:** Modify `src/db/queries.ts`, `src/memory/anti-patterns.ts`, `src/memory/retention.ts`. Test `tests/memory/anti-patterns.test.ts`, `tests/memory/retention.test.ts` (create if missing), `tests/db/queries.test.ts`.

**Interfaces:**
- Produces: `getRecentFileChangeEvents(db, filePath, sessionId, windowMinutes)` unchanged signature, SQL uses `timestamp >= datetime('now', ?)` with `` `-${windowMinutes} minutes` ``. `deleteObservationsOlderThan(db, days: number)` uses `datetime('now', '-N days')`. Helper `parseSqliteUtc(ts: string): Date` (appends `Z` after replacing the space with `T`) in `src/db/queries.ts`.

- [ ] **Step 1: Failing tests:** insert 3 `sig_changed` events with default timestamps → `getRecentFileChangeEvents(..., 5)` returns 3; thrash detector fires on them; event with `timestamp = datetime('now','-10 minutes')` excluded; retention `30d` keeps a row from `-29 days` and deletes one from `-31 days`; `parseSqliteUtc('2026-01-01 10:00:00').toISOString() === '2026-01-01T10:00:00.000Z'`.
- [ ] **Step 2: Run** `npx vitest run tests/memory tests/db/queries.test.ts` → FAIL.
- [ ] **Step 3: Implement**; replace every `new Date(<db timestamp>)` in `src/memory/` with `parseSqliteUtc`.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(memory): compare SQLite timestamps in SQL so thrash detection and retention work`

### Task 4: Token stats and A/B comparison sessions

Findings: `get_token_stats` without `session_id` reads session `'default'`, real sessions are UUIDs; `start_comparison` creates a session nobody logs to and `mode: 'baseline'` does not enable baseline mode.

**Files:** Modify `src/tools/get_token_stats.ts`, `src/tools/start_comparison.ts`, `src/monitoring/token-logger.ts`, `src/server.ts`. Test `tests/tools/get_token_stats.test.ts`, `tests/tools/start_comparison.test.ts`, `tests/integration/` or `tests/helpers` server-level test.

**Interfaces:**
- Produces: `getTokenStats(db, input, currentSessionId: string)`; `TokenLogger.setSessionId(id: string): void` and `getSessionId()` (exists); in `createMcpServer` a mutable `state = { sessionId, baselineMode }`. `start_comparison` switches `tokenLogger` to the new session and sets `state.baselineMode = input.mode === 'baseline'`. Observer/session memory keeps the original session id.

- [ ] **Step 1: Failing tests** (through `createMcpServer` + in-memory transport or the existing server test helper): call `search_symbols`, then `get_token_stats {}` → `total_calls ≥ 1`; `start_comparison {mode:'baseline'}` then `search_symbols` → returns the baseline error and the token log row has the new `session_id`; `start_comparison {mode:'indexed'}` → baseline off again.
- [ ] **Step 2: Run** the new tests → FAIL.
- [ ] **Step 3: Implement.** Update tool description of `get_token_stats` (`session_id` omitted = current logging session).
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(tools): token stats default to current session; start_comparison switches logging and baseline`

### Task 5: Daemon PID lifecycle and shutdown

Findings: `writePidFile` never called → `status/stop/restart` never see a process; PID check matches `/node/` (could kill unrelated Node); no cleanup when stdin closes; systemd unit in `setup.ts` runs bare CLI (= `pindex init` in `$HOME`).

**Files:** Modify `src/index.ts`, `src/cli/daemon.ts`, `src/cli/setup.ts`. Test `tests/cli/daemon.test.ts`, `tests/cli/setup.test.ts`.

**Interfaces:**
- Produces: `src/index.ts` writes the PID file (existing `writePidFile(projectHash)` path) after startup and removes it in the shared `shutdown()`; `shutdown()` also runs on `process.stdin` `end`/`close` and `transport.onclose`. `isPindexProcess(cmdline: string): boolean` exported from `daemon.ts`, true only if cmdline contains `pindex` or `dist/index.js`.

- [ ] **Step 1: Failing tests:** `isPindexProcess('node /usr/lib/node_modules/pindex/dist/index.js') === true`, `isPindexProcess('node server.js') === false`; `stopDaemon` does not signal a PID whose cmdline fails the check; setup no longer writes a systemd unit with bare `ExecStart` (assert generated unit is absent — remove the unit generation and its test).
- [ ] **Step 2: Run** `npx vitest run tests/cli` → FAIL.
- [ ] **Step 3: Implement.** Remove systemd unit generation from `setup.ts` (and docs mentioning it).
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS. Manual: `node dist/index.js` with env, then `node dist/cli/index.js status` shows running; close stdin → PID file gone.
- [ ] **Step 5: Commit** `fix(cli): write PID file from server, safe process check, clean shutdown on stdin close`

### Task 6: `.mcp.json` — merge and absolute command

Findings: `writeMcpJson` overwrites the whole file (deletes other servers); writes bare `pindex-server` (fails if global bin not on PATH, contradicts README "absolute paths"); repo `.mcp.json` is tracked with Windows paths.

**Files:** Modify `src/cli/init.ts` (`writeMcpJson`, `removeMcpJson`), `src/cli/federate.ts` (reuse the merge helper), `.gitignore`; `git rm --cached .mcp.json`. Test `tests/cli/init.test.ts`, `tests/cli/federate.test.ts`.

**Interfaces:**
- Produces: `mergeMcpServer(projectRoot: string, name: 'pindex', server: McpServerEntry | null): void` (null = remove key; deletes file only if `mcpServers` becomes empty and no other top-level keys). `writeMcpJson` writes `command: process.execPath`, `args: [<absolute path of dist/index.js resolved from import.meta.url>]`.

- [ ] **Step 1: Failing tests:** existing `.mcp.json` with `serena` server → after `writeMcpJson` both `serena` and `pindex` present; after `removeMcpJson` only `serena` remains and file still exists; `command` is absolute and `args[0]` ends with `dist/index.js`; federate add keeps foreign servers (existing behavior preserved).
- [ ] **Step 2: Run** `npx vitest run tests/cli` → FAIL.
- [ ] **Step 3: Implement**; untrack `.mcp.json`, add to `.gitignore`; README setup section matches reality.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(cli): merge .mcp.json instead of overwriting, use absolute node + script path`

### Task 7: Atomic registry writes

Findings: `GlobalRegistry` writes truncate-in-place; parse failure returns `[]` → next upsert drops all other projects; `read()` writes during migration.

**Files:** Modify `src/cli/project-detector.ts`. Test `tests/cli/project-detector.test.ts`.

**Interfaces:**
- Produces: private `writeAtomic(path, data)` = write `path.<pid>.tmp` + `renameSync`; mutating methods (`upsert`, `remove`, `update*`) re-read inside a lock (`registry.json.lock` via `openSync(..., 'wx')`, retry 50× 20 ms, stale lock > 5 s removed) and throw `RegistryCorruptError` on JSON parse failure instead of treating it as empty. Read-only `list()` still returns `[]` on a missing file.

- [ ] **Step 1: Failing tests:** corrupt `registry.json` → `upsert` throws `RegistryCorruptError` and file content unchanged; 20 parallel child-free upserts via `Promise.all` of separate `GlobalRegistry` instances (sync calls in a loop interleaved with manual lock files) → all 20 entries present; no `.tmp` files left.
- [ ] **Step 2: Run** `npx vitest run tests/cli/project-detector.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(cli): atomic, locked registry writes; never treat corrupt registry as empty`

### Task 8: Compact, honest tool output

Findings: responses pretty-printed (2-space indent); `get_project_overview` `brief` still lists every file, `full` dumps all files with null summaries; `search_symbols` emits `isAsync/hasTryCatch/summary/project` defaults and dedupes on `project::name::kind` (drops same-named symbols in different files); `find_usages.context` repeats `file:line`; `get_api_endpoints.handler` duplicates `name`; no max on `range`/`limit`; exceptions become generic "Tool failed".

**Files:** Modify `src/server.ts`, `src/tools/get_project_overview.ts`, `src/tools/search_symbols.ts`, `src/tools/find_usages.ts`, `src/tools/get_api_endpoints.ts`, `src/tools/schemas.ts`, `src/federation/repo-set.ts` (throw `UserInputError`), `src/types.ts`. Test matching files in `tests/tools/`, `tests/tools/validation.test.ts`.

**Interfaces:**
- Produces: `class UserInputError extends Error` in `src/tools/errors.ts`; server returns its message verbatim as `{ error: message }`, other errors stay generic. Server serializes with `JSON.stringify(result)` (no indent). Overview: `brief` = no `modules`; `full` = `modules` grouped by top two path segments `{ dir, files, symbols }`, max 50 groups, per-file entries only when `summary` is non-null. `search_symbols` dedupe key `project::file::line::name`, omits `isAsync`/`hasTryCatch` when false, `summary` when null, `project` when only one repo. Zod: `get_context.range` max 200, every `limit` max 100.

- [ ] **Step 1: Failing tests:** brief overview has no `modules`; full overview on 120 files in 3 dirs → ≤ 3 groups; two `handler` symbols in different files both returned by `search_symbols`; result row for a non-async symbol has no `isAsync` key; `find_usages` rows have no `context`; `get_context {range: 201}` rejected; unknown `repos: ['nope']` → response text contains `unknown repo` (or the actual RepoSet message); every tool's response text `JSON.parse`s and contains no `"\n  "`.
- [ ] **Step 2: Run** `npx vitest run tests/tools` → FAIL.
- [ ] **Step 3: Implement**; update tool descriptions (`get_project_overview`: "brief=counts only; full=directory groups").
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `perf(tools): compact JSON, smaller overview/search output, input bounds, user-facing errors`

### Task 9: Deterministic symbol lookup

Findings: `getSymbolByName … LIMIT 1` without `ORDER BY` picks an arbitrary match; `filePath` branch not slash-normalized. Feature plan relies on this.

**Files:** Modify `src/db/queries.ts`, `src/tools/get_symbol.ts`. Test `tests/db/queries.test.ts`, `tests/tools/get_symbol.test.ts`.

**Interfaces:**
- Produces: `getSymbolsByName(db, name: string, filePath?: string): SymbolRecord[]` ordered `is_exported DESC, f.path ASC, start_line ASC`; `getSymbolByName` = first of that list. `normalizeRelPath(p: string): string` in `src/util/paths.ts` (backslash → `/`, strip leading `./`).

- [ ] **Step 1: Failing tests:** two `format` symbols (`src/b.ts` exported, `src/a.ts` not) → `getSymbolByName` returns `src/b.ts`; `filePath: '.\\src\\a.ts'` finds `src/a.ts`; `get_symbol` returns the same deterministic pick.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(db): deterministic symbol lookup with normalized file filter`

### Task 10: Parser correctness (tree-sitter)

Findings: `extractFromExportStatement` uses `descendantsOfType('variable_declarator')` → locals inside arrow bodies become exported consts; non-exported `const f = () => {}` missing; arrow functions get kind `const` with name-only signature; `abstract_class_declaration` missing; `extractMethodsFromClass` picks methods of nested classes.

**Files:** Modify `src/indexer/parser.ts`. Test `tests/indexer/real-parse.test.ts` (real tree-sitter).

**Interfaces:**
- Produces: arrow/function-expression consts emitted with `kind: 'function'` and signature `name(params)ret`; top-level `lexical_declaration` handled for non-exported consts.

- [ ] **Step 1: Failing tests:** `export const h = () => { const inner = 1; }` → symbols `['h']` only, `h.kind === 'function'`, signature `h()`; `const f = (a: number) => a` → `f` present, `isExported: false`; `export abstract class A { m() {} }` → `A` (class) + `m` (method); `class O { m(){ const x = class { n(){} } } }` → no `n`.
- [ ] **Step 2: Run** `npx vitest run tests/indexer/real-parse.test.ts` → FAIL.
- [ ] **Step 3: Implement** with direct `namedChildren` traversal instead of `descendantsOfType` for declarators and class bodies (`class_body` children only).
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(parser): no locals as exports, arrow consts as functions, abstract classes`

### Task 11: Federation delimiter and aliases

Findings: `FEDERATION_REPOS` joined/split on `:` breaks `E:\…`; federated repos get the target's registry name instead of the alias from `federate add --name`; two federation command paths (`pindex add` vs `pindex federate add`) with different behavior.

**Files:** Modify `src/index.ts`, `src/cli/init.ts`, `src/cli/federate.ts`, `src/cli/index.ts`. Test `tests/cli/federate.test.ts`, `tests/federation/*`.

**Interfaces:**
- Produces: `parseFederationRepos(value: string): string[]` and `formatFederationRepos(paths: string[]): string` in `src/federation/env.ts` using `path.delimiter`; parse also accepts a JSON array string (`[`-prefixed). `pindex add/remove <path>` become aliases calling `federateAdd/federateRemove`; `addFederatedRepo`/`removeFederatedRepo` in `init.ts` deleted.

- [ ] **Step 1: Failing tests:** `parseFederationRepos(formatFederationRepos(['E:\\a','E:\\b']))` round-trips on win32 (`path.win32.delimiter` injected) and posix; `'["/a","/b"]'` parses; alias from `federatedRepos[].name` used as repo name in `RepoSet`; `pindex add <p>` keeps foreign `.mcp.json` servers (via Task 6 helper).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; update CLAUDE.md env line (`FEDERATION_REPOS` uses the OS path delimiter or a JSON array).
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(federation): OS path delimiter, alias names, single command path`

### Task 12: CLI templates, SessionStart hook, GUI port

Findings: injected CLAUDE.md section names non-existent `find_symbol` and claims tools return `null`; removal regex starts at the first `## PindeX` heading anywhere; `SessionStart` hook `pindex gui` opens a browser every session and crashes on ENOENT; GUI default port 7842 collides with the per-project port range; `_pindex` unknown key detection by raw text.

**Files:** Modify `src/cli/init.ts`, `src/cli/index.ts` (`gui` command), `src/gui/index.ts`, `src/cli/project-detector.ts` (`computeDefaultPort`). Test `tests/cli/init.test.ts`, `tests/cli/project-detector.test.ts`.

**Interfaces:**
- Produces: CLAUDE.md section wrapped in `<!-- pindex:start -->` … `<!-- pindex:end -->`; removal strips only between markers (legacy section without start marker: strip from the exact `## PindeX – Codebase Navigation` heading to the end marker only). `pindex gui --no-open`; SessionStart hook command uses `--no-open` and absolute node + script path (same scheme as Task 6). Spawn of GUI attaches `.on('error')`. `GUI_DEFAULT_PORT = 7841`; `computeDefaultPort` never returns 7841.

- [ ] **Step 1: Failing tests:** template contains no `find_symbol` and no `null`; CLAUDE.md with a user heading `## PindeX notes` above the section → after remove the user heading survives; hook command contains `--no-open`; `computeDefaultPort` over 10 000 random hashes never returns 7841.
- [ ] **Step 2: Run** `npx vitest run tests/cli` → FAIL.
- [ ] **Step 3: Implement**; document `GUI_PORT` and `EXPOSE_CORE_TOOLS_ONLY` in CLAUDE.md env block.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(cli): marker-based CLAUDE.md section, quiet GUI hook, collision-free GUI port`

### Task 13: Python LSP robustness

Findings: after a crash the old process's `exit` handler fires during restart and sets `failed`; timeout path never sends `didClose`; pyright resolved from `process.cwd()`; `lsp-mapper.ts` recurses into function children (locals as exported symbols).

**Files:** Modify `src/indexer/lsp-python.ts`, `src/indexer/lsp-mapper.ts`. Test `tests/indexer/lsp-python.test.ts`, `tests/indexer/lsp-mapper.test.ts`.

- [ ] **Step 1: Failing tests:** simulated crash then restart → state `ready`, not `failed`; timed-out `getDocumentSymbols` sends `didClose` (spy on the connection); pyright path resolved via `createRequire(import.meta.url).resolve('pyright/package.json')` when cwd is unrelated; mapper on a function with a local variable child → only the function.
- [ ] **Step 2: Run** `npx vitest run tests/indexer/lsp-*.test.ts` → FAIL.
- [ ] **Step 3: Implement**: capture `proc` locally, ignore exits when `this.proc !== proc`; `didClose` in `finally`; resolution order package → `projectRoot` → PATH; mapper descends only into Class children.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(lsp): survive restarts, close timed-out docs, resolve pyright from package`

### Task 14: Dead code removal

**Files:** see list. Test: `npm run lint` + `npm test` (tests of deleted functions are deleted with them).

Delete (verified dead by knip + grep on 2026-10-20):
- `src/monitoring/estimator.ts` + `tests/monitoring/estimator.test.ts` (prod uses multiplier in `server.ts`; keep that).
- `queries.ts`: `updateSession`; `getSessionEvents` (move to `tests/helpers` if a test needs it).
- `parser.ts`: `isDocumentLanguage` stays only if Task 1/2 now use it in prod — otherwise delete.
- `setup.ts`: `registerMcpServer`. `daemon.ts`: `showStatus`. `project-detector.ts`: `getMcpIndexerHome`, `getProjectMetaPath`, `ProjectMeta`.
- `tests/helpers/mcp.ts` (unused).
- `types.ts`: `IndexerConfig`, `DependencyRecord`, `TokenLogEntry`, `ContextEntryRecord` + their imports.
- Unused imports: `daemon.ts:getPindexHome`, `init.ts:relative,basename`, `indexer/index.ts:relative`, `parser.ts:readFileSync`, `indexer/index.ts:deleteUsagesByFile` (the `usages` helpers themselves go in feature plan Task 3).
- `gui/server.ts`: un-export `loadProjectStats`.
- `server.ts:~495` dangling JSDoc; stale comment `indexer/index.ts:209` ("Task 7 will consume it").
- `package.json` `dev` script → `"dev": "tsc --watch"`.
- `token_log.files_touched`: stop accepting `filesTouched` in `insertTokenLog` (column stays, no migration).
- Docs: remove `TOKEN_PRICE_PER_MILLION` from `CLAUDE.md`, `README.md`, `goose-extension.yaml`; fix README index path (`{project}/.pindex/index.db`) if Task 6 did not.

- [ ] **Step 1:** Delete items; run `npx tsc --noEmit --noUnusedLocals` → no TS6133/TS6196 in touched files.
- [ ] **Step 2: Run** `npm run lint && npm test && npm run build` → PASS.
- [ ] **Step 3: Commit** `chore: remove dead code found by knip/tsc review`

### Task 15: CI hardening

Findings: CI only Node 20/Ubuntu; coverage threshold never enforced; tests not type-checked; publish runs no tests.

**Files:** Modify `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, create `tsconfig.test.json`, `package.json` (`lint` script).

- [ ] **Step 1:** CI matrix `os: [ubuntu-latest, windows-latest]` × `node: [20, 22, 24]`; replace `npm test` with `npm run test:coverage`; `lint` = `tsc --noEmit && tsc -p tsconfig.test.json --noEmit`.
- [ ] **Step 2: Run** `npm run lint` locally → fix type errors in tests (only type fixes, no behavior change). `npm run test:coverage` → threshold met.
- [ ] **Step 3:** `publish.yml`: `npm ci`, `npm run lint`, `npm test`, `npm run build`, `npm run test:integration` before `npm publish`.
- [ ] **Step 4:** Push branch, `gh run watch` → all matrix jobs green (Windows failures that are real bugs → fix in this task or file an issue and mark job `continue-on-error` with a comment naming the issue).
- [ ] **Step 5: Commit** `ci: OS x Node matrix, enforced coverage, type-checked tests, gated publish`

---

## Final verification

- [ ] `npm run lint && npm test && npm run build && npm run test:integration` green.
- [ ] Reindex PindeX itself; `get_dependencies {target:'src/server.ts'}` lists its imports (was empty before Task 1).
- [ ] Then start feature plan `docs/superpowers/plans/2026-10-20-call-graph-hook-architecture.md` — its Task 1 is already done here (skip it there).
