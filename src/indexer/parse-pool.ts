import { readFile, stat } from 'node:fs/promises';
import { cpus } from 'node:os';
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
    // Drain the pending queue: every waiting job gets a terminal result so the
    // AsyncGenerator in parseMany can exit instead of hanging.
    const cancelResult = (job: ParseJobInput): ParseJobResult => ({
      status: 'error',
      relativePath: job.relativePath,
      error: 'ParsePool closed',
    });
    for (const p of this.pending) {
      p.resolve(cancelResult(p.job));
    }
    this.pending = [];
    // Resolve any in-flight jobs BEFORE terminate, so the generator notifies
    // and wakes before we tear down the workers.
    for (const [, p] of this.workerJobs) {
      p.resolve(cancelResult(p.job));
    }
    this.workerJobs.clear();
    await Promise.all(this.workers.map((w) => w.terminate().then(() => undefined)));
    this.workers = [];
    this.idleWorkers = [];
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private spawnWorker(): void {
    const worker = new Worker(WORKER_URL);
    worker.on('message', (msg: { result: ParseJobResult }) => {
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
        job: pending.job,
        maxFileSize: this.maxFileSize,
      });
    }
  }

  /** Picks a default worker count based on the host CPU count and an env
   *  override. Capped to leave at least one CPU for the main thread. Forces
   *  0 (sync fallback) when VITEST is running, so the global tree-sitter
   *  mock in tests/setup.ts continues to apply. */
  static pickDefaultWorkerCount(explicit: number | undefined): number {
    if (explicit !== undefined) return Math.max(0, explicit);
    const fromEnv = process.env.PINDEX_PARSE_WORKERS;
    if (fromEnv !== undefined && fromEnv !== '') {
      const n = parseInt(fromEnv, 10);
      if (!Number.isNaN(n) && n >= 0) return n;
    }
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

  private async runJobSync(job: ParseJobInput): Promise<ParseJobResult> {
    try {
      const st = await stat(job.absolutePath);
      if (st.size > this.maxFileSize) {
        return { status: 'skipped', relativePath: job.relativePath, reason: 'too_large' };
      }
    } catch (err) {
      process.stderr.write(`[pindex] ParsePool: stat failed for ${job.relativePath}: ${String(err)}\n`);
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
