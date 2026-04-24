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

  it('returns skipped for a missing file without stopping subsequent jobs', async () => {
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
