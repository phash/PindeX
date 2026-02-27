import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile } from '../helpers/fixtures.js';
import { getContext } from '../../src/tools/get_context.js';

describe('getContext', () => {
  let db: Database.Database;
  let testDir: string;

  const fileContent = [
    'line 1',
    'line 2',
    'line 3',
    'line 4',
    'line 5',
    'line 6',
    'line 7',
    'line 8',
    'line 9',
    'line 10',
  ].join('\n');

  beforeEach(() => {
    db = createTestDb();
    testDir = join(tmpdir(), `pindex-ctx-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'file.ts'), fileContent);
    insertTestFile(db, { path: 'src/file.ts', language: 'typescript' });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns code around the requested line', async () => {
    const result = await getContext(db, testDir, { file: 'src/file.ts', line: 5, range: 2 });
    expect(result).not.toBeNull();
    expect(result!.code).toContain('line 5');
  });

  it('returns the language from the file record', async () => {
    const result = await getContext(db, testDir, { file: 'src/file.ts', line: 1 });
    expect(result!.language).toBe('typescript');
  });

  it('respects the range parameter', async () => {
    const result = await getContext(db, testDir, { file: 'src/file.ts', line: 5, range: 1 });
    const lines = result!.code.split('\n');
    // range 1 means 1 line before + target + 1 line after = 3 lines max
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('uses default range of 30 when not specified', async () => {
    const result = await getContext(db, testDir, { file: 'src/file.ts', line: 5 });
    expect(result!.code).toBeTruthy();
  });

  it('returns null when file not found in db', async () => {
    const result = await getContext(db, testDir, { file: 'nonexistent.ts', line: 1 });
    expect(result).toBeNull();
  });

  it('clamps to first line when requesting line 0 or negative', async () => {
    const result = await getContext(db, testDir, { file: 'src/file.ts', line: 0 });
    expect(result).not.toBeNull();
    expect(result!.startLine).toBeGreaterThanOrEqual(1);
  });

  it('returns startLine and endLine', async () => {
    const result = await getContext(db, testDir, { file: 'src/file.ts', line: 5, range: 2 });
    expect(typeof result!.startLine).toBe('number');
    expect(typeof result!.endLine).toBe('number');
    expect(result!.endLine).toBeGreaterThanOrEqual(result!.startLine);
  });
});
