# Federation-as-USP MVP — Design Spec

**Date:** 2026-04-25
**Status:** Approved for implementation planning
**Target area:** `src/federation/` (new), 9 tool files, `src/server.ts`, `src/cli/`, `src/tools/schemas.ts`

## Problem

PindeX has a latent federation feature — the `FEDERATION_REPOS` env var opens additional project DBs read-only — but only 2 of 14 tools actually use it (`search_symbols` and `get_project_overview`). The other 12 tools are blind to federated repos. Project identification in federated results relies on `basename(path)`, which collides when two federated repos share a directory name. No CLI exists for managing federation; configuration is via an env var in `.mcp.json`. Result: federation is a paper feature, not something a user can discover, configure, or use across the tool surface.

Competitive pressure: Serena MCP, the closest peer, is better at symbol extraction for most languages (LSP-based — a gap PindeX just closed for Python in v1.4.0) but **does not support federated search across multiple repos**. A serious federation story is PindeX's natural differentiator; shipping a half-working one undermines the pitch.

## Goals

- All 9 read-only exploration tools become federation-aware: `search_symbols`, `find_usages`, `get_symbol`, `get_file_summary`, `get_context`, `get_dependencies`, `get_project_overview`, `search_docs`, `get_doc_chunk`.
- A `repos?: string[]` parameter on those tools lets the caller scope a query to specific federated repos.
- Federated results are tagged with a stable `project: string` name that never collides.
- Configuration is CLI-driven: `pindex federate add / remove / list`.
- The primary (local) repo is treated as "just another repo in the set" internally, eliminating the primary-vs-federated branching that complicates current tool code.
- The 5 write/session tools (`reindex`, `save_context`, `get_session_memory`, `start_comparison`, `get_token_stats`) stay strictly local.
- Zero DB-schema changes. Zero Indexer changes.

## Non-Goals

- Cross-repo import resolution (`get_dependencies` does not follow imports across repos). Separate spec.
- Wildcards / glob patterns in the `repos` param. Exact names only.
- Auto-discovery of sibling indexed projects (`pindex federate suggest`). Separate spec.
- GUI / dashboard changes for federation visibility. Separate spec.
- Any write-across-federation semantics.
- Federation-specific benchmarks in this MVP.

## Architecture

```
Main thread (owns primary DB + federated DBs + one RepoSet)
  MCP server startup:
    1. openDatabase(INDEX_PATH) → primary DB
    2. For each FEDERATION_REPOS entry:
         openDatabase(…, readonly=true) → federated DB
    3. Each federated DB gets a FederatedDb record: { name, path, db }
       where `name` comes from GlobalRegistry (default basename,
       basename+4-hex on collision)
    4. The primary DB also becomes a FederatedDb with the local name
       → uniform treatment: "local" is just one repo in the set
    5. Build RepoSet from all FederatedDbs

  Tool call arrives:
    ├─ tool handler (e.g. searchSymbols)
    │    repoSet.filter(input.repos):
    │      if input.repos is undefined/empty → return all repos
    │      else → return matching repos, throw on unknown name
    │
    ├─ for each scoped repo:
    │    run the query against repo.db
    │    tag results with `project: repo.name`
    │
    ├─ mergeResults(perRepo, dedupStrategy):
    │    - search_symbols: dedupByKey `${project}::${name}::${kind}`
    │    - find_usages:    dedupByKey `${project}::${file}::${line}`
    │    - search_docs:    dedupByKey `${project}::${file}::${chunkIndex}`
    │    - get_symbol:     no dedup; one entry per repo
    │
    └─ return results[]
```

### Why enhance-via-uniform-set rather than bolt-onto-existing

The present code has two execution paths: "local DB" and "federated DBs". Each tool that adopts federation must learn both. Making the primary DB a `FederatedDb` with an `isPrimary: true` flag (or just identical treatment) collapses the two paths into one `repoSet.forEach`. Result: each tool's federation code is the same five-line pattern, which makes the tool-level work mechanical and easy to review.

## Components

### New files

