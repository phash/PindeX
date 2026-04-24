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

// ─── Static helpers ────────────────────────────────────────────────────────

describe('ParsePool.pickDefaultWorkerCount', () => {
  const ORIG_PINDEX = process.env.PINDEX_PARSE_WORKERS;
  const ORIG_VITEST = process.env.VITEST;

  afterEach(() => {
    if (ORIG_PINDEX === undefined) delete process.env.PINDEX_PARSE_WORKERS;
    else process.env.PINDEX_PARSE_WORKERS = ORIG_PINDEX;
    if (ORIG_VITEST === undefined) delete process.env.VITEST;
    else process.env.VITEST = ORIG_VITEST;
  });

  it('honors an explicit numeric argument', () => {
    expect(ParsePool.pickDefaultWorkerCount(4)).toBe(4);
    expect(ParsePool.pickDefaultWorkerCount(0)).toBe(0);
  });

  it('clamps negative explicit values to 0', () => {
    expect(ParsePool.pickDefaultWorkerCount(-3)).toBe(0);
  });

  it('honors PINDEX_PARSE_WORKERS when explicit is undefined', () => {
    process.env.PINDEX_PARSE_WORKERS = '6';
    expect(ParsePool.pickDefaultWorkerCount(undefined)).toBe(6);
  });

  it('ignores PINDEX_PARSE_WORKERS when explicit is given', () => {
    process.env.PINDEX_PARSE_WORKERS = '6';
    expect(ParsePool.pickDefaultWorkerCount(2)).toBe(2);
  });

  it('ignores empty or non-numeric PINDEX_PARSE_WORKERS values', () => {
    process.env.PINDEX_PARSE_WORKERS = '';
    process.env.VITEST = 'true';
    expect(ParsePool.pickDefaultWorkerCount(undefined)).toBe(0);

    process.env.PINDEX_PARSE_WORKERS = 'nope';
    expect(ParsePool.pickDefaultWorkerCount(undefined)).toBe(0);
  });

  it('ignores negative PINDEX_PARSE_WORKERS', () => {
    process.env.PINDEX_PARSE_WORKERS = '-2';
    process.env.VITEST = 'true';
    // falls through to VITEST → 0 (negative parsed int fails the >= 0 guard)
    expect(ParsePool.pickDefaultWorkerCount(undefined)).toBe(0);
  });

  it('returns 0 when VITEST=true and PINDEX_PARSE_WORKERS is unset', () => {
    delete process.env.PINDEX_PARSE_WORKERS;
    process.env.VITEST = 'true';
    expect(ParsePool.pickDefaultWorkerCount(undefined)).toBe(0);
  });

  it('uses cpus().length - 1 (min 1) when not under VITEST and no env override', () => {
    delete process.env.PINDEX_PARSE_WORKERS;
    delete process.env.VITEST;
    const n = ParsePool.pickDefaultWorkerCount(undefined);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe('ParsePool.pickEffectiveWorkerCount', () => {
  it('returns 0 when configured is 0 regardless of jobCount', () => {
    expect(ParsePool.pickEffectiveWorkerCount(0, 0)).toBe(0);
    expect(ParsePool.pickEffectiveWorkerCount(1000, 0)).toBe(0);
  });

  it('returns 0 for batches smaller than 10', () => {
    expect(ParsePool.pickEffectiveWorkerCount(0, 4)).toBe(0);
    expect(ParsePool.pickEffectiveWorkerCount(9, 4)).toBe(0);
  });

  it('returns 1 for batches smaller than configured*2 but at least 10', () => {
    expect(ParsePool.pickEffectiveWorkerCount(10, 8)).toBe(1);
    expect(ParsePool.pickEffectiveWorkerCount(15, 8)).toBe(1);
  });

  it('returns the configured value for larger batches', () => {
    expect(ParsePool.pickEffectiveWorkerCount(20, 8)).toBe(8);
    expect(ParsePool.pickEffectiveWorkerCount(10_000, 4)).toBe(4);
  });

  it('boundary: jobCount === configured*2 returns configured', () => {
    expect(ParsePool.pickEffectiveWorkerCount(16, 8)).toBe(8);
  });
});
