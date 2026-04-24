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
    // Worker-backed path arrives in Task 4.
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