**`src/federation/repo-set.ts`** — `RepoSet` class holding a list of `{ name, path, db, isPrimary }`. Methods:
- `static fromServerConfig(primary, federatedDbs, primaryName): RepoSet` — builds the unified set.
- `filter(repos?: string[]): Repo[]` — returns all repos when `repos` is undefined or empty; returns the filtered subset otherwise. Throws a plain `Error` on unknown names with a message of the form `Unknown repo name: '<x>'. Known: [a, b, c]`. The MCP server's existing top-level catch in `src/server.ts` converts any thrown `Error` from a tool handler into `{ error: <message> }`, so no per-tool try/catch is required.
- `get primary(): Repo` — exposes the primary (for tools that need a distinction, e.g. `reindex` — but those tools don't receive a RepoSet, so this is a safety accessor rarely used).
- `get all(): Repo[]` — full list.

**`src/federation/merge.ts`** — pure merge helpers:
- `dedupByKey<T>(results: T[], keyFn: (t: T) => string): T[]` — generic dedup, first occurrence wins, `project` tags preserved.
- No tool-specific logic here; each tool imports `dedupByKey` and supplies its own key function inline.

**`src/federation/registry-name.ts`** — name-generation helper:
- `assignName(path: string, existingNames: Set<string>): string` — returns `basename(path)` if free, otherwise `${basename}-${shortHash(path).slice(0,4)}`. Pure function, easy to test.

**`src/cli/federate.ts`** — CLI subcommands:
- `federateAdd(cwd: string, targetPath: string, options: { name?: string }): Promise<void>`
- `federateRemove(cwd: string, nameOrPath: string): Promise<void>`
- `federateList(cwd: string): Promise<void>`

All three operate on the **current** project (identified via `findProjectRoot(cwd)`) and modify two stores: `GlobalRegistry` (add the target as a federated entry of the current project, record its `name`) and `.mcp.json` (update the `env.FEDERATION_REPOS` block).

**`tests/federation/repo-set.test.ts`** — filter logic, unknown-name error, empty-repos fallback, primary-only case.

**`tests/federation/merge.test.ts`** — dedupByKey with collisions / without / empty input.

**`tests/federation/registry-name.test.ts`** — name assignment with and without collisions.

**`tests/cli/federate.test.ts`** — CLI add/remove/list against a temp registry + `.mcp.json`.

**`tests/integration/federation-e2e.test.ts`** — real MCP server with 2 indexed temp projects + federation, tool calls over the real transport.

### Modified files

**`src/server.ts`** — `FederatedDb` interface gets `name: string` (previously absent). `createMcpServer` builds a `RepoSet` from `(primaryDb, primaryName, federatedDbs)` and passes it to tool handlers instead of the separate `db` + `federatedDbs` arguments.

**9 tool files** (one per tool in the federation-aware set):
- Signature change: `(db, input, federatedDbs?, projectRoot?)` → `(repoSet, input, projectRoot?)`.
- Body change: wrap existing query logic in `repoSet.filter(input.repos).forEach(repo => …)`, tag results with `project: repo.name`, `dedupByKey(...)` as appropriate.
- Result types: every returned item gets `project: string` (non-optional).

**`src/tools/schemas.ts`** — add optional `repos: z.array(z.string()).optional()` to the schemas of the 9 federation-aware tools. Leave write/session tool schemas untouched.

**`src/cli/index.ts`** — router gets a new `federate` subcommand that delegates to `cli/federate.ts`.

**`src/cli/init.ts`** — on `pindex init`, set the local registry entry's `name` (using `assignName`). The `.mcp.json` env block still receives `FEDERATION_REPOS` as a colon-separated path list (unchanged); names are stored alongside paths in `registry.json`.

**`src/cli/project-detector.ts`** — `GlobalRegistry` entries get a new `name: string` field. On first read after upgrade, entries without `name` get auto-named and the registry is written back (one-time migration).

**`src/types.ts`** — update the result types of the 9 federation-aware tools to make `project: string` required.

### Unchanged (explicitly)

- The 5 write/session tools: `reindex`, `save_context`, `get_session_memory`, `start_comparison`, `get_token_stats`.
- DB schema and migrations.
- Indexer, ParsePool, LspPythonClient, Summarizer.
- Watcher.
- Monitoring server and GUI.
- The `FEDERATION_REPOS` env-var interface (the CLI just writes to it).

## Data Flow

### Tool call with explicit scoping

1. Claude calls `search_symbols({ query: "Token", repos: ["auth", "web"] })`.
2. Zod validates the input — `repos` is `string[] | undefined`; both strings pass.
3. The MCP server-handler invokes the tool's function with the pre-built `RepoSet`.
4. `repoSet.filter(["auth", "web"])` — if any name is unknown, the helper throws `ToolError` with a message listing known names. The tool handler catches and returns `{ error: "Unknown repo name: 'web'. Known: [api, auth, frontend]" }`.
5. For each repo in the filtered set, the tool runs its FTS query against `repo.db`, tagging each result with `project: repo.name`.
6. The merged list is deduped via `dedupByKey(results, r => \`${r.project}::${r.name}::${r.kind}\`)` for `search_symbols`. Tool-specific key in every tool file.
7. Final slice is `limit * filteredSet.length` (same pattern as today).

### Tool call without scoping

- Same path as above, but `repoSet.filter(undefined)` returns every repo in the set (primary + all federated).
- Claude sees results from all repos, each tagged with `project`.

### Write/session tool (unchanged)

- `reindex({ target: "src/foo.ts" })` hits the primary DB directly. No `repos` param in the schema. Zod rejects any `repos` field the client sends.

### Server startup

1. `openDatabase(INDEX_PATH)` → primary DB.
2. `openDatabase` per federated repo → federated DBs (read-only).
3. `GlobalRegistry.readCurrent(projectRoot)` resolves the local name.
4. For each federated DB, resolve its name via `GlobalRegistry` (if that path has been registered as a project) or via `assignName(path, existingNames)` (if it's been configured via env var only).
5. Build `RepoSet` and pass to `createMcpServer`.

### CLI: `pindex federate add /path/to/web-app`

1. Resolve current project root via `findProjectRoot(cwd)`.
2. Resolve target project root via `findProjectRoot(targetPath)`; error if target is not a `pindex init`-ed project.
3. Look up target's `name` from registry (already assigned at its `pindex init` time).
4. Ensure target's `name` is unique within the **current** project's federation set; if collision, append `-${shortHash}`.
5. Read `.mcp.json`, append target's path to `env.FEDERATION_REPOS` (colon-separated), write back.
6. Update registry: current project's entry gets `federatedRepos: [...existing, { path, name }]`.
7. Print: `federated 'web-app' (path: /path/to/web-app). Restart the MCP server to pick up the change.`

### CLI: `pindex federate list`

- Reads current project's `federatedRepos` from registry.
- Pretty-prints:
  ```
  Federated repos (in /current/path):
    auth       /home/user/auth
    frontend   /home/user/frontend
    utils-a3f7 /home/user/project-b/utils   (auto-named due to collision with /home/user/project-a/utils)
  ```

### CLI: `pindex federate remove frontend`

- Accepts either a name or a path (prefer name for ergonomics).
- Removes from both `.mcp.json` and registry.
- If the name matches no federated entry → error `No federated repo named 'frontend'. Known: [auth, utils-a3f7]`.

### Migration (1.4.0 → 1.5.0)

- `GlobalRegistry.read()` — if any project entry lacks a `name` field, call `assignName(entry.path, existingNames)` and write back. One-time, idempotent.
- Projects using `FEDERATION_REPOS` as a raw env var without CLI registration: server auto-names on startup using `assignName`. Warning on stderr: `[pindex] federated repo '/some/path' has no persisted name; using auto-generated '<name>'. Run 'pindex federate add /some/path' to persist.`
- No DB migration needed; the change is purely in `registry.json` + in-memory types.

## Error Handling

| Failure | Behaviour |
|---|---|
| Unknown name in `repos` param | `RepoSet.filter()` throws an `Error`; the server-level catch in `createMcpServer` converts it to `{ error: "Unknown repo name: '<x>'. Known: [...]" }`. |
| `FEDERATION_REPOS` points at a path with no index DB | `openDatabase` throws at startup → stderr warning, that entry is dropped from the set, server continues. Existing behaviour. |
| Two federated repos end up with the same auto-name (extremely unlikely with 4-hex path-hash suffix) | Log warning on stderr, extend suffix to 8 hex. A 3rd-order collision is astronomically unlikely and out of scope. |
| `pindex federate add` target is not a `pindex init`-ed project | CLI error: `Target /path has no PindeX index. Run 'pindex init' there first.` Exit code 1. |
| `pindex federate remove` on a name not in the federation list | CLI error: `No federated repo named '<x>'. Known: [...]`. Exit code 1. |
| Client sends `repos: []` (empty array, not undefined) | Treated identically to `undefined`: returns all repos. Rationale: natural user expectation ("no filter = no filter"). |

## Testing

### Unit (`npm test`)

- `tests/federation/repo-set.test.ts` — filter semantics, unknown-name throw, empty-array = all, primary-only case.
- `tests/federation/merge.test.ts` — dedupByKey with duplicates, without, empty input, stable ordering.
- `tests/federation/registry-name.test.ts` — assignName with free name, with collision, with multi-collision forcing suffix extension.
- `tests/cli/federate.test.ts` — add/remove/list against a temp registry + `.mcp.json`; covers unknown-target error, unknown-remove error, list output shape.
- Per-tool tests: each of the 9 federation-aware tools gets three new cases:
  1. "returns results from 2 repos, correctly tagged with `project`"
  2. "filters by `repos` param"
  3. "throws on unknown repo name"
  Existing tests updated to use `RepoSet` helper in place of `db` + `federatedDbs`.
- `tests/cli/project-detector-migration.test.ts` — registry entries without `name` field get auto-named on first read.

### Integration (`npm run test:integration`)

- `tests/integration/federation-e2e.test.ts` — spawns a real MCP server with two temp-indexed repos federated together. Real transport, real Zod validation, real RepoSet. Asserts that `search_symbols` returns tagged results from both repos and that `repos: ["only-one"]` scopes correctly.

### Regression

- All 407-and-counting existing tests keep passing. Tool-level signature changes are source-level only; test helpers are adjusted to construct a `RepoSet` with one entry for the "local-only" case most tests already use.

## Risks

1. **Signature change on 9 tools is high-touch.** Any test that constructs a tool call directly in unit-test code will need a helper update. Mitigation: provide `makeTestRepoSet(db, name?)` in `tests/helpers/` that wraps a single DB in a minimal `RepoSet`.
2. **Migration of in-flight sessions.** Users running 1.4.0 who upgrade mid-session may see one-time auto-naming warnings on stderr. Not a functional problem; the warning message explains the fix.
3. **CLI writes to `.mcp.json`.** The existing `.mcp.json` write path in `init.ts` already handles this; we reuse it. Risk: if the user has hand-edited `.mcp.json`, CLI writes may clobber custom fields. Mitigation: `writeMcpJson` already merges — confirm and add a test if coverage is thin.
4. **Tool-specific dedup keys could be wrong.** For `get_symbol`, returning one entry per repo is intentional (same name can legitimately mean different things in different repos). For `search_symbols`, `${project}::${name}::${kind}` prevents duplicate listings within one repo (FTS can return the same symbol twice if ranked highly on multiple fields); across repos, two repos with a `UserService` class legitimately produce two entries.

## Rollback Plan

If the new `RepoSet` abstraction causes regressions:
- Revert the 9 tool-file signature changes individually; each is an isolated commit.
- Keep `src/federation/*` code; it's standalone and doesn't affect anything if no tool imports it.
- The `FEDERATION_REPOS` env var continues to work as in 1.4.0 (the CLI is additive).
- A single env var (`PINDEX_FEDERATION=legacy`) could fall back to the old branching pattern in `search_symbols` and `get_project_overview` only — but since this is a minor version bump with additive changes, a full rollback is likely not needed.
