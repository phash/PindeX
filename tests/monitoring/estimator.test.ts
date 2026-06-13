import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestDependency } from '../helpers/fixtures.js';
import { estimateWithoutIndex, estimateFileTokens } from '../../src/monitoring/estimator.js';

describe('estimateFileTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateFileTokens('1234')).toBe(1);
    expect(estimateFileTokens('12345678')).toBe(2);
    expect(estimateFileTokens('')).toBe(0);
  });

  it('rounds up', () => {
    expect(estimateFileTokens('12345')).toBe(2);
  });
});

describe('estimateWithoutIndex', () => {
  let db: Database.Database;
  let fileAId: number;
  let fileBId: number;

  beforeEach(() => {
    db = createTestDb();
    fileAId = insertTestFile(db, { path: 'src/auth.ts', rawTokenEstimate: 1200 });
    fileBId = insertTestFile(db, { path: 'src/utils.ts', rawTokenEstimate: 400 });
    insertTestDependency(db, fileAId, fileBId, 'helper');
  });

  it('returns host file token estimate for get_symbol', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_symbol', name: 'foo', targetFile: 'src/auth.ts' });
    expect(estimate).toBe(1200);
  });

  it('returns host file token estimate for get_context', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_context', targetFile: 'src/auth.ts' });
    expect(estimate).toBe(1200);
  });

  it('returns host file + transitive dependency tokens for get_dependencies', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_dependencies', targetFile: 'src/auth.ts' });
    // Host auth.ts (1200) + its dependency utils.ts (400) = 1600
    expect(estimate).toBe(1600);
  });

  it('returns fallback multiplier for unknown tool', () => {
    const tokensUsed = 50;
    const estimate = estimateWithoutIndex(db, { tool: 'unknown_tool', tokensUsed });
    expect(estimate).toBe(tokensUsed * 10);
  });

  it('falls back to avg-file-size × 3 for search_symbols when no path matches', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'search_symbols', query: 'nonexistent' });
    // No path contains "nonexistent" → avg((1200 + 400) / 2) = 800, × 3 files = 2400
    expect(estimate).toBe(2400);
  });

  it('sums only path-matching files for search_symbols', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'search_symbols', query: 'auth' });
    // Only src/auth.ts path contains "auth" → 1200 (utils.ts excluded)
    expect(estimate).toBe(1200);
  });

  // ─── search_symbols: empty-query worst-case branch ─────────────────────────
  it('sums ALL files for search_symbols when no query is given', () => {
    // No query (undefined) → worst-case sum of every file: 1200 + 400 = 1600
    const estimate = estimateWithoutIndex(db, { tool: 'search_symbols' });
    expect(estimate).toBe(1600);
  });

  it('sums ALL files for search_symbols when query is an empty string', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'search_symbols', query: '' });
    expect(estimate).toBe(1600);
  });

  it('returns 0 for search_symbols no-match fallback on an empty DB', () => {
    const empty = createTestDb();
    // allFiles.length === 0 → avgTokens = 0 → round(0 * 3) = 0
    const estimate = estimateWithoutIndex(empty, { tool: 'search_symbols', query: 'whatever' });
    expect(estimate).toBe(0);
  });

  // ─── get_symbol branches ───────────────────────────────────────────────────
  it('uses tokensUsed×10 for get_symbol with no targetFile', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_symbol', name: 'foo', tokensUsed: 70 });
    expect(estimate).toBe(700);
  });

  it('uses default 50×10 for get_symbol with no targetFile and no tokensUsed', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_symbol', name: 'foo' });
    expect(estimate).toBe(500);
  });

  it('falls back to tokensUsed×10 for get_symbol when the file is unknown', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_symbol', targetFile: 'src/missing.ts', tokensUsed: 33 });
    expect(estimate).toBe(330);
  });

  // ─── get_context branches ──────────────────────────────────────────────────
  it('uses tokensUsed×5 for get_context with no targetFile', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_context', tokensUsed: 200 });
    expect(estimate).toBe(1000);
  });

  it('uses default 150×5 for get_context with no targetFile and no tokensUsed', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_context' });
    expect(estimate).toBe(750);
  });

  it('falls back to tokensUsed×5 for get_context when the file is unknown', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_context', targetFile: 'src/missing.ts', tokensUsed: 12 });
    expect(estimate).toBe(60);
  });

  // ─── get_file_summary branches ─────────────────────────────────────────────
  it('returns host file token estimate for get_file_summary', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_file_summary', targetFile: 'src/auth.ts' });
    expect(estimate).toBe(1200);
  });

  it('uses tokensUsed×8 for get_file_summary with no targetFile', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_file_summary', tokensUsed: 25 });
    expect(estimate).toBe(200);
  });

  it('uses default 100×8 for get_file_summary with no targetFile and no tokensUsed', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_file_summary' });
    expect(estimate).toBe(800);
  });

  it('falls back to tokensUsed×8 for get_file_summary when the file is unknown', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_file_summary', targetFile: 'src/missing.ts', tokensUsed: 9 });
    expect(estimate).toBe(72);
  });

  // ─── get_dependencies branches ─────────────────────────────────────────────
  it('uses tokensUsed×10 for get_dependencies with no targetFile', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_dependencies', tokensUsed: 8 });
    expect(estimate).toBe(80);
  });

  it('uses default 80×10 for get_dependencies with no targetFile and no tokensUsed', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_dependencies' });
    expect(estimate).toBe(800);
  });

  it('falls back to tokensUsed×10 for get_dependencies when the file is unknown', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_dependencies', targetFile: 'src/missing.ts', tokensUsed: 7 });
    expect(estimate).toBe(70);
  });

  it('returns just the host token estimate for get_dependencies with no deps', () => {
    // utils.ts has no outgoing dependencies → just its own 400
    const estimate = estimateWithoutIndex(db, { tool: 'get_dependencies', targetFile: 'src/utils.ts' });
    expect(estimate).toBe(400);
  });

  // ─── find_usages branches ──────────────────────────────────────────────────
  it('returns avg×min(count,5) for find_usages with files present', () => {
    // avg = (1200 + 400) / 2 = 800; min(2, 5) = 2 → 1600
    const estimate = estimateWithoutIndex(db, { tool: 'find_usages' });
    expect(estimate).toBe(1600);
  });

  it('returns 0 for find_usages on an empty DB', () => {
    const empty = createTestDb();
    // allFiles.length === 0 → avgTokens = 0 → round(0 * 0) = 0
    const estimate = estimateWithoutIndex(empty, { tool: 'find_usages' });
    expect(estimate).toBe(0);
  });

  it('caps find_usages at 5 files', () => {
    const many = createTestDb();
    for (let i = 0; i < 8; i++) {
      insertTestFile(many, { path: `src/f${i}.ts`, hash: `h${i}`, rawTokenEstimate: 100 });
    }
    // avg = 100; min(8, 5) = 5 → 500
    const estimate = estimateWithoutIndex(many, { tool: 'find_usages' });
    expect(estimate).toBe(500);
  });

  // ─── get_project_overview branches ─────────────────────────────────────────
  it('sums 30% of every file estimate for get_project_overview', () => {
    // round(1200*0.3) + round(400*0.3) = 360 + 120 = 480
    const estimate = estimateWithoutIndex(db, { tool: 'get_project_overview' });
    expect(estimate).toBe(480);
  });

  it('returns 0 for get_project_overview on an empty DB', () => {
    const empty = createTestDb();
    const estimate = estimateWithoutIndex(empty, { tool: 'get_project_overview' });
    expect(estimate).toBe(0);
  });

  // ─── default branch ────────────────────────────────────────────────────────
  it('uses default 50×10 for unknown tool without tokensUsed', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'totally_unknown' });
    expect(estimate).toBe(500);
  });

  it('routes search_docs / get_doc_chunk through the default fallback', () => {
    // These tools are not special-cased → default 10× multiplier.
    expect(estimateWithoutIndex(db, { tool: 'search_docs', tokensUsed: 11 })).toBe(110);
    expect(estimateWithoutIndex(db, { tool: 'get_doc_chunk', tokensUsed: 13 })).toBe(130);
  });

  // ─── null raw_token_estimate coalescing ────────────────────────────────────
  it('coalesces null raw_token_estimate to 0 for get_symbol', () => {
    const nulldb = createTestDb();
    nulldb.prepare(
      `INSERT INTO files (path, language, last_indexed, hash, raw_token_estimate)
       VALUES (?, ?, datetime('now'), ?, NULL)`,
    ).run('src/nulltok.ts', 'typescript', 'nh');
    // file exists but raw_token_estimate is NULL → `?? (tokensUsed ?? 50)*10`
    const estimate = estimateWithoutIndex(nulldb, { tool: 'get_symbol', targetFile: 'src/nulltok.ts', tokensUsed: 5 });
    expect(estimate).toBe(50);
  });
});
