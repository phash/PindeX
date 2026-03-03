import { describe, it, expect } from 'vitest';
import {
  SearchSymbolsSchema,
  GetSymbolSchema,
  GetContextSchema,
  GetFileSummarySchema,
  FindUsagesSchema,
  GetDependenciesSchema,
  GetProjectOverviewSchema,
  ReindexSchema,
  GetTokenStatsSchema,
  StartComparisonSchema,
  SearchDocsSchema,
  GetDocChunkSchema,
  SaveContextSchema,
  GetSessionMemorySchema,
  TOOL_SCHEMAS,
} from '../../src/tools/schemas.js';

// ─── SearchSymbolsSchema ────────────────────────────────────────────────────

describe('SearchSymbolsSchema', () => {
  it('accepts valid input with all fields', () => {
    const result = SearchSymbolsSchema.safeParse({
      query: 'createUser',
      limit: 10,
      isAsync: true,
      hasTryCatch: false,
      snippet: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal input (only required fields)', () => {
    const result = SearchSymbolsSchema.safeParse({ query: 'foo' });
    expect(result.success).toBe(true);
  });

  it('rejects missing query', () => {
    const result = SearchSymbolsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty query', () => {
    const result = SearchSymbolsSchema.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('rejects wrong type for query', () => {
    const result = SearchSymbolsSchema.safeParse({ query: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects negative limit', () => {
    const result = SearchSymbolsSchema.safeParse({ query: 'x', limit: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer limit', () => {
    const result = SearchSymbolsSchema.safeParse({ query: 'x', limit: 1.5 });
    expect(result.success).toBe(false);
  });
});

// ─── GetSymbolSchema ────────────────────────────────────────────────────────

describe('GetSymbolSchema', () => {
  it('accepts valid input', () => {
    const result = GetSymbolSchema.safeParse({ name: 'MyClass', file: 'src/foo.ts' });
    expect(result.success).toBe(true);
  });

  it('accepts without optional file', () => {
    const result = GetSymbolSchema.safeParse({ name: 'MyClass' });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = GetSymbolSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = GetSymbolSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});

// ─── GetContextSchema ───────────────────────────────────────────────────────

describe('GetContextSchema', () => {
  it('accepts valid input', () => {
    const result = GetContextSchema.safeParse({ file: 'src/foo.ts', line: 42, range: 30 });
    expect(result.success).toBe(true);
  });

  it('accepts without optional range', () => {
    const result = GetContextSchema.safeParse({ file: 'src/foo.ts', line: 1 });
    expect(result.success).toBe(true);
  });

  it('rejects missing file', () => {
    const result = GetContextSchema.safeParse({ line: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects missing line', () => {
    const result = GetContextSchema.safeParse({ file: 'src/foo.ts' });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive line', () => {
    const result = GetContextSchema.safeParse({ file: 'src/foo.ts', line: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects string line', () => {
    const result = GetContextSchema.safeParse({ file: 'src/foo.ts', line: 'ten' });
    expect(result.success).toBe(false);
  });
});

// ─── GetFileSummarySchema ───────────────────────────────────────────────────

describe('GetFileSummarySchema', () => {
  it('accepts valid input', () => {
    const result = GetFileSummarySchema.safeParse({ file: 'src/main.ts' });
    expect(result.success).toBe(true);
  });

  it('rejects missing file', () => {
    const result = GetFileSummarySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── FindUsagesSchema ───────────────────────────────────────────────────────

describe('FindUsagesSchema', () => {
  it('accepts valid input', () => {
    const result = FindUsagesSchema.safeParse({ symbol: 'myFunc' });
    expect(result.success).toBe(true);
  });

  it('rejects missing symbol', () => {
    const result = FindUsagesSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty symbol', () => {
    const result = FindUsagesSchema.safeParse({ symbol: '' });
    expect(result.success).toBe(false);
  });
});

// ─── GetDependenciesSchema ──────────────────────────────────────────────────

describe('GetDependenciesSchema', () => {
  it('accepts valid input with direction', () => {
    const result = GetDependenciesSchema.safeParse({ target: 'src/auth.ts', direction: 'imports' });
    expect(result.success).toBe(true);
  });

  it('accepts all valid direction values', () => {
    for (const dir of ['imports', 'imported_by', 'both']) {
      const result = GetDependenciesSchema.safeParse({ target: 'x.ts', direction: dir });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid direction enum', () => {
    const result = GetDependenciesSchema.safeParse({ target: 'x.ts', direction: 'all' });
    expect(result.success).toBe(false);
  });

  it('accepts without optional direction', () => {
    const result = GetDependenciesSchema.safeParse({ target: 'src/auth.ts' });
    expect(result.success).toBe(true);
  });

  it('rejects missing target', () => {
    const result = GetDependenciesSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── GetProjectOverviewSchema ───────────────────────────────────────────────

describe('GetProjectOverviewSchema', () => {
  it('accepts valid input with mode', () => {
    const result = GetProjectOverviewSchema.safeParse({ mode: 'brief' });
    expect(result.success).toBe(true);
  });

  it('accepts empty input (all optional)', () => {
    const result = GetProjectOverviewSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects invalid mode enum', () => {
    const result = GetProjectOverviewSchema.safeParse({ mode: 'detailed' });
    expect(result.success).toBe(false);
  });
});

// ─── ReindexSchema ──────────────────────────────────────────────────────────

describe('ReindexSchema', () => {
  it('accepts valid input with target', () => {
    const result = ReindexSchema.safeParse({ target: 'src/main.ts' });
    expect(result.success).toBe(true);
  });

  it('accepts empty input (all optional)', () => {
    const result = ReindexSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ─── GetTokenStatsSchema ────────────────────────────────────────────────────

describe('GetTokenStatsSchema', () => {
  it('accepts valid input', () => {
    const result = GetTokenStatsSchema.safeParse({ session_id: 'abc-123' });
    expect(result.success).toBe(true);
  });

  it('accepts empty input (all optional)', () => {
    const result = GetTokenStatsSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ─── StartComparisonSchema ──────────────────────────────────────────────────

describe('StartComparisonSchema', () => {
  it('accepts valid input', () => {
    const result = StartComparisonSchema.safeParse({ label: 'test-run', mode: 'indexed' });
    expect(result.success).toBe(true);
  });

  it('accepts baseline mode', () => {
    const result = StartComparisonSchema.safeParse({ label: 'test-run', mode: 'baseline' });
    expect(result.success).toBe(true);
  });

  it('rejects missing label', () => {
    const result = StartComparisonSchema.safeParse({ mode: 'indexed' });
    expect(result.success).toBe(false);
  });

  it('rejects missing mode', () => {
    const result = StartComparisonSchema.safeParse({ label: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid mode enum', () => {
    const result = StartComparisonSchema.safeParse({ label: 'x', mode: 'passive' });
    expect(result.success).toBe(false);
  });
});

// ─── SearchDocsSchema ───────────────────────────────────────────────────────

describe('SearchDocsSchema', () => {
  it('accepts valid input with all fields', () => {
    const result = SearchDocsSchema.safeParse({ query: 'auth', limit: 5, type: 'docs' });
    expect(result.success).toBe(true);
  });

  it('accepts all valid type values', () => {
    for (const t of ['docs', 'context', 'all']) {
      const result = SearchDocsSchema.safeParse({ query: 'x', type: t });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid type enum', () => {
    const result = SearchDocsSchema.safeParse({ query: 'x', type: 'memory' });
    expect(result.success).toBe(false);
  });

  it('rejects missing query', () => {
    const result = SearchDocsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── GetDocChunkSchema ──────────────────────────────────────────────────────

describe('GetDocChunkSchema', () => {
  it('accepts valid input with chunk_index', () => {
    const result = GetDocChunkSchema.safeParse({ file: 'README.md', chunk_index: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts without optional chunk_index', () => {
    const result = GetDocChunkSchema.safeParse({ file: 'README.md' });
    expect(result.success).toBe(true);
  });

  it('rejects missing file', () => {
    const result = GetDocChunkSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects negative chunk_index', () => {
    const result = GetDocChunkSchema.safeParse({ file: 'README.md', chunk_index: -1 });
    expect(result.success).toBe(false);
  });
});

// ─── SaveContextSchema ──────────────────────────────────────────────────────

describe('SaveContextSchema', () => {
  it('accepts valid input', () => {
    const result = SaveContextSchema.safeParse({ content: 'some note', tags: 'auth,api' });
    expect(result.success).toBe(true);
  });

  it('accepts without optional tags', () => {
    const result = SaveContextSchema.safeParse({ content: 'some note' });
    expect(result.success).toBe(true);
  });

  it('rejects missing content', () => {
    const result = SaveContextSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty content', () => {
    const result = SaveContextSchema.safeParse({ content: '' });
    expect(result.success).toBe(false);
  });
});

// ─── GetSessionMemorySchema ─────────────────────────────────────────────────

describe('GetSessionMemorySchema', () => {
  it('accepts valid input with all fields', () => {
    const result = GetSessionMemorySchema.safeParse({
      session_id: 'abc',
      file: 'src/auth.ts',
      symbol: 'login',
      include_stale: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty input (all optional)', () => {
    const result = GetSessionMemorySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects wrong type for include_stale', () => {
    const result = GetSessionMemorySchema.safeParse({ include_stale: 'yes' });
    expect(result.success).toBe(false);
  });
});

// ─── TOOL_SCHEMAS map ───────────────────────────────────────────────────────

describe('TOOL_SCHEMAS', () => {
  it('contains schemas for all 14 tools (excluding get_api_endpoints)', () => {
    const expectedTools = [
      'search_symbols',
      'get_symbol',
      'get_context',
      'get_file_summary',
      'find_usages',
      'get_dependencies',
      'get_project_overview',
      'reindex',
      'get_token_stats',
      'start_comparison',
      'search_docs',
      'get_doc_chunk',
      'save_context',
      'get_session_memory',
    ];
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual(expectedTools.sort());
  });

  it('does not include get_api_endpoints', () => {
    expect(TOOL_SCHEMAS['get_api_endpoints']).toBeUndefined();
  });
});
