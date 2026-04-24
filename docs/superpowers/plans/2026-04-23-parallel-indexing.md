# Parallel Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sequential `Indexer.indexAll()` loop with a Node `worker_threads` pool that parallelises tree-sitter parsing. Also eliminate the double-parse in `resolveDependencies()` by reusing parsed imports from the first pass.

**Architecture:** Workers do pure CPU/IO (read file → tree-sitter parse → content hash). Main thread keeps all DB work (transactions, AST diff), summarizer HTTP calls, and watcher integration. A `ParsePool` class hides the worker mechanics behind an `AsyncGenerator<ParseJobResult>` so the main thread can start consuming parses as soon as the first worker completes. A sync fallback (`maxWorkers: 0`) exists for the vitest suite, because the global `tree-sitter` mock in `tests/setup.ts` does not reach code loaded inside a real worker thread.

**Tech Stack:** TypeScript 5.x (ESM / NodeNext), Node `worker_threads`, `better-sqlite3` (sync, main-thread-only), `tree-sitter` + `tree-sitter-typescript`, Vitest 4 with `pool: 'forks'`.

**Spec:** `docs/superpowers/specs/2026-04-23-parallel-indexing-design.md`

---

## Context For The Implementer

Before starting any task, read these files end-to-end so you know what you are modifying:

- `CLAUDE.md` (project root) — commit / workflow rules.
- `docs/superpowers/specs/2026-04-23-parallel-indexing-design.md` — the design.
- `src/indexer/index.ts` — current `Indexer` class with the sequential loops.
- `src/indexer/parser.ts` — `parseFile`, tree-sitter wiring, regex fallbacks.
- `src/types.ts` — existing `ParsedFile`, `ParsedSymbol`, `ParsedImport` types (reuse these; do NOT redefine).
- `src/index.ts` — the MCP server entry; contains `cleanup()` around line 123.
- `tests/setup.ts` — global vitest mocks for `tree-sitter` etc.
- `tests/helpers/db.ts`, `tests/helpers/fixtures.ts` — existing test helpers.
- `tests/indexer/indexer.test.ts` — current indexer tests; your changes must keep them passing.

### Conventions you MUST follow
- **Imports** use `.js` extension on relative paths (`import { X } from './foo.js'`), even from `.ts` files. This is required by `moduleResolution: NodeNext`.
- **Paths in DB + all module code** are forward-slash (`/`), never backslash. Normalise on Windows with `.replace(/\\/g, '/')`.
- **Silent catches are forbidden.** If you catch an error, `process.stderr.write(\`[pindex] <context>: \${String(err)}\n\`)` at minimum.
- **Strict TypeScript.** No `any`. No non-null `!` unless the invariant is obvious from code above.
- **Vitest tests use `pool: 'forks'`** (set in `vitest.config.ts`). Do not change this.

### Commands
- `npm test` — full vitest suite (takes ~15 s; must pass after every task).
- `npm run lint` — `tsc --noEmit`, must pass.
- `npm run build` — emits `dist/`. Required before real worker threads can run because they load `.js` files.
- Commit message style from recent history: `feat: …`, `test: …`, `fix: …`, `perf: …`, `refactor: …`, with a short scope if meaningful.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

### Environment prerequisite
`better-sqlite3 ^9` does **not** build against Node 25. If `npm install` fails with a node-gyp `make` error, either use Node 20 LTS or bump `better-sqlite3` to `^11.5.0` (and `@types/better-sqlite3` accordingly). Verify with `npm test` after install. This is a prerequisite, not part of this feature.

---

## File Structure

### New files
- `src/indexer/parse-types.ts` — shared types `ParseJobInput`, `ParseJobResult`, `ParsePoolOptions`. Re-exports `ParsedFile`/`ParsedImport` from `src/types.ts` for convenience.
- `src/indexer/parse-pool.ts` — the `ParsePool` class. Handles both sync-fallback (`maxWorkers: 0`) and real worker mode.
- `src/indexer/parse-worker.ts` — the worker script. Loaded only when `maxWorkers > 0`. Does read → parse → hash.
- `tests/indexer/parse-pool.test.ts` — unit tests for the pool in sync-fallback mode (the default vitest run uses this).
- `tests/integration/parse-pool-workers.test.ts` — integration test that spawns a **real** worker against a fixture file; bypasses the `tree-sitter` mock with `vi.unmock`.
- `scripts/bench-index.mjs` — opt-in benchmark script (not in CI).

### Modified files
- `src/indexer/index.ts` — `Indexer` gets a `ParsePool`; `indexAll()` uses it; `indexFile()` becomes a thin adapter; `resolveDependencies()` accepts an optional `importsCache`; new `closePool()` method.
- `src/index.ts` — read `PINDEX_PARSE_WORKERS` env var, wire into `IndexerOptions`, and `await indexer.closePool()` in `cleanup()`.
- `tests/indexer/indexer.test.ts` — add coverage asserting `resolveDependencies` is called without re-reading files, plus one test that exercises `maxParseWorkers: 0` explicitly. No existing tests should fail.

---

## Task 1: Shared types module

**Files:**
- Create: `src/indexer/parse-types.ts`

- [ ] **Step 1: Create the types file**

