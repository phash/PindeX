import { vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Sandbox: never touch the developer's real ~/.pindex ─────────────────────
// os.homedir() honours HOME (POSIX) / USERPROFILE (Windows), so every unit test
// that reaches getPindexHome()/GlobalRegistry lands in a throwaway directory.
// One directory per vitest worker slot, wiped on start: bounded footprint even if
// the forked worker is killed before an exit handler can run.
const sandboxHome = join(tmpdir(), `pindex-test-home-${process.env.VITEST_POOL_ID ?? 'x'}`);
rmSync(sandboxHome, { recursive: true, force: true });
mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.on('exit', () => { try { rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* best-effort */ } });

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
