import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectLanguages } from '../../src/indexer/detect-languages.js';

describe('detectProjectLanguages', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pindex-detect-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects the languages of files that are present (sorted)', async () => {
    writeFileSync(join(dir, 'a.py'), 'x = 1');
    writeFileSync(join(dir, 'b.go'), 'package main');
    expect(await detectProjectLanguages(dir)).toEqual(['go', 'python']);
  });

  it('maps .tsx to typescript (family key, not the bare extension)', async () => {
    writeFileSync(join(dir, 'c.tsx'), 'export const x = 1;');
    expect(await detectProjectLanguages(dir)).toEqual(['typescript']);
  });

  it('falls back to the TS/JS default when no code files are present', async () => {
    writeFileSync(join(dir, 'README.md'), '# docs only');
    expect(await detectProjectLanguages(dir)).toEqual(['typescript', 'javascript']);
  });

  it('ignores build/vendor dirs like node_modules', async () => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'x.py'), 'x = 1');
    expect(await detectProjectLanguages(dir)).toEqual(['typescript', 'javascript']);
  });
});
