# Parallel Indexing — Design Spec

**Date:** 2026-04-23
**Status:** Approved for implementation planning
**Target area:** `src/indexer/`

## Problem

`Indexer.indexAll()` iterates all discovered code files with a synchronous `for`/`await` loop (`src/indexer/index.ts:146-152`). Each iteration does a read, a tree-sitter parse, optional summarizer HTTP calls, and a SQLite transaction. Because every step awaits the previous one, a multi-core machine runs parse work on a single core. On a 10k-file monorepo this dominates initial-index latency.

A second bug compounds the cost: `resolveDependencies()` (`src/indexer/index.ts:347`) **re-reads and re-parses every file** a second time, solely to extract imports and resolve them. The parsed imports from the first pass are discarded.

## Goals

- Saturate available CPU cores for the parse step of `indexAll()`.
- Eliminate the double-parse in `resolveDependencies()` by reusing parsed imports from the first pass.
- Keep the single-file `indexFile(path)` entry point API-compatible so the file watcher works unchanged.
- No regression in correctness: each file's DB update remains its own atomic transaction.
- Remain testable without relying on real worker threads in the unit suite.

## Non-Goals

- Batched multi-file transactions (would change atomicity guarantees — out of scope).
- Progress reporting / UI.
- Worker pools for summarizer / dependency resolution (neither is CPU-bound).
- Dynamic pool sizing.
- Sharing a pool across multiple `Indexer` instances.

## Architecture

```
Main thread (single-threaded, owns DB + summarizer)
  indexAll()
    ├─ glob discovery                        (unchanged)
    ├─ ParsePool.parseMany(paths)  ─┐        (NEW)
    │                                │ structured-clone messages
    │                                ▼
    │                         Worker 1..N
    │                         ┌───────────────────────────┐
    │                         │ readFile → parseFile →    │
    │                         │ hash → ParsedFileResult   │
    │                         └───────────────────────────┘
    │                                │
    ◄───── AsyncGenerator yields ParsedFileResult as each worker finishes
    │
    ├─ for each ParsedFileResult on main:
    │   - hash check vs existing DB row
    │   - optional summarizer call (async, has internal semaphore)
    │   - computeAstDiff (needs DB)
    │   - db.transaction(upsert symbols/deps/...)
    │   - stash parsed.imports in Map<relPath, ParsedImport[]>
    │
    └─ resolveDependencies(importsCache)     (MODIFIED — no re-read)
```

**Invariant:** workers never touch the DB, the summarizer, the filesystem outside of `readFile`, or any process-global state. Their only job is `path → ParsedFileResult`.

## Components

### New: `src/indexer/parse-worker.ts`

Worker script loaded via `new Worker(new URL('./parse-worker.js', import.meta.url))` (note: the compiled `.js` path — `tsc` emits next to source structure in `dist/`).

Responsibilities:
- Import `tree-sitter` + `tree-sitter-typescript` once per worker (module-level singleton).
- Reuse a single `Parser` instance across jobs.
- For each message `{ jobId, absolutePath, relativePath }`:
  1. `statSync` size check (> `MAX_FILE_SIZE` → `{ status: 'skipped' }`).
  2. `readFileSync(absolutePath, 'utf-8')` (errors → `{ status: 'error', error }`).
  3. `parseFile(absolutePath, content)` (wraps tree-sitter + regex fallbacks).
  4. `hashContent(content)`.
  5. `parentPort.postMessage({ jobId, status: 'ok', parsed, hash, content })`.

**Why include `content` in the result:** the main thread needs it for summarizer calls and for slicing symbol snippets. Sending it back avoids a second disk read on main. Cost: one structured-clone per file (O(filesize)) — acceptable given `MAX_FILE_SIZE = 1 MB`.

### New: `src/indexer/parse-pool.ts`

Class `ParsePool`:

```ts
export interface ParsePoolOptions {
  maxWorkers: number;       // 0 = sync fallback, no workers spawned
  maxFileSize?: number;
}

export interface ParseJobInput {
  absolutePath: string;
  relativePath: string;
}

export type ParseJobResult =
  | { status: 'ok'; relativePath: string; parsed: ParsedFile; hash: string; content: string }
  | { status: 'skipped'; relativePath: string; reason: 'too_large' | 'read_error' }
  | { status: 'error'; relativePath: string; error: string };

export class ParsePool {
  constructor(options: ParsePoolOptions);
  parseMany(jobs: ParseJobInput[]): AsyncGenerator<ParseJobResult>;
  close(): Promise<void>;
}
```