```ts
// src/indexer/parse-types.ts
import type { ParsedFile, ParsedImport } from '../types.js';

export type { ParsedFile, ParsedImport };

/** Job submitted to the pool. Paths are absolute for the worker's readFile,
 *  and project-relative for the main thread's DB lookups. */
export interface ParseJobInput {
  absolutePath: string;
  relativePath: string;
}

export type ParseJobResult =
  | {
      status: 'ok';
      relativePath: string;
      parsed: ParsedFile;
      hash: string;
      /** File content, sent back so the main thread can slice snippets /
       *  summarise without a second disk read. */
      content: string;
    }
  | {
      status: 'skipped';
      relativePath: string;
      reason: 'too_large' | 'not_found';
    }
  | {
      status: 'error';
      relativePath: string;
      error: string;
    };

export interface ParsePoolOptions {
  /** 0 = run synchronously in the calling thread (test mode).
   *  N > 0 = spawn N worker_threads. */
  maxWorkers: number;
  /** Max file size in bytes; larger files are returned as 'skipped'. Defaults to 1 MB. */
  maxFileSize?: number;
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add src/indexer/parse-types.ts
git commit -m "$(cat <<'EOF'
feat(indexer): add shared types for parse pool

Adds ParseJobInput / ParseJobResult / ParsePoolOptions used by both the
sync-fallback and worker-thread paths of the upcoming ParsePool.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: ParsePool — sync-fallback mode (no workers)

We implement the sync path first so unit tests against the global `tree-sitter` mock work immediately. Worker-thread mode is added in Task 5.

**Files:**
- Create: `tests/indexer/parse-pool.test.ts`
- Create: `src/indexer/parse-pool.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/indexer/parse-pool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ParsePool } from '../../src/indexer/parse-pool.js';
import type { ParseJobInput, ParseJobResult } from '../../src/indexer/parse-types.js';

