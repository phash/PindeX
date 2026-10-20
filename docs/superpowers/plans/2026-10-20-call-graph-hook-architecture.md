# Call Graph, Read Hook & Architecture Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give PindeX real call edges with confidence tags (`find_usages` finally returns data, new `get_call_path` tool), replace the non-functional PreToolUse hook with a working `pindex hook pre-tool-use` command, and add hub symbols + file communities to `get_project_overview`.

**Architecture:** The tree-sitter parser (TS/JS/Vue/Svelte) additionally emits raw call references (`callee name`, `receiver`, `line`, enclosing symbol). They are stored per caller file in a new `symbol_refs` table (schema v6) and resolved to target symbols **at query time** (same-file → import → unique global name), so re-indexing a target file never deletes callers' edges. A pure `call-graph.ts` module builds resolved edges once per tool call and serves `find_usages`, `get_call_path` and the overview hubs/communities. The hook is a fast CLI subcommand that reads Claude Code's stdin JSON, opens the project DB read-only, and returns `additionalContext` (or a one-time `deny` in strict mode).

**Tech Stack:** TypeScript 5.x (ESM/NodeNext), `better-sqlite3`, `tree-sitter-typescript`, Vitest 4 (`pool: 'forks'`), Zod 4. **No new dependencies.**

**Spec:** No separate spec file. Origin: Graphify comparison (session 2026-10-20), items 1–3. Decisions below are the spec.

## Spec (decisions)

- Background findings this plan fixes:
  - `upsertUsage` (`src/db/queries.ts:264`) is only called from tests → `usages` table is empty in production → `find_usages` always returns `[]`.
  - `resolveImportPath` (`src/indexer/index.ts`) does not map NodeNext `./x.js` specifiers to `./x.ts` → TS-ESM projects (incl. PindeX itself) get almost no `dependencies` rows.
  - The installed PreToolUse hook reads `process.env.CLAUDE_TOOL_INPUT_FILE_PATH`, which Claude Code never sets (tool input arrives as JSON on stdin), and writes plain stdout, which is not shown to the model for PreToolUse. It never has any effect.
- Call extraction scope: only languages parsed by tree-sitter (`typescript`, `tsx`, `javascript`, `jsx`, `vue`, `svelte`). Regex languages return `references: []`. No change for them.
- Reference kinds: `call` (`foo()`, `a.b.foo()`) and `new` (`new Foo()`). No plain identifier reads.
- Confidence tags (exact strings): `EXTRACTED` (callee defined in same file, or imported by name from the file that defines it), `INFERRED` (exactly one symbol with that name in the project), `AMBIGUOUS` (several candidates; never used for edges, only reported as count).
- Ambiguous user input (a name matching several symbols without `file`) is refused with a candidate list, never guessed.
- The `usages` table and its query helpers are removed (dead); `symbol_refs` replaces them.
- Hook default = advisory (`additionalContext` with a compact symbol outline). `PINDEX_HOOK_STRICT=1` = deny the first unscoped `Read` per file per session, allow the retry. Hook fails open on every error.
- Communities: deterministic label propagation on the file graph (import edges + resolved call edges, undirected, weighted by edge count). No Leiden/Louvain library.

## State after the review-fix plan (2026-10-20-review-fixes.md, merged first)

- Task 1 below is already done there. `getSymbolByName` is deterministic (`getSymbolsByName` + `normalizeRelPath` exist). Tool output is compact JSON; `find_usages` rows no longer have `context`; `project` is omitted for single-repo in `search_symbols`. `UserInputError` (`src/tools/errors.ts`) is passed through to clients.
- Hooks: SessionStart lives in `.claude/settings.local.json`; helpers in `src/cli/init.ts`. `.mcp.json` writes go through `writeMcpJson` / `src/cli/mcp-json.ts`.
- `Indexer` keeps an in-memory imports map and has `resolveImportersOf(path)`.
- Unit tests run with HOME sandboxed (`tests/setup.ts`).