Internal design:
- On construction with `maxWorkers > 0`: spawn `maxWorkers` `Worker` instances, each runs `parse-worker.js`. Keep a queue of idle workers and a queue of pending jobs.
- `parseMany` returns an `AsyncGenerator` so the main thread can start consuming results *as soon as the first worker finishes* rather than waiting for all parses.
- Job dispatch: FIFO queue. When a worker finishes a job, it pulls the next job from the pending queue.
- Worker crash (`exit` with non-zero code while a job was in flight): the job is put back onto the pending queue once. A replacement worker is spawned so the pool stays at `maxWorkers`. If the same job fails a second time (either by throwing inside `parseFile` or by crashing the replacement worker), the pool yields `{ status: 'error' }` for that job and stops retrying it.
- `maxWorkers === 0` mode: `parseMany` runs `parseFile` synchronously in the current thread and yields each result. This is the test path — no `worker_threads` import is reached, so vitest mocks of `tree-sitter` still apply.
- `close()`: awaits all in-flight jobs to settle, then `.terminate()`s each worker and resolves.

### New: `tests/indexer/parse-pool.test.ts`

Unit tests:
- `maxWorkers: 0` path handles a batch of synthetic jobs correctly (smoke test against the existing `tree-sitter` mock).
- Ordering: results may arrive out of order, but every input job produces exactly one result.
- Error path: a job whose file doesn't exist yields `{ status: 'error' }` without stopping subsequent jobs.
- `close()` completes cleanly after all jobs drain.

A separate **integration test** (in `tests/integration/parse-pool-workers.test.ts`, excluded from default coverage) spawns a real worker with `maxWorkers: 1` against a tiny real TS file to validate the worker script itself parses. This file bypasses the global `tree-sitter` mock with `vi.unmock`.

### Modified: `src/indexer/index.ts`

New instance field:
```ts
private readonly pool: ParsePool;
```

`IndexerOptions` adds:
```ts
maxParseWorkers?: number;   // defaults to os.cpus().length - 1, min 1; 0 = sync
```

`indexAll()` change (sketch):
```ts
const jobs = allCodePaths.map((rel) => ({
  absolutePath: join(this.projectRoot, rel),
  relativePath: rel,
}));
const importsCache = new Map<string, ParsedImport[]>();

for await (const parseResult of this.pool.parseMany(jobs)) {
  if (parseResult.status !== 'ok') {
    if (parseResult.status === 'error') result.errors.push(`…`);
    if (parseResult.status === 'skipped') result.skipped++;
    continue;
  }
  const fileResult = await this.processParsedFile(parseResult, options.force);
  // tallies + importsCache.set(rel, parsed.imports)
}

await this.resolveDependencies(importsCache);
```

`processParsedFile()` is a new private method that takes an already-parsed result and runs the existing hash-check → summarizer → transaction logic. It is essentially the second half of today's `indexFile()`, extracted.

`indexFile(relativePath, force)` becomes a thin adapter: submits one job to the pool, awaits one result, delegates to `processParsedFile`. API-compatible with today's callers (watcher, `reindex` MCP tool).

`resolveDependencies()` new signature:
```ts
async resolveDependencies(importsCache?: Map<string, ParsedImport[]>): Promise<void>;
```
- If `importsCache` is provided (the fast path from `indexAll`), it is used directly — **no file reads, no parsing**.
- If omitted (backwards compatibility for any external caller), it falls back to the current read-and-re-parse behavior so existing tests still pass. A deprecation comment notes the slow path.

Document indexing (`indexDocument`) remains sequential — it's not CPU-heavy (no tree-sitter), and documents are typically few.

### Modified: `src/indexer/watcher.ts`

**No code changes required.** The watcher calls `indexer.indexFile(relPath)`. That now routes through the pool with a single job. The per-call overhead (message serialization + worker hop) is ~1–3 ms, which is negligible compared to file parse time. Code path stays unified.

### Modified: `src/index.ts` (server entry)

`cleanup()` (around line 123) adds `await indexer.closePool()` before `db.close()` so workers terminate cleanly on `SIGTERM`/`SIGINT`.

