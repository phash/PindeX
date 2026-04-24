import { describe, it, expect, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

  it('ParsePool with maxWorkers=2 processes a batch of files', async () => {
    // Import from dist/ so the module resolves WORKER_URL relative to the compiled
    // location, matching how the worker itself is loaded in the first test. The
    // test:integration script builds dist/ before running.
    const distUrl = pathToFileURL(resolve(process.cwd(), 'dist/indexer/parse-pool.js'));
    const { ParsePool } = (await import(distUrl.href)) as typeof import('../../src/indexer/parse-pool.js');
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
});