## Global Constraints

- Node >= 18, ESM, all relative imports end in `.js`.
- No new npm dependencies.
- Schema change = new migration `version: 6` in `src/db/migrations.ts` plus matching `initSchema` DDL; runs in the existing per-migration transaction.
- Every user-supplied path goes through `resolveWithinRoot` (`src/util/paths.ts`); `null` = reject.
- New MCP tool needs all four: entry in `TOOL_DEFINITIONS` (`src/server.ts`), Zod schema in `TOOL_SCHEMAS` (`src/tools/schemas.ts`), dispatch `case` in `src/server.ts` incl. its `heuristicMultiplier` (the old `src/monitoring/estimator.ts` was deleted by the review-fix plan).
- Tool output stays compact: no pretty-printed JSON beyond what `server.ts` already does, list caps documented per tool.
- Hook output format (Claude Code PreToolUse JSON, verify field names against https://code.claude.com/docs/en/hooks before Task 7): `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}`, strict deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`. Exit code 0 in all cases.
- Hook wall time target < 300 ms on a 1k-file index; hard `timeout: 5` in the hook config.
- Docs to update in the task that changes behavior: `CLAUDE.md` (tool table, count "15 tools" → "16 tools", schema notes), `README.md` tool list, `docs/DATENMODELL.md` (schema v6), `CLAUDE_MD_SECTION` in `src/cli/init.ts`.

## Review Focus

1. Re-indexing the file that **defines** a function must not drop the call edges stored for its callers (caller files unchanged). → test in Task 4.
2. Same function name in two files (`format()` in `a.ts` and `b.ts`): edges from a file that imports one of them must point to that one with `EXTRACTED`, never to both. → test in Task 4.
3. Files with a parse error or > `MAX_FILE_SIZE` must not leave stale `symbol_refs` from the previous version. → test in Task 3.
4. Hook called with a non-indexed file, a file outside the project, malformed stdin, or a missing DB must print nothing and exit 0. → tests in Task 7.
5. `get_call_path` on a cyclic graph (`a → b → a`) and on unreachable targets must terminate and return `{ path: null }`. → test in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/indexer/index.ts` | (modify) `.js`→`.ts` import mapping; persist refs in `processParsedFile` |
| `src/indexer/parser.ts` | (modify) `extractReferences(rootNode)`; `ParsedFile.references` |
| `src/types.ts` | (modify) `ParsedReference`, `CallEdge`, tool I/O types |
| `src/db/schema.ts`, `src/db/migrations.ts` | (modify) `symbol_refs` table, drop `usages` |
| `src/db/queries.ts` | (modify) ref insert/delete/read helpers; remove usage helpers |
| `src/graph/call-graph.ts` | (create) pure resolution + edge building + BFS path |
| `src/graph/communities.ts` | (create) label propagation + hub ranking |
| `src/tools/find_usages.ts` | (modify) backed by `call-graph.ts` |
| `src/tools/get_call_path.ts` | (create) new MCP tool |
| `src/tools/get_project_overview.ts` | (modify) `hubs`, `communities` in `full` mode |
| `src/cli/hook.ts` | (create) `runPreToolUseHook(stdin, env)` |
| `src/cli/index.ts`, `src/cli/init.ts` | (modify) `hook` subcommand; new hook config + auto-upgrade of the broken hook |
| `tests/graph/*.test.ts`, `tests/cli/hook.test.ts`, `tests/tools/get_call_path.test.ts` | (create) |

---

### Task 1: Reliable import edges (resolution + integrity)

> **Moved:** implemented as Task 1 of `2026-10-20-review-fixes.md`. Skip here if that plan is merged; only verify its tests exist.

Review 2026-10-20 found three defects that together leave `dependencies` nearly empty: (a) `.js` specifiers never map to `.ts`; (b) `deleteDependenciesByFile` deletes `from_file = ? OR to_file = ?`, so `resolveDependencies` wipes edges into a file it processes later in path order; (c) the watcher re-indexes via `processParsedFile`, which deletes the file's edges, and nothing re-resolves them.

**Files:**
- Modify: `src/indexer/index.ts` (`resolveImportPath`, `resolveDependencies`, `processParsedFile`), `src/db/queries.ts` (`deleteDependenciesByFile`)
- Test: `tests/indexer/indexer.test.ts`, `tests/db/queries.test.ts`

**Interfaces:**
- Produces:
  - `deleteOutgoingDependencies(db, fileId: number): void` — `DELETE … WHERE from_file = ?` only. `deleteDependenciesByFile` stays only for file deletion (cascade covers it → remove if unused afterwards).
  - `Indexer.resolveFileDependencies(relativePath: string, imports: ParsedImport[]): void` — re-resolves one file's outgoing edges; called at the end of `processParsedFile` (single-file path) using a `knownPaths` set from `getAllFiles`.
  - `dependencies` rows for `./x.js` imports pointing at `x.ts` / `x.tsx`. Later tasks rely on this for `EXTRACTED` edges.

- [ ] **Step 1: Write failing tests** in a new `describe('resolveDependencies — import specifiers')` block. Seed files via `insertTestFile`, call `indexer.resolveDependencies(new Map([...]))` with a hand-built imports cache:
  - `src/a.ts` imports `{ source: './b.js', symbols: ['b'] }`, `src/b.ts` exists → one dependency `a → b`, `symbol_name = 'b'`.
  - `src/a.ts` imports `'./c.js'`, `src/c.tsx` exists → dependency `a → c.tsx`.
  - `src/a.ts` imports `'./d.js'` and **both** `src/d.js` and `src/d.ts` exist → resolves to `src/d.js` (exact file wins).
  - `src/a.ts` imports `'./dir'`, `src/dir/index.tsx` exists → dependency.
  - Integrity: `src/a.ts → src/b.ts` and `src/z.ts → src/b.ts` → after `resolveDependencies` **both** edges exist (today only `z → b` survives).
  - Watcher path: after full resolve, `indexer.indexFile('src/b.ts', true)` with changed content → edge `a → b` still exists; `indexFile('src/a.ts', true)` → `a → b` re-created.
- [ ] **Step 2: Run** `npx vitest run tests/indexer/indexer.test.ts -t "import specifiers"` → FAIL on cases 1, 2, 4, integrity, watcher.
- [ ] **Step 3: Implement.** Candidate order in `resolveImportPath`: exact specifier → specifier + `['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']` → if specifier ends in `.js|.jsx|.mjs|.cjs`, swap to `.ts|.tsx|.mts|.cts` → `/index` + `['.ts', '.tsx', '.js', '.jsx']`. Keep the `knownPaths` / `existsSync` dual mode. Replace both `deleteDependenciesByFile` calls with `deleteOutgoingDependencies`. Wrap the `resolveDependencies` loop in one `db.transaction`. Skip document-language files there (no re-parse of md/yaml).
- [ ] **Step 4: Run** same command → PASS; then `npm test` → all green.
- [ ] **Step 5: Commit** `fix(indexer): keep import edges intact and resolve NodeNext .js specifiers`

### Task 2: Extract call references in the parser

**Files:**
- Modify: `src/types.ts` (`ParsedFile`, new `ParsedReference`), `src/indexer/parser.ts`, all regex parsers' return values (add `references: []`), `src/indexer/lsp-mapper.ts` / LSP upgrade path if it constructs `ParsedFile`
- Test: `tests/indexer/real-parse.test.ts` (uses real tree-sitter via `vi.unmock`)

**Interfaces:**
- Produces:
  ```ts
  export interface ParsedReference {
    callee: string;          // 'foo' for foo(), a.foo(), new foo()
    receiver: string | null; // 'this', 'a', 'a.b'; null for bare calls
    kind: 'call' | 'new';
    line: number;            // 1-based
    caller: string | null;   // name of innermost enclosing ParsedSymbol, null at module level
  }
  // ParsedFile gains: references: ParsedReference[]
  export function extractReferences(rootNode: AstNode, symbols: ParsedSymbol[]): ParsedReference[]
  ```

- [ ] **Step 1: Write failing tests** (`describe('extractReferences — real tree-sitter')`), parsing source strings with `parseFile('x.ts', src)`:
  - `function a(){ b(); }` → `[{ callee:'b', receiver:null, kind:'call', line:1, caller:'a' }]`.
  - `class K { m(){ this.n(); } n(){} }` → ref `{ callee:'n', receiver:'this', caller:'m' }`.
  - `const x = new Foo();` at module level → `{ callee:'Foo', kind:'new', caller:null }`.
  - `export const h = () => util.fmt(1);` → `{ callee:'fmt', receiver:'util', caller:'h' }` (requires `h` to be a symbol; if the parser does not yet emit arrow-function consts as symbols, assert `caller: null` and note it).
  - `foo()()` and `arr[0]()` → no crash; callee for non-identifier function nodes is skipped.
  - Python file `def a(): b()` → `references` is `[]`.
- [ ] **Step 2: Run** `npx vitest run tests/indexer/real-parse.test.ts` → FAIL.
- [ ] **Step 3: Implement** `extractReferences`: walk `descendantsOfType(['call_expression', 'new_expression'])`; callee from `function` / `constructor` field: `identifier` → name; `member_expression` → `property` text, `object` text as receiver (truncate receiver to 60 chars); else skip. `caller` = symbol with the smallest `[startLine, endLine]` span containing `line`. Call it from `parseFile` for every tree-sitter branch (incl. Vue/Svelte, lines offset not needed beyond what symbols already use). Dedupe identical `(callee, receiver, line, caller)`.
- [ ] **Step 4: Run** `npx vitest run tests/indexer` and `npm run lint` → PASS (lint catches every `ParsedFile` construction missing `references`).
- [ ] **Step 5: Commit** `feat(parser): extract call/new references with enclosing symbol`

### Task 3: Schema v6 — `symbol_refs`, drop `usages`

**Files:**
- Modify: `src/db/schema.ts`, `src/db/migrations.ts`, `src/db/queries.ts`, `src/indexer/index.ts` (`processParsedFile`), `tests/helpers/fixtures.ts` (replace `insertTestUsage` with `insertTestRef`), `docs/DATENMODELL.md`
- Test: `tests/db/migrations.test.ts`, `tests/db/queries.test.ts`, `tests/indexer/indexer.test.ts`

**Interfaces:**
- Consumes: `ParsedReference` (Task 2).
- Produces (in `queries.ts`):
  ```ts
  export interface SymbolRefRow { id: number; file_id: number; file_path: string; caller_symbol_id: number | null;
    caller_name: string | null; callee_name: string; receiver: string | null; kind: 'call' | 'new'; line: number }
  export function replaceSymbolRefs(db, fileId: number, refs: ParsedReference[], symbolIdByName: Map<string, number>): void
  export function getRefsByCallee(db, calleeName: string, limit?: number): SymbolRefRow[]   // default limit 500
  export function getAllRefs(db): SymbolRefRow[]
  ```
- DDL (exact):
  ```sql
  CREATE TABLE IF NOT EXISTS symbol_refs (
    id               INTEGER PRIMARY KEY,
    file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    caller_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
    callee_name      TEXT NOT NULL,
    receiver         TEXT,
    kind             TEXT NOT NULL,
    line             INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_symbol_refs_callee ON symbol_refs(callee_name);
  CREATE INDEX IF NOT EXISTS idx_symbol_refs_file ON symbol_refs(file_id);
  ```
  Migration 6: create the above, `DROP TABLE IF EXISTS usages`. Remove `usages` DDL + indexes from `initSchema`. Existing projects need a full reindex to fill refs: migration sets nothing; Indexer logs once `"[pindex] schema v6: run 'reindex' to build call graph"` when `symbol_refs` is empty and `files` is not.

- [ ] **Step 1: Write failing tests:**
  - migrations: fresh DB → `user_version = 6`, `symbol_refs` exists, `usages` absent; DB at v5 with a `usages` row → after `runMigrations` `usages` is gone.
  - queries: `replaceSymbolRefs` twice for the same file → only second set remains; `caller_symbol_id` filled via `symbolIdByName`, `null` for module-level refs.
  - indexer (Review Focus 3): index `a.ts` with refs, then rewrite it to content that the (mocked) parser returns with no references → `getAllRefs` has no rows for `a.ts`. Then make `a.ts` exceed `MAX_FILE_SIZE` after it had refs → document expected behavior: file is `skipped`, refs **remain** (unchanged file record) — assert that, so the behavior is explicit.
- [ ] **Step 2: Run** `npx vitest run tests/db tests/indexer/indexer.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In `processParsedFile` transaction: after inserting symbols, build `symbolIdByName` from the inserted rows (first symbol wins per name; for methods prefer the innermost — use the same smallest-span rule by passing names as emitted), then `replaceSymbolRefs`. Delete `upsertUsage`, `getUsagesBySymbol`, `deleteUsagesByFile`, `UsageRecord`, `UpsertUsageInput` and their tests. `find_usages` is temporarily broken → keep its file compiling by returning `[]` with a `// replaced in Task 4` marker removed in Task 4 (same branch, no release in between).
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(db): schema v6 symbol_refs table, drop never-populated usages`

### Task 4: Query-time resolution + `find_usages`

**Files:**
- Create: `src/graph/call-graph.ts`
- Modify: `src/tools/find_usages.ts`, `src/types.ts` (`FindUsagesInput.file?`, `UsageResult`), `src/tools/schemas.ts`, `src/server.ts` (tool description + `file` property)
- Test: `tests/graph/call-graph.test.ts`, `tests/tools/find_usages.test.ts`

**Interfaces:**
- Consumes: `getAllRefs`, `getRefsByCallee` (Task 3), `dependencies` rows (Task 1).
- Produces:
  ```ts
  export type Confidence = 'EXTRACTED' | 'INFERRED';
  export interface SymbolNode { id: number; name: string; kind: string; file: string; line: number }
  export interface CallEdge { from: SymbolNode | null; fromFile: string; to: SymbolNode; line: number; confidence: Confidence }
  export interface ResolveResult { edges: CallEdge[]; ambiguous: number }
  export function resolveRefs(db: Database.Database, refs: SymbolRefRow[]): ResolveResult
  export function buildCallGraph(db: Database.Database): ResolveResult   // resolveRefs(db, getAllRefs(db))
  export function findSymbolCandidates(db: Database.Database, name: string, file?: string): SymbolNode[]
  // UsageResult becomes: { file; line; caller: string | null; confidence: Confidence; project }
  // find_usages ambiguous input returns: { error: 'ambiguous'; candidates: Array<{ file: string; line: number; kind: string }> }
  ```
- Resolution order per ref (first hit wins): (1) symbol named `callee_name` in the ref's own file → `EXTRACTED`; (2) a `dependencies` row `from_file = ref.file_id AND symbol_name = callee_name` whose `to_file` defines it → `EXTRACTED`; (3) exactly one symbol project-wide with that name → `INFERRED`; else `ambiguous++`, no edge. Receiver `this` restricts (1) to methods. Load symbols and dependencies once per call into `Map`s — no per-ref SQL.

- [ ] **Step 1: Write failing tests** (`call-graph.test.ts`, fixtures only, no parser):
  - same-file call → `EXTRACTED`.
  - Review Focus 2: `format` in `a.ts` and `b.ts`, `c.ts` imports `format` from `a.ts` (dependency row with `symbol_name='format'`) → exactly one edge to `a.ts#format`, `EXTRACTED`; `d.ts` calls `format` without import → no edge, `ambiguous === 1`.
  - unique name, no import → `INFERRED`.
  - Review Focus 1: edges exist; delete + re-insert symbols of the **target** file (simulate reindex via `deleteSymbolsByFileId` + `insertTestSymbol`) → `buildCallGraph` still returns the edge.
  - `find_usages`: `{ symbol:'format' }` with two definitions → `{ error:'ambiguous', candidates: [2 entries] }`; `{ symbol:'format', file:'src/a.ts' }` → usages from `c.ts` only. Federation test keeps working (per repo resolution).
- [ ] **Step 2: Run** `npx vitest run tests/graph tests/tools/find_usages.test.ts` → FAIL.
- [ ] **Step 3: Implement** `call-graph.ts` and rewrite `findUsages` on top of `getRefsByCallee` + `resolveRefs`, filtered to edges whose `to.id` is the chosen candidate. `file` goes through `resolveWithinRoot`-style normalization (strip `./`, forward slashes) before lookup. Tool description: `'Call sites of a symbol (EXTRACTED = via import/same file, INFERRED = unique name). Pass file to disambiguate.'`
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(tools): find_usages backed by resolved call graph with confidence tags`

### Task 5: `get_call_path` tool

**Files:**
- Create: `src/tools/get_call_path.ts`
- Modify: `src/graph/call-graph.ts` (add `shortestPath`), `src/server.ts`, `src/tools/schemas.ts`, `src/types.ts`, `CLAUDE.md`, `README.md`, `src/cli/init.ts` (`CLAUDE_MD_SECTION`: add "Wie hängen A und B zusammen? → `get_call_path`")
- Test: `tests/graph/call-graph.test.ts`, `tests/tools/get_call_path.test.ts`, `tests/tools/validation.test.ts`

**Interfaces:**
- Consumes: `buildCallGraph`, `findSymbolCandidates` (Task 4).
- Produces:
  ```ts
  export function shortestPath(edges: CallEdge[], fromId: number, toId: number, maxDepth: number): CallEdge[] | null
  export interface GetCallPathInput { from: string; to: string; from_file?: string; to_file?: string; max_depth?: number } // max_depth default 6, max 12
  export type GetCallPathOutput =
    | { path: Array<{ from: string; to: string; file: string; line: number; confidence: Confidence }> | null; hops: number }
    | { error: 'ambiguous'; side: 'from' | 'to'; candidates: Array<{ file: string; line: number; kind: string }> }
    | { error: 'not_found'; side: 'from' | 'to' };
  ```
- Primary repo only; `repos` param not accepted (document in description). Heuristic multiplier in `src/server.ts`: `15`. Add to `CORE_TOOL_NAMES`.
- Path search: directed BFS over `from.id → to.id`; module-level edges (`from === null`) are not traversable starting points.

- [ ] **Step 1: Write failing tests:**
  - `a → b → c` → `hops: 2`, steps in order with file + line.
  - Review Focus 5: `a → b → a`, query `a → z` (z exists, unreachable) → `{ path: null, hops: 0 }`, test finishes.
  - `max_depth: 1` on a 2-hop path → `path: null`.
  - ambiguous `from` → `{ error:'ambiguous', side:'from' }`; unknown `to` → `{ error:'not_found', side:'to' }`.
  - validation: `max_depth: 13` rejected by Zod; missing `to` rejected.
- [ ] **Step 2: Run** `npx vitest run tests/graph tests/tools/get_call_path.test.ts tests/tools/validation.test.ts` → FAIL.
- [ ] **Step 3: Implement** tool + registration (all four places from Global Constraints). Description: `'Shortest call chain from symbol A to symbol B (max_depth default 6). Edges tagged EXTRACTED/INFERRED.'`
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build` → PASS. Update CLAUDE.md tool table + count (16), README tool list.
- [ ] **Step 5: Commit** `feat(tools): add get_call_path for shortest call chain between symbols`

### Task 6: Hubs + communities in `get_project_overview`

**Files:**
- Create: `src/graph/communities.ts`
- Modify: `src/tools/get_project_overview.ts`, `src/types.ts` (`ProjectOverviewSnapshot.hubs?`, `.communities?`), `src/server.ts` (description)
- Test: `tests/graph/communities.test.ts`, `tests/tools/get_project_overview.test.ts`

**Interfaces:**
- Consumes: `buildCallGraph` (Task 4), `dependencies` table.
- Produces:
  ```ts
  export interface Hub { symbol: string; file: string; callerFiles: number }
  export interface Community { id: number; label: string; size: number; topFiles: string[] }
  export function rankHubs(edges: CallEdge[], limit: number): Hub[]          // by distinct fromFile, ties by symbol name asc
  export function detectCommunities(files: string[], weightedEdges: Array<[string, string, number]>, maxIter?: number): Map<string, number>
  export function summarizeCommunities(assignment: Map<string, number>, degree: Map<string, number>, limit: number): Community[]
  ```
- Label propagation (deterministic): every file starts with its own label (index in path-sorted order); iterate files in path-sorted order; adopt the neighbor label with the highest summed weight, ties → smallest label; stop when no change or `maxIter` (default 20). Isolated files are dropped from the output. `label` = longest common directory prefix of members, fallback = top file basename. Caps: `hubs` 10, `communities` 8, `topFiles` 3 (by degree). Only in `mode: 'full'`; omitted in `brief`; omitted when the project has no edges.

- [ ] **Step 1: Write failing tests:**
  - `rankHubs`: symbol called from 3 files beats one called 5× from 1 file.
  - `detectCommunities`: two triangles `{a,b,c}`, `{x,y,z}` joined by one weight-1 edge → exactly 2 communities; run twice → identical `Map` (determinism).
  - `summarizeCommunities`: members `src/db/a.ts`, `src/db/b.ts` → `label: 'src/db'`.
  - overview: `mode:'brief'` has no `hubs`/`communities`; `mode:'full'` on a fixture with edges has both, `hubs.length <= 10`.
- [ ] **Step 2: Run** `npx vitest run tests/graph tests/tools/get_project_overview.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Weighted file edges = `dependencies` (weight 1 per distinct pair) + resolved call edges aggregated by `(fromFile, to.file)` excluding self-loops.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(overview): add hub symbols and file communities to full overview`

### Task 7: Working PreToolUse hook

**Files:**
- Create: `src/cli/hook.ts`
- Modify: `src/cli/index.ts` (`case 'hook'`, help text), `src/cli/init.ts` (`PINDEX_HOOKS`, `injectClaudeSettings`), `.claude/settings.json` of this repo is **not** committed (per CLAUDE.md), `CLAUDE.md` (env var `PINDEX_HOOK_STRICT`)
- Test: `tests/cli/hook.test.ts`, `tests/cli/init.test.ts`

**Interfaces:**
- Consumes: `findProjectRoot`, `getProjectIndexPath` (`src/cli/project-detector.ts`), `hashContent` (`src/indexer/parser.ts`), `resolveWithinRoot`.
- Produces:
  ```ts
  export interface HookIO { stdin: string; env: NodeJS.ProcessEnv; stateDir: string }  // stateDir default join(getPindexHome(), 'hook-state')
  export function runPreToolUseHook(io: HookIO): string   // returns stdout text ('' = say nothing)
  ```
- Behavior (in order, any exception → return `''`):
  1. Parse stdin JSON `{ session_id, cwd, tool_name, tool_input: { file_path, offset?, limit? } }`. `tool_name !== 'Read'` → `''`.
  2. `offset` or `limit` present → `''` (targeted read is fine).
  3. Project root = `findProjectRoot(cwd)`; `rel` = path relative to root; `resolveWithinRoot(root, rel)` null → `''`.
  4. Open `getProjectIndexPath(root)` with `{ readonly: true, fileMustExist: true }`; file row missing or language is a document language → `''`.
  5. Freshness: `hashContent(readFileSync(abs))` must equal `files.hash`; else `''` (stale index must not mislead).
  6. Outline = `"[PindeX] <rel> (<n> lines est.) symbols: name(kind)@start-end, …"` — max 40 symbols, then `"… +N more"`; followed by `"Use get_context(file, line) or Read with offset/limit for the part you need."`
  7. Default → advisory JSON with `additionalContext`. `PINDEX_HOOK_STRICT=1` → if `stateDir/<session_id>.json` does not list `rel`: add it, return deny JSON with the outline as `permissionDecisionReason`; else advisory.
- New hook config in `init.ts`: `matcher: 'Read'`, command built like the existing SessionStart entry (`sessionStartEntry()` / `nodeScriptCommand('cli/index.js')`): `'"<process.execPath>" "<absolute path to dist/cli/index.js>" hook pre-tool-use'`, `timeout: 5`. Because it contains machine-specific absolute paths it goes into **`.claude/settings.local.json`** (same rule the review-fix plan applied to SessionStart); the old pindex-marked PreToolUse entry is removed from the shared `.claude/settings.json`. Use the existing parsed-marker helpers (`isPindexEntry`, `withPindexHook`, compute-both-then-write). Tests assert the command contains `hook pre-tool-use` and starts with a quoted absolute path. `injectClaudeSettings` replaces an existing pindex entry **without** `--force` when its command contains `CLAUDE_TOOL_INPUT_FILE_PATH` (auto-upgrade of the broken hook) and returns `'added'`.

- [ ] **Step 1: Write failing tests** (`hook.test.ts`; temp project dir + `createTestDb`-style DB written to a temp `PINDEX_HOME`):
  - indexed fresh `src/a.ts`, full Read → output parses as JSON, `hookSpecificOutput.additionalContext` contains `src/a.ts` and a symbol name.
  - `offset: 10` → `''`.
  - Review Focus 4: file not indexed → `''`; `file_path` outside root (`/etc/passwd`) → `''`; stdin `'not json'` → `''`; DB missing → `''`; `tool_name: 'Grep'` → `''`.
  - file changed after indexing (hash mismatch) → `''`.
  - strict: first call → `permissionDecision: 'deny'`; second call same session + file → advisory; other session → deny again.
  - `init.test.ts`: settings containing the old `CLAUDE_TOOL_INPUT_FILE_PATH` hook → `injectClaudeSettings(root)` returns `'added'` and the new command ends with `hook pre-tool-use`; current hook present → `'skipped'`.
- [ ] **Step 2: Run** `npx vitest run tests/cli/hook.test.ts tests/cli/init.test.ts` → FAIL.
- [ ] **Step 3: Implement** `hook.ts`; in `index.ts` `case 'hook'`: read all stdin, `process.stdout.write(runPreToolUseHook(...))`, `process.exit(0)` always.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`, then manual check: `echo '{"session_id":"s","cwd":"'(pwd)'","tool_name":"Read","tool_input":{"file_path":"'(pwd)'/src/server.ts"}}' | node dist/cli/index.js hook pre-tool-use` → JSON with outline of `src/server.ts` (requires an indexed PindeX DB). Measure: `time` < 300 ms.
- [ ] **Step 5: Commit** `fix(cli): replace no-op PreToolUse hook with stdin-driven pindex hook command`

---

## Final verification

- [ ] `npm run lint && npm test && npm run build && npm run test:integration` all green.
- [ ] Reindex PindeX itself (`node dist/cli/index.js` in repo, or `reindex` tool), then via MCP: `find_usages {symbol:'resolveWithinRoot'}` returns ≥ 5 call sites with `EXTRACTED`; `get_call_path {from:'createMcpServer', to:'searchSymbols'}` returns a path; `get_project_overview` shows `hubs` and ≥ 2 `communities`.
- [ ] Optional: `npm run bench:realism -- --tasks-limit 3` before/after, record token delta in the PR description.