New env var: `PINDEX_PARSE_WORKERS` → parsed into `maxParseWorkers`. Unset or invalid → default (`os.cpus().length - 1`, min 1).

## Data Flow (one `indexAll` call)

1. `indexAll()` globs both code and document paths.
2. For code paths only: build `ParseJobInput[]` and call `pool.parseMany(jobs)`.
3. For each `ParseJobResult` yielded:
   - `status === 'ok'` → run `processParsedFile`:
     - Look up existing row; if hash matches and not forced, `skipped++`, continue.
     - If `generateSummaries`, await summarizer calls (serialized on main thread, internally semaphored at concurrency 3).
     - Open a DB transaction: `upsertFile`, re-fetch to get id, `computeAstDiff`, delete old symbols/deps, insert new ones.
     - Push `parsed.imports` into `importsCache`.
   - `status === 'skipped'` / `'error'` → tally and continue.
4. Document paths: existing sequential loop unchanged.
5. `resolveDependencies(importsCache)` loops `importsCache`, resolves each import to a known file id (`pathIndex`), writes `dependencies` rows. No file IO.

## Testing Strategy

- **Default unit suite runs with `maxParseWorkers: 0`** (sync mode). Achieved via:
  - `Indexer` constructor detects `process.env.VITEST === 'true'` and clamps `maxParseWorkers` to 0 unless the test explicitly overrides.
  - Existing indexer tests keep passing unchanged.
- **New pool tests** cover the pool's own mechanics (queue, errors, close) in sync mode.
- **Worker-thread integration test** (opt-in, tagged with `// @vitest-environment node` + `vi.unmock('tree-sitter')`): spawns one real worker against a real TS fixture file and asserts the `parsed` payload shape.
- **Benchmark script** `scripts/bench-index.mjs` (not part of CI) generates a synthetic 1000-file TS project in `/tmp`, runs `indexAll()` once baseline-style and once with workers, logs wall-time delta.

## Error Handling

| Failure | Behavior |
|---|---|
| Worker process exits unexpectedly | Job retried once; on second failure → `{ status: 'error' }`. Pool spawns a replacement. |
| `readFile` throws (ENOENT, permission) | Worker yields `{ status: 'error' }`. Main tallies `result.errors`. |
| `parseFile` throws inside the worker | Caught in the worker, yielded as `{ status: 'error' }`. |
| File > `MAX_FILE_SIZE` | Worker yields `{ status: 'skipped', reason: 'too_large' }`. |
| `SIGTERM` / `SIGINT` during `indexAll` | `closePool()` terminates workers immediately. In-flight jobs are abandoned. The process exits next; no partial DB writes because transactions are per-file and synchronous on main. |

## Performance Target

Acceptance criterion: On a 1000-file synthetic TS project on an 8-core laptop, `indexAll()` plus `resolveDependencies()` completes in **≤ 40 %** of the current baseline wall-time (approx 3× speedup or better). Benchmark script prints the ratio; number is recorded in the PR description, not asserted in CI (machine-variance).

## Open Risks

- **Worker startup cost**: spawning N workers has a ~50–100 ms fixed cost. On very small projects (< 30 files) the overhead could exceed the gain. Mitigation lives in the `Indexer`, not the pool: before `indexAll()` constructs a `ParsePool`, it picks an effective worker count based on `jobs.length` — `0` (sync) for `< 10` jobs, `1` for `< maxParseWorkers * 2`, otherwise the configured maximum. The pool itself does not change shape after construction. Thresholds are tunable during implementation.
- **`tree-sitter-typescript` load time in worker**: same grammar already loaded on main. Each worker pays it again. Acceptable one-time cost (~20 ms per worker).
- **Memory**: each worker holds its own `tree-sitter-typescript` grammar in memory. 8 workers ≈ 8× the grammar footprint. Grammar is small (~10 MB class), total worst case ~80 MB — acceptable.
- **Windows**: `worker_threads` works on Windows identically. File paths must be passed as absolute so path normalization is consistent. Already the case.

## Rollback Plan

If the worker approach causes regressions, setting `PINDEX_PARSE_WORKERS=0` disables the pool entirely and the code runs synchronously on main — identical to today's behavior modulo the `resolveDependencies` fix (which is kept either way).
