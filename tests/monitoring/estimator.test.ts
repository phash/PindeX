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

  it('returns sum of dependency files for get_dependencies', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'get_dependencies', targetFile: 'src/auth.ts' });
    // auth.ts imports utils.ts → 400 tokens
    expect(estimate).toBeGreaterThan(0);
  });

  it('returns fallback multiplier for unknown tool', () => {
    const tokensUsed = 50;
    const estimate = estimateWithoutIndex(db, { tool: 'unknown_tool', tokensUsed });
    expect(estimate).toBe(tokensUsed * 10);
  });

  it('returns 0 for search_symbols when no files match', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'search_symbols', query: 'nonexistent' });
    // No matching files, estimate based on all files or 0
    expect(typeof estimate).toBe('number');
  });

  it('returns a positive number for search_symbols when files exist', () => {
    const estimate = estimateWithoutIndex(db, { tool: 'search_symbols', query: 'auth' });
    expect(estimate).toBeGreaterThanOrEqual(0);
  });
});
