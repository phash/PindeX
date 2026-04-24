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
// When running from dist/ (production), both files live in dist/indexer/.
// When vitest imports the source directly, __dirname is src/indexer/; in that
// case we walk up two levels (to project root) and back down into dist/.
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_URL = __dirname.endsWith('/src/indexer') || __dirname.endsWith('\\src\\indexer')
  ? resolve(__dirname, '../../dist/indexer/parse-worker.js')
  : resolve(__dirname, 'parse-worker.js');

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
