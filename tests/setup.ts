import { vi } from 'vitest';

// ─── Mock: tree-sitter (native bindings) ─────────────────────────────────────
// tree-sitter uses native Node.js addons (.node files) which don't work
// well in Vitest even with pool: 'forks'. We mock it here globally.
// The actual tree-sitter integration is tested via integration tests.

vi.mock('tree-sitter', () => {
  const MockParser = vi.fn().mockImplementation(() => ({
    setLanguage: vi.fn(),
    parse: vi.fn().mockReturnValue({
      rootNode: {
        type: 'program',
        text: '',
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: 0 },
        children: [],
        namedChildren: [],
        childForFieldName: vi.fn().mockReturnValue(null),
        descendantsOfType: vi.fn().mockReturnValue([]),
      },
    }),
  }));
  return { default: MockParser };
});

vi.mock('tree-sitter-typescript', () => ({
  typescript: { name: 'typescript' },
  tsx: { name: 'tsx' },
}));

// ─── Mock: chokidar (file watching) ──────────────────────────────────────────
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
  watch: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ─── Mock: open (browser opening) ────────────────────────────────────────────
vi.mock('open', () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));