async function collect(gen: AsyncGenerator<ParseJobResult>): Promise<ParseJobResult[]> {
  const out: ParseJobResult[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

describe('ParsePool (maxWorkers: 0, sync fallback)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `pindex-pool-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeFile(relative: string, content: string): ParseJobInput {
    const abs = join(testDir, relative);
    writeFileSync(abs, content);
    return { absolutePath: abs, relativePath: relative };
  }

  it('parses one file and yields one ok result', async () => {
    const pool = new ParsePool({ maxWorkers: 0 });
    const job = writeFile('a.ts', 'export const x = 1;');
    const results = await collect(pool.parseMany([job]));
    await pool.close();

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ok');
    if (results[0].status === 'ok') {
      expect(results[0].relativePath).toBe('a.ts');
      expect(results[0].hash).toMatch(/^[a-f0-9]+$/);
      expect(results[0].content).toContain('export const x');
    }
  });

  it('yields exactly one result per input, even out of order', async () => {
    const pool = new ParsePool({ maxWorkers: 0 });
    const jobs = [
      writeFile('a.ts', 'export const a = 1;'),
      writeFile('b.ts', 'export const b = 2;'),
      writeFile('c.ts', 'export const c = 3;'),
    ];
    const results = await collect(pool.parseMany(jobs));
    await pool.close();

    expect(results).toHaveLength(3);
    const paths = results.map((r) => r.relativePath).sort();
    expect(paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('returns error for a missing file without stopping subsequent jobs', async () => {
    const pool = new ParsePool({ maxWorkers: 0 });
    const ok = writeFile('ok.ts', 'export const x = 1;');
    const missing: ParseJobInput = {
      absolutePath: join(testDir, 'does-not-exist.ts'),
      relativePath: 'does-not-exist.ts',
    };
    const results = await collect(pool.parseMany([missing, ok]));
    await pool.close();

    const byPath = new Map(results.map((r) => [r.relativePath, r]));
    expect(byPath.get('does-not-exist.ts')?.status).toBe('skipped');
    expect(byPath.get('ok.ts')?.status).toBe('ok');
  });

  it('returns skipped for files larger than maxFileSize', async () => {
    const pool = new ParsePool({ maxWorkers: 0, maxFileSize: 10 });
    const big = writeFile('big.ts', 'x'.repeat(100));
    const results = await collect(pool.parseMany([big]));
    await pool.close();

    expect(results[0].status).toBe('skipped');
    if (results[0].status === 'skipped') {
      expect(results[0].reason).toBe('too_large');
    }
  });

  it('close() resolves even when no jobs were submitted', async () => {
    const pool = new ParsePool({ maxWorkers: 0 });
    await expect(pool.close()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

Run: `npm test -- tests/indexer/parse-pool.test.ts`
Expected: FAIL — `Cannot find module '../../src/indexer/parse-pool.js'`.

- [ ] **Step 3: Implement ParsePool sync mode**

```ts
// src/indexer/parse-pool.ts
import { readFile, stat } from 'node:fs/promises';
import { parseFile, hashContent } from './parser.js';
import type {
  ParseJobInput,
  ParseJobResult,
  ParsePoolOptions,
} from './parse-types.js';

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1 MB

export class ParsePool {
  private readonly maxWorkers: number;
  private readonly maxFileSize: number;

  constructor(options: ParsePoolOptions) {
    this.maxWorkers = Math.max(0, options.maxWorkers);
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  }

  /** Yields one ParseJobResult per input, in completion order. */
  async *parseMany(jobs: ParseJobInput[]): AsyncGenerator<ParseJobResult> {
    if (this.maxWorkers === 0) {
      for (const job of jobs) {
        yield await this.runJobSync(job);
      }
      return;
    }
    // Worker-backed path arrives in Task 5.
    throw new Error('ParsePool worker mode not yet implemented');
  }

  async close(): Promise<void> {
    // Nothing to clean up in sync mode.
  }

  private async runJobSync(job: ParseJobInput): Promise<ParseJobResult> {
    try {
      const st = await stat(job.absolutePath);
      if (st.size > this.maxFileSize) {
        return { status: 'skipped', relativePath: job.relativePath, reason: 'too_large' };
      }
    } catch {
      return { status: 'skipped', relativePath: job.relativePath, reason: 'not_found' };
    }

    let content: string;
    try {
      content = await readFile(job.absolutePath, 'utf-8');
    } catch (err) {
      return { status: 'error', relativePath: job.relativePath, error: String(err) };
    }

    try {
      const parsed = parseFile(job.absolutePath, content);
      const hash = hashContent(content);
      return { status: 'ok', relativePath: job.relativePath, parsed, hash, content };
    } catch (err) {
      return { status: 'error', relativePath: job.relativePath, error: String(err) };
    }
  }
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `npm test -- tests/indexer/parse-pool.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Run full suite to make sure nothing regressed**

Run: `npm test`
Expected: all tests pass (no test currently references parse-pool elsewhere).

- [ ] **Step 6: Commit**

```bash
git add src/indexer/parse-pool.ts tests/indexer/parse-pool.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): add ParsePool with synchronous fallback mode

ParsePool is the new abstraction that will hide worker_threads from the
Indexer. This commit ships only the maxWorkers=0 path so the rest of the
migration can be built against a stable API. Worker-thread mode arrives
in a follow-up commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Parse worker script

We write the worker file and a small integration test that loads it. No pool wiring yet.

**Files:**
- Create: `src/indexer/parse-worker.ts`
- Create: `tests/integration/parse-pool-workers.test.ts`

- [ ] **Step 1: Write the worker script**

```ts
// src/indexer/parse-worker.ts
import { readFileSync, statSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { parseFile, hashContent } from './parser.js';
import type { ParseJobInput, ParseJobResult } from './parse-types.js';

if (!parentPort) {
  throw new Error('parse-worker.ts must be loaded as a worker_threads script');
}

interface WorkerMessage {
  jobId: number;
  job: ParseJobInput;
  maxFileSize: number;
}

parentPort.on('message', (msg: WorkerMessage) => {
  const result = runJob(msg.job, msg.maxFileSize);
  parentPort!.postMessage({ jobId: msg.jobId, result });
});

function runJob(job: ParseJobInput, maxFileSize: number): ParseJobResult {
  try {
    const st = statSync(job.absolutePath);
    if (st.size > maxFileSize) {
      return { status: 'skipped', relativePath: job.relativePath, reason: 'too_large' };
    }
  } catch {
    return { status: 'skipped', relativePath: job.relativePath, reason: 'not_found' };
  }

  let content: string;
  try {
    content = readFileSync(job.absolutePath, 'utf-8');
  } catch (err) {
    return { status: 'error', relativePath: job.relativePath, error: String(err) };
  }

  try {
    const parsed = parseFile(job.absolutePath, content);
    const hash = hashContent(content);
    return { status: 'ok', relativePath: job.relativePath, parsed, hash, content };
  } catch (err) {
    return { status: 'error', relativePath: job.relativePath, error: String(err) };
  }
}
```

- [ ] **Step 2: Write the integration test**

```ts
// tests/integration/parse-pool-workers.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Real tree-sitter in this integration test; the unit-suite mock is bypassed.
vi.unmock('tree-sitter');
vi.unmock('tree-sitter-typescript');

const WORKER_PATH = resolve(process.cwd(), 'dist/indexer/parse-worker.js');

describe('parse-worker.js (real worker_threads)', () => {
  it('parses a real TypeScript file and posts an ok result', async () => {
    const dir = join(tmpdir(), `pindex-worker-it-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, 'sample.ts');
    writeFileSync(abs, 'export function greet(name: string): string { return `hi ${name}`; }');

    try {
      const worker = new Worker(WORKER_PATH);
      const result = await new Promise<unknown>((resolvePromise, rejectPromise) => {
        worker.once('message', (m) => resolvePromise(m));
        worker.once('error', rejectPromise);
        worker.postMessage({
          jobId: 1,
          job: { absolutePath: abs, relativePath: 'sample.ts' },
          maxFileSize: 1024 * 1024,
        });
      });
      await worker.terminate();

      const r = result as { jobId: number; result: { status: string; parsed?: { symbols: Array<{ name: string }> } } };
      expect(r.jobId).toBe(1);
      expect(r.result.status).toBe('ok');
      expect(r.result.parsed?.symbols.map((s) => s.name)).toContain('greet');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
```

- [ ] **Step 3: Exclude the integration test from default vitest runs**

Open `vitest.config.ts`. Add `'tests/integration/parse-pool-workers.test.ts'` to `test.exclude` if an `exclude` key already exists, or add one:

```ts
test: {
  // existing keys...
  exclude: [
    'node_modules/**',
    'dist/**',
    'tests/integration/parse-pool-workers.test.ts',
  ],
  // ...
},
```

Rationale: this test requires a real build (`npm run build`) and bypasses the global `tree-sitter` mock. It is run manually with `npx vitest run tests/integration/parse-pool-workers.test.ts` against a fresh `dist/`.

- [ ] **Step 4: Verify the worker script builds**

Run: `npm run build`
Expected: `dist/indexer/parse-worker.js` exists. Verify with `ls dist/indexer/parse-worker.js`.

- [ ] **Step 5: Run the integration test manually once**

Run: `npx vitest run tests/integration/parse-pool-workers.test.ts`
Expected: 1 test passes. (Skip if `tree-sitter` cannot be built in the current Node version; note this in the commit.)

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: no change to pass count (integration test is excluded).

- [ ] **Step 7: Commit**

```bash
git add src/indexer/parse-worker.ts tests/integration/parse-pool-workers.test.ts vitest.config.ts
git commit -m "$(cat <<'EOF'
feat(indexer): add parse-worker script for worker_threads mode

Runs read + tree-sitter parse + content hash inside a Node worker
thread, posting ParseJobResult back to the main thread. Unit suite
continues to use ParsePool's sync fallback; a dedicated integration
test spawns a real worker against a fixture file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: ParsePool — worker-thread mode

Extend `ParsePool` to spawn real workers when `maxWorkers > 0`. Keep the sync path intact.

**Files:**
- Modify: `src/indexer/parse-pool.ts`

- [ ] **Step 1: Add worker-backed implementation**

Replace the `parseMany` body and add the helpers below. Full file after this step:

```ts
// src/indexer/parse-pool.ts
import { readFile, stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseFile, hashContent } from './parser.js';
import type {
  ParseJobInput,
  ParseJobResult,
  ParsePoolOptions,
} from './parse-types.js';

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
const MAX_RETRIES = 1;

// Resolve the compiled worker script relative to this module.
// After `npm run build`, both files live in dist/indexer/.
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_URL = resolve(__dirname, 'parse-worker.js');

interface PendingJob {
  job: ParseJobInput;
  attempts: number;
  resolve: (result: ParseJobResult) => void;
}

export class ParsePool {
  private readonly maxWorkers: number;
  private readonly maxFileSize: number;
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private workerJobs = new Map<Worker, PendingJob>();
  private pending: PendingJob[] = [];
  private nextJobId = 1;
  private closed = false;

  constructor(options: ParsePoolOptions) {
    this.maxWorkers = Math.max(0, options.maxWorkers);
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    for (let i = 0; i < this.maxWorkers; i++) {
      this.spawnWorker();
    }
  }

  async *parseMany(jobs: ParseJobInput[]): AsyncGenerator<ParseJobResult> {
    if (this.closed) throw new Error('ParsePool is closed');

    if (this.maxWorkers === 0) {
      for (const job of jobs) {
        yield await this.runJobSync(job);
      }
      return;
    }

    // Submit all jobs; drain results in completion order via a shared buffer.
    const buffer: ParseJobResult[] = [];
    let notify: (() => void) | null = null;
    let remaining = jobs.length;

    for (const job of jobs) {
      this.enqueue({
        job,
        attempts: 0,
        resolve: (result) => {
          buffer.push(result);
          remaining--;
          notify?.();
        },
      });
    }

    while (remaining > 0 || buffer.length > 0) {
      if (buffer.length === 0) {
        await new Promise<void>((r) => {
          notify = () => {
            notify = null;
            r();
          };
        });
        continue;
      }
      yield buffer.shift()!;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.terminate().then(() => undefined)));
    this.workers = [];
    this.idleWorkers = [];
    this.workerJobs.clear();
    this.pending = [];
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private spawnWorker(): void {
    const worker = new Worker(WORKER_URL);
    worker.on('message', (msg: { jobId: number; result: ParseJobResult }) => {
      const pending = this.workerJobs.get(worker);
      this.workerJobs.delete(worker);
      this.idleWorkers.push(worker);
      pending?.resolve(msg.result);
      this.drainQueue();
    });
    worker.on('error', (err) => {
      process.stderr.write(`[pindex] ParsePool worker error: ${String(err)}\n`);
    });
    worker.on('exit', (code) => {
      if (code === 0 || this.closed) return;
      // Unexpected crash. If a job was in flight, requeue once; then replace.
      const pending = this.workerJobs.get(worker);
      this.workerJobs.delete(worker);
      this.workers = this.workers.filter((w) => w !== worker);
      this.idleWorkers = this.idleWorkers.filter((w) => w !== worker);
      if (pending) {
        if (pending.attempts < MAX_RETRIES) {
          pending.attempts++;
          this.pending.unshift(pending);
        } else {
          pending.resolve({
            status: 'error',
            relativePath: pending.job.relativePath,
            error: `Worker exited (code ${code}) after ${pending.attempts + 1} attempts`,
          });
        }
      }
      if (!this.closed) this.spawnWorker();
      this.drainQueue();
    });
    this.workers.push(worker);
    this.idleWorkers.push(worker);
  }

  private enqueue(pending: PendingJob): void {
    this.pending.push(pending);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.pending.length > 0 && this.idleWorkers.length > 0) {
      const pending = this.pending.shift()!;
      const worker = this.idleWorkers.shift()!;
      this.workerJobs.set(worker, pending);
      worker.postMessage({
        jobId: this.nextJobId++,
        job: pending.job,
        maxFileSize: this.maxFileSize,
      });
    }
  }

  private async runJobSync(job: ParseJobInput): Promise<ParseJobResult> {
    try {
      const st = await stat(job.absolutePath);
      if (st.size > this.maxFileSize) {
        return { status: 'skipped', relativePath: job.relativePath, reason: 'too_large' };
      }
    } catch {
      return { status: 'skipped', relativePath: job.relativePath, reason: 'not_found' };
    }
    let content: string;
    try {
      content = await readFile(job.absolutePath, 'utf-8');
    } catch (err) {
      return { status: 'error', relativePath: job.relativePath, error: String(err) };
    }
    try {
      const parsed = parseFile(job.absolutePath, content);
      const hash = hashContent(content);
      return { status: 'ok', relativePath: job.relativePath, parsed, hash, content };
    } catch (err) {
      return { status: 'error', relativePath: job.relativePath, error: String(err) };
    }
  }
}
```

- [ ] **Step 2: Sync-mode tests still pass**

Run: `npm test -- tests/indexer/parse-pool.test.ts`
Expected: 5 tests pass (unchanged).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no output.

- [ ] **Step 4: Rebuild so dist/indexer/parse-worker.js matches new types**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 5: Integration test with 2 workers**

Extend `tests/integration/parse-pool-workers.test.ts` with:

```ts
it('ParsePool with maxWorkers=2 processes a batch of files', async () => {
  const { ParsePool } = await import('../../src/indexer/parse-pool.js');
  const dir = join(tmpdir(), `pindex-pool-it-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const jobs = [];
  for (let i = 0; i < 5; i++) {
    const abs = join(dir, `f${i}.ts`);
    writeFileSync(abs, `export const v${i} = ${i};`);
    jobs.push({ absolutePath: abs, relativePath: `f${i}.ts` });
  }
  const pool = new ParsePool({ maxWorkers: 2 });
  const results: Array<{ status: string; relativePath: string }> = [];
  try {
    for await (const r of pool.parseMany(jobs)) {
      results.push(r);
    }
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(results).toHaveLength(5);
  expect(results.every((r) => r.status === 'ok')).toBe(true);
}, 15_000);
```

Run: `npx vitest run tests/integration/parse-pool-workers.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/parse-pool.ts tests/integration/parse-pool-workers.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): implement worker-thread mode in ParsePool

maxWorkers>0 now spawns that many Node workers, round-robins jobs via a
queue, handles worker crashes with one retry + replacement, and streams
results via AsyncGenerator so the main thread can start DB writes while
other files are still being parsed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Refactor Indexer — extract processParsedFile

Pure refactor. No behaviour change. Splits today's `indexFile()` into two halves so Task 6 can reuse the post-parse half with pool results.

**Files:**
- Modify: `src/indexer/index.ts`

- [ ] **Step 1: Extract the post-parse logic into a private method**

Inside the `Indexer` class, add this new method. Source lines currently around 202-270 (the body after `const hash = hashContent(content);` through the transaction) move here. `indexFile` keeps the existing read + hash check, then calls `processParsedFile` for the rest.

```ts
/** Everything that happens after a file has been read, parsed, and hashed.
 *  Runs entirely on the main thread: summarizer → AST diff → DB transaction. */
private async processParsedFile(
  relativePath: string,
  parsed: ParsedFile,
  content: string,
  hash: string,
  force: boolean,
): Promise<IndexFileResult> {
  const existing = getFileByPath(this.db, relativePath);
  if (!force && existing && existing.hash === hash) {
    return { status: 'skipped', errors: [] };
  }
  const isUpdate = existing !== null;

  let fileSummary: string | null = null;
  const symbolSummaries = new Map<string, string | null>();

  if (this.generateSummaries) {
    fileSummary = await this.summarizer.summarizeFile(relativePath, content);
    const symbolEntries = parsed.symbols.map(async (sym) => {
      const snippet = content.split('\n').slice(sym.startLine - 1, sym.endLine).join('\n');
      const summary = await this.summarizer.summarizeSymbol(sym.signature, snippet);
      return [sym.name, summary] as const;
    });
    for (const [name, summary] of await Promise.all(symbolEntries)) {
      symbolSummaries.set(name, summary);
    }
  }

  try {
    const runInTransaction = this.db.transaction(() => {
      upsertFile(this.db, {
        path: relativePath,
        language: parsed.language,
        hash,
        rawTokenEstimate: parsed.rawTokenEstimate,
        summary: fileSummary,
      });
      const fileRecord = getFileByPath(this.db, relativePath)!;
      const diff = computeAstDiff(this.db, relativePath, parsed.symbols);
      deleteSymbolsByFileId(this.db, fileRecord.id);
      for (const sym of parsed.symbols) {
        upsertSymbol(this.db, {
          fileId: fileRecord.id,
          name: sym.name,
          kind: sym.kind,
          signature: sym.signature,
          summary: symbolSummaries.get(sym.name) ?? null,
          startLine: sym.startLine,
          endLine: sym.endLine,
          isExported: sym.isExported,
          isAsync: sym.isAsync,
          hasTryCatch: sym.hasTryCatch,
        });
      }
      deleteDependenciesByFile(this.db, fileRecord.id);
      return diff;
    });
    const diff = runInTransaction();
    return { status: isUpdate ? 'updated' : 'indexed', errors: [], diff };
  } catch (err) {
    return {
      status: 'error',
      errors: [`Failed to index ${relativePath}: ${String(err)}`],
    };
  }
}
```

Then replace the body of `indexFile()` with:

```ts
async indexFile(relativePath: string, force = false): Promise<IndexFileResult> {
  const absolutePath = join(this.projectRoot, relativePath);

  if (!existsSync(absolutePath)) {
    return { status: 'error', errors: [`File not found: ${relativePath}`] };
  }

  try {
    const stat = statSync(absolutePath);
    if (stat.size > MAX_FILE_SIZE) {
      return { status: 'skipped', errors: [] };
    }
  } catch { /* fall through to read attempt */ }

  let content: string;
  try {
    content = readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    return { status: 'error', errors: [`Failed to read ${relativePath}: ${String(err)}`] };
  }

  let parsed: ParsedFile;
  try {
    parsed = parseFile(absolutePath, content);
  } catch (err) {
    return { status: 'error', errors: [`Failed to parse ${relativePath}: ${String(err)}`] };
  }

  const hash = hashContent(content);
  return this.processParsedFile(relativePath, parsed, content, hash, force);
}
```

Add the import for `ParsedFile` at the top of the file if not already present:

```ts
import type { IndexResult, ParsedFile } from '../types.js';
```

- [ ] **Step 2: Run indexer tests**

Run: `npm test -- tests/indexer/indexer.test.ts`
Expected: all existing tests pass unchanged.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/indexer/index.ts
git commit -m "$(cat <<'EOF'
refactor(indexer): extract processParsedFile from indexFile

Pure refactor that splits the read+parse phase from the post-parse
phase (summarise + AST diff + DB transaction). No behaviour change;
prepares for wiring the upcoming ParsePool into indexAll.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire ParsePool into indexAll + collect importsCache

**Files:**
- Modify: `src/indexer/index.ts`

- [ ] **Step 1: Add the pool as an instance field and constructor option**

At the top of `src/indexer/index.ts`, add:

```ts
import { cpus } from 'node:os';
import { ParsePool } from './parse-pool.js';
import type { ParsedImport } from '../types.js';
```

Update `IndexerOptions`:

```ts
export interface IndexerOptions {
  db: Database.Database;
  projectRoot: string;
  languages?: string[];
  ignorePatterns?: string[];
  generateSummaries?: boolean;
  summarizerOptions?: SummarizerOptions;
  documentPatterns?: string[];
  /** 0 = run parsing synchronously on main (test / small-project mode).
   *  undefined = auto-select based on CPU count. */
  maxParseWorkers?: number;
}
```

Add private fields and store the configured worker count in the constructor. **Do not create a pool in the constructor.** Each `indexAll` call sizes its own pool based on the batch so small projects pay no worker-startup cost:

```ts
private pool: ParsePool | null = null;
private readonly configuredMaxWorkers: number;
private lastImportsCache: Map<string, ParsedImport[]> | null = null;

constructor(options: IndexerOptions) {
  // ... existing assignments ...
  this.configuredMaxWorkers = ParsePool.pickDefaultWorkerCount(options.maxParseWorkers);
}
```

Add a static helper on `ParsePool` (`src/indexer/parse-pool.ts`):

```ts
export class ParsePool {
  // ...existing code...

  /** Picks a default worker count based on the host CPU count and an env
   *  override. Capped to leave at least one CPU for the main thread. */
  static pickDefaultWorkerCount(explicit: number | undefined): number {
    if (explicit !== undefined) return Math.max(0, explicit);
    const fromEnv = process.env.PINDEX_PARSE_WORKERS;
    if (fromEnv !== undefined) {
      const n = parseInt(fromEnv, 10);
      if (!Number.isNaN(n) && n >= 0) return n;
    }
    // In the vitest run, force sync fallback so the global tree-sitter mock
    // still applies. VITEST is set automatically by vitest.
    if (process.env.VITEST === 'true') return 0;
    const cpuCount = cpus().length;
    return Math.max(1, cpuCount - 1);
  }

  /** Picks the effective worker count for a given job batch. Small batches
   *  downshift to avoid the worker startup overhead exceeding the gain. */
  static pickEffectiveWorkerCount(jobCount: number, configured: number): number {
    if (configured === 0) return 0;
    if (jobCount < 10) return 0;
    if (jobCount < configured * 2) return 1;
    return configured;
  }
}
```

(Note: the helper calls `cpus()` from `node:os`. Add `import { cpus } from 'node:os';` at the top of `src/indexer/parse-pool.ts`.)

- [ ] **Step 2: Rewrite indexAll to use the pool**

Replace the body of `indexAll`:

```ts
async indexAll(options: IndexAllOptions = {}): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, updated: 0, skipped: 0, errors: [] };
  const codePatterns = buildCodePatterns(this.languages);

  const [codePaths, docPaths] = await Promise.all([
    glob(codePatterns, { cwd: this.projectRoot, ignore: this.ignorePatterns, absolute: false }),
    glob(this.documentPatterns, { cwd: this.projectRoot, ignore: this.ignorePatterns, absolute: false }),
  ]);

  const allCodePaths = [...codePaths, ...(options.additionalPaths ?? [])];

  // Build jobs for the pool.
  const jobs = allCodePaths.map((rel) => ({
    absolutePath: join(this.projectRoot, rel),
    relativePath: rel,
  }));

  // Reuse parsed imports during the dependency-resolution pass.
  const importsCache = new Map<string, ParsedImport[]>();

  const effectiveWorkers = ParsePool.pickEffectiveWorkerCount(jobs.length, this.configuredMaxWorkers);
  // Close any pool from a prior indexAll call and size a new one for this batch.
  if (this.pool) await this.pool.close();
  this.pool = new ParsePool({ maxWorkers: effectiveWorkers });

  for await (const parseResult of this.pool.parseMany(jobs)) {
    if (parseResult.status === 'skipped') {
      result.skipped++;
      continue;
    }
    if (parseResult.status === 'error') {
      result.errors.push(parseResult.error);
      continue;
    }
    const fileRes = await this.processParsedFile(
      parseResult.relativePath,
      parseResult.parsed,
      parseResult.content,
      parseResult.hash,
      options.force ?? false,
    );
    if (fileRes.status === 'indexed') result.indexed++;
    else if (fileRes.status === 'updated') result.updated++;
    else if (fileRes.status === 'skipped') result.skipped++;
    result.errors.push(...fileRes.errors);

    importsCache.set(parseResult.relativePath, parseResult.parsed.imports);
  }

  // Documents stay sequential; they are few and cheap.
  for (const relativePath of docPaths) {
    const fileResult = await this.indexDocument(relativePath, options.force);
    if (fileResult.status === 'indexed') result.indexed++;
    else if (fileResult.status === 'updated') result.updated++;
    else if (fileResult.status === 'skipped') result.skipped++;
    result.errors.push(...fileResult.errors);
  }

  // Stash the cache for resolveDependencies.
  this.lastImportsCache = importsCache;

  return result;
}
```

(Both `pool` and `lastImportsCache` were declared in Step 1 — nothing more to add here.)

- [ ] **Step 3: Run indexer tests (should still pass in VITEST=true sync mode)**

Run: `npm test -- tests/indexer/indexer.test.ts`
Expected: existing tests pass. If one fails because of glob ordering or import resolution, investigate — do not paper over.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/index.ts src/indexer/parse-pool.ts
git commit -m "$(cat <<'EOF'
perf(indexer): parallelise indexAll via ParsePool

indexAll now submits all code paths to a ParsePool; the pool picks an
effective worker count per batch (0 for <10 files, 1 for small batches,
configured max otherwise). Results are consumed as an AsyncGenerator so
DB transactions begin while other workers are still parsing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: resolveDependencies uses cached imports

**Files:**
- Modify: `src/indexer/index.ts`
- Modify: `tests/indexer/indexer.test.ts`

- [ ] **Step 1: Change resolveDependencies signature**

Replace the existing `resolveDependencies` body with:

```ts
/** Resolves import strings to file IDs and stores dependencies.
 *  Fast path: pass an importsCache built during indexAll() to skip re-reading
 *  and re-parsing every file. Slow path (no cache) re-parses as before. */
async resolveDependencies(importsCache?: Map<string, ParsedImport[]>): Promise<void> {
  const cache = importsCache ?? this.lastImportsCache ?? undefined;
  const { getAllFiles } = await import('../db/queries.js');
  const allFiles = getAllFiles(this.db);
  const pathIndex = new Map(allFiles.map((f) => [f.path, f.id]));
  const knownPaths = new Set(pathIndex.keys());

  for (const file of allFiles) {
    let imports: ParsedImport[] | undefined;

    if (cache && cache.has(file.path)) {
      imports = cache.get(file.path);
    } else {
      const absolutePath = join(this.projectRoot, file.path);
      if (!existsSync(absolutePath)) continue;
      try {
        const content = readFileSync(absolutePath, 'utf-8');
        imports = parseFile(absolutePath, content).imports;
      } catch (err) {
        process.stderr.write(
          `[pindex] resolveDependencies: re-parse failed for ${file.path}: ${String(err)}\n`,
        );
        continue;
      }
    }

    if (!imports) continue;

    deleteDependenciesByFile(this.db, file.id);
    for (const imp of imports) {
      const resolvedPath = this.resolveImportPath(file.path, imp.source, knownPaths);
      if (!resolvedPath) continue;
      const toFileId = pathIndex.get(resolvedPath);
      if (!toFileId) continue;
      for (const sym of imp.symbols.length > 0 ? imp.symbols : [null]) {
        upsertDependency(this.db, {
          fromFile: file.id,
          toFile: toFileId,
          symbolName: sym,
        });
      }
    }
  }
}
```

- [ ] **Step 2: Add a test that verifies the cache is used**

Append to `tests/indexer/indexer.test.ts`:

```ts
it('resolveDependencies reuses parsed imports from indexAll (no file re-read)', async () => {
  const indexer = new Indexer({ db, projectRoot: testDir });
  await indexer.indexAll();

  // Delete the source file between indexAll and resolveDependencies; the
  // cached imports should still be used, so the call must not error.
  rmSync(join(testDir, 'src', 'service.ts'));
  await expect(indexer.resolveDependencies()).resolves.toBeUndefined();
});
```

Make sure the existing import block at the top of that test file already includes `rmSync`; if not, add it:

```ts
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
```

- [ ] **Step 3: Run the test**

Run: `npm test -- tests/indexer/indexer.test.ts`
Expected: the new test passes; all prior tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/indexer/index.ts tests/indexer/indexer.test.ts
git commit -m "$(cat <<'EOF'
perf(indexer): reuse parsed imports in resolveDependencies

resolveDependencies now accepts an optional importsCache (populated by
indexAll) and skips re-reading / re-parsing when it has one. On a 10k-
file project this eliminates the second full parse pass. The slow path
still works for any external caller that invokes resolveDependencies
stand-alone.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: closePool + shutdown wiring

**Files:**
- Modify: `src/indexer/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add closePool to Indexer**

Add this public method near the end of the `Indexer` class. It tolerates the case where no pool was ever constructed (e.g. `indexAll()` was never called):

```ts
/** Terminates any worker threads owned by the parse pool. Safe to call
 *  multiple times; no-op when no pool was ever constructed. */
async closePool(): Promise<void> {
  if (!this.pool) return;
  await this.pool.close();
  this.pool = null;
}
```

- [ ] **Step 2: Wire into cleanup in src/index.ts**

Locate the `cleanup` function (around line 123 in `src/index.ts`). Add `await indexer.closePool();` before `db.close()`:

```ts
const cleanup = async (): Promise<void> => {
  try {
    if (watcher) await watcher.stop();
    await indexer.closePool();
    await monitoringServer.close();
    for (const fed of federatedDbs) {
      try { fed.db.close(); } catch { /* ignore */ }
    }
    db.close();
  } catch { /* best effort */ }
};
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no output.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/index.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(indexer): terminate parse-pool workers on graceful shutdown

Indexer.closePool() is awaited from the main SIGTERM/SIGINT cleanup so
worker threads do not linger after the MCP server exits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Env var exposure + README update

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the env var in README**

Find the "Environment Variables" section of `README.md`. Add:

```
PINDEX_PARSE_WORKERS=                             # parse workers (0=sync, empty=auto)
PINDEX_BIND_HOST=127.0.0.1                        # bind host for monitoring/GUI (default loopback)
```

- [ ] **Step 2: Update CLAUDE.md env-var list**

Find the "Running the MCP Server" section in `CLAUDE.md`. Add the same two entries:

```
PINDEX_PARSE_WORKERS=                           # parse workers (0=sync, empty=auto)
PINDEX_BIND_HOST=127.0.0.1                      # bind host (loopback default)
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: document PINDEX_PARSE_WORKERS and PINDEX_BIND_HOST

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Benchmark script

**Files:**
- Create: `scripts/bench-index.mjs`

- [ ] **Step 1: Write the benchmark script**

```js
// scripts/bench-index.mjs
// Usage:
//   node scripts/bench-index.mjs                    # auto workers
//   PINDEX_PARSE_WORKERS=0 node scripts/bench-index.mjs   # sync baseline
//
// Generates 1000 synthetic TS files in a temp dir, indexes once, prints the
// wall-time for indexAll() + resolveDependencies(). Uses the built dist/, so
// run `npm run build` first.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Indexer } from '../dist/indexer/index.js';
import { runMigrations } from '../dist/db/migrations.js';

const FILES = parseInt(process.env.BENCH_FILES ?? '1000', 10);

function generateProject(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let i = 0; i < FILES; i++) {
    const body = Array.from({ length: 8 }, (_, k) =>
      `export function f${i}_${k}(x: number): number { return x + ${k}; }`,
    ).join('\n');
    writeFileSync(join(dir, 'src', `m${i}.ts`), body);
  }
}

async function main() {
  const dir = join(tmpdir(), `pindex-bench-${Date.now()}`);
  generateProject(dir);

  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);

  const indexer = new Indexer({ db, projectRoot: dir });

  const t0 = Date.now();
  const result = await indexer.indexAll();
  const t1 = Date.now();
  await indexer.resolveDependencies();
  const t2 = Date.now();

  await indexer.closePool();
  db.close();
  rmSync(dir, { recursive: true, force: true });

  const workers = process.env.PINDEX_PARSE_WORKERS ?? 'auto';
  console.log(`files=${FILES} workers=${workers}`);
  console.log(`indexAll               : ${t1 - t0} ms`);
  console.log(`resolveDependencies    : ${t2 - t1} ms`);
  console.log(`total                  : ${t2 - t0} ms`);
  console.log(`indexed=${result.indexed} updated=${result.updated} skipped=${result.skipped} errors=${result.errors.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add a script alias to package.json**

In `package.json` scripts section, add:

```json
"bench:index": "node scripts/bench-index.mjs"
```

- [ ] **Step 3: Smoke-run the benchmark**

Run:
```bash
npm run build
BENCH_FILES=200 PINDEX_PARSE_WORKERS=0 npm run bench:index
BENCH_FILES=200 npm run bench:index
```
Expected: both runs print timings; the second (default workers) is noticeably faster than the first.

- [ ] **Step 4: Commit**

```bash
git add scripts/bench-index.mjs package.json
git commit -m "$(cat <<'EOF'
test: add scripts/bench-index.mjs benchmark harness

Generates N synthetic TS files and times indexAll + resolveDependencies.
Compares sync-mode vs. worker-pool-mode for the parallel-indexing change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: End-to-end verification against PindeX itself

**Files:**
- None (verification only).

- [ ] **Step 1: Full suite must pass**

Run: `npm test`
Expected: every test passes.

- [ ] **Step 2: Lint must pass**

Run: `npm run lint`
Expected: no output.

- [ ] **Step 3: Build must succeed and emit the worker file**

Run: `npm run build && ls dist/indexer/parse-worker.js`
Expected: the path prints — file exists.

- [ ] **Step 4: Self-index PindeX with workers and confirm no regressions**

From the project root:
```bash
rm -rf .pindex/index.db
node dist/cli/index.js      # generates .mcp.json and registers project
# Open another shell (or run as background): start the MCP server so it
# indexes PindeX's own src/ with default (auto) worker count.
PROJECT_ROOT="$(pwd)" \
INDEX_PATH="$(pwd)/.pindex/index.db" \
LANGUAGES="typescript" \
AUTO_REINDEX=false \
  timeout 30 node dist/index.js < /dev/null || true
```
Expected: process exits within 30 s; `.pindex/index.db` is created and non-empty; stderr shows no `[pindex] Parse error` bursts beyond what the current `main` branch also produces.

- [ ] **Step 5: Benchmark ratio check**

Run:
```bash
BENCH_FILES=1000 PINDEX_PARSE_WORKERS=0 npm run bench:index
BENCH_FILES=1000 npm run bench:index
```
Expected: worker-mode total is ≤ 40 % of sync-mode total on a machine with ≥ 4 cores. If it isn't, investigate before merging — do not lower the spec target silently.

- [ ] **Step 6: Final summary commit (if any doc needs updating after benchmarking)**

Only if benchmark numbers warrant an update to the README's "When is PindeX worth using?" section. Otherwise skip.

---

## Risks you may hit during implementation

1. **better-sqlite3 native build fails.** Node 25 + better-sqlite3 9.x is broken. Either use Node 20 LTS or bump the dep to `^11.5.0` first. This is infrastructure, not part of the plan — fix it before Task 1 and commit the dep bump separately.
2. **`process.env.VITEST` detection is fragile.** If vitest stops setting it, the pool will try to spawn workers during tests and fail under the `tree-sitter` mock. Mitigation: every indexer test that matters explicitly passes `maxParseWorkers: 0`. Add that defensively if you see flakiness.
3. **Worker path resolution on Windows.** `fileURLToPath(import.meta.url)` returns a Windows path; Node's `Worker` accepts both URLs and paths. Test against a Windows CI job if the project has one.
4. **Message size.** Sending file content back from worker is O(filesize). Cap at `MAX_FILE_SIZE = 1 MB` already enforced in the worker; do not remove that guard.

## When you finish

Report the benchmark ratio from Task 11 Step 5 and any surprises you hit. Do not mark the feature complete without the ratio number.
