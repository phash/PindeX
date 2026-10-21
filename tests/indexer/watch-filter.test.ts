import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { glob } from 'glob';
import { createWatchFilter } from '../../src/indexer/watch-filter.js';
import { DEFAULT_IGNORE, LANGUAGE_PATTERNS } from '../../src/indexer/index.js';

const ROOT = '/proj';
const INCLUDE = [...LANGUAGE_PATTERNS.typescript, ...LANGUAGE_PATTERNS.javascript, '**/*.md', '**/*.yml'];
const file = { isFile: () => true, isDirectory: () => false };
const dir = { isFile: () => false, isDirectory: () => true };

function makeFilter() {
  return createWatchFilter({ projectRoot: ROOT, include: INCLUDE, ignore: DEFAULT_IGNORE });
}

describe('createWatchFilter — accepts()', () => {
  const f = makeFilter();

  it('accepts files matching an include glob at any depth', () => {
    expect(f.accepts('a.ts')).toBe(true);
    expect(f.accepts('src/deep/nested/b.tsx')).toBe(true);
    expect(f.accepts('lib/c.mjs')).toBe(true);
    expect(f.accepts('docs/guide.md')).toBe(true);
  });

  it('rejects files no include glob matches', () => {
    expect(f.accepts('logo.png')).toBe(false);
    expect(f.accepts('src/styles.css')).toBe(false);
    expect(f.accepts('Makefile')).toBe(false);
  });

  it('rejects file-level ignore patterns (*.d.ts, *.min.js)', () => {
    expect(f.accepts('types/index.d.ts')).toBe(false);
    expect(f.accepts('vendor.min.js')).toBe(false);
  });

  it('rejects anything below an ignored directory, at any depth', () => {
    expect(f.accepts('node_modules/pkg/index.js')).toBe(false);
    expect(f.accepts('packages/app/node_modules/x/y.ts')).toBe(false);
    expect(f.accepts('dist/index.js')).toBe(false);
    expect(f.accepts('services/api/build/out.js')).toBe(false);
  });

  it('rejects dot files and anything inside dot directories (glob dot: false)', () => {
    expect(f.accepts('.eslintrc.js')).toBe(false);
    expect(f.accepts('.github/workflows/ci.yml')).toBe(false);
    expect(f.accepts('.pindex/notes.md')).toBe(false);
    expect(f.accepts('src/.hidden/a.ts')).toBe(false);
  });

  it('normalizes backslashes and ./ prefixes', () => {
    expect(f.accepts('src\\win\\file.ts')).toBe(true);
    expect(f.accepts('./src/a.ts')).toBe(true);
    expect(f.accepts('node_modules\\pkg\\a.ts')).toBe(false);
  });

  it('rejects empty and root-escaping paths', () => {
    expect(f.accepts('')).toBe(false);
    expect(f.accepts('../outside.ts')).toBe(false);
  });

  it('does not treat a directory name that merely contains an ignored word as ignored', () => {
    expect(f.accepts('my_node_modules_docs/a.ts')).toBe(true);
    expect(f.accepts('builders/a.ts')).toBe(true);
  });
});

describe('createWatchFilter — ignored() (chokidar callback)', () => {
  const f = makeFilter();

  it('never ignores the project root', () => {
    expect(f.ignored(ROOT, dir)).toBe(false);
    expect(f.ignored(ROOT)).toBe(false);
  });

  it('prunes ignored and dot directories so chokidar does not descend them', () => {
    expect(f.ignored(`${ROOT}/node_modules`, dir)).toBe(true);
    expect(f.ignored(`${ROOT}/a/b/node_modules`, dir)).toBe(true);
    expect(f.ignored(`${ROOT}/.git`, dir)).toBe(true);
    expect(f.ignored(`${ROOT}/.pindex`, dir)).toBe(true);
    expect(f.ignored(`${ROOT}/dist`, dir)).toBe(true);
  });

  it('keeps ordinary directories so their files are watched', () => {
    expect(f.ignored(`${ROOT}/src`, dir)).toBe(false);
    expect(f.ignored(`${ROOT}/src/components`, dir)).toBe(false);
  });

  it('filters files by include globs once stats are known', () => {
    expect(f.ignored(`${ROOT}/src/a.ts`, file)).toBe(false);
    expect(f.ignored(`${ROOT}/src/a.png`, file)).toBe(true);
    expect(f.ignored(`${ROOT}/src/a.d.ts`, file)).toBe(true);
  });

  it('without stats prunes only what is certainly ignored', () => {
    expect(f.ignored(`${ROOT}/node_modules/x/y.js`)).toBe(true);
    expect(f.ignored(`${ROOT}/src/a.png`)).toBe(false); // unknown kind: let accepts() decide later
    expect(f.ignored(`${ROOT}/src`)).toBe(false);
  });

  it('accepts root-relative input as well as absolute paths', () => {
    expect(f.ignored('src/a.ts', file)).toBe(false);
    expect(f.ignored('node_modules', dir)).toBe(true);
  });

  it('ignores paths outside the project root', () => {
    expect(f.ignored('/elsewhere/a.ts', file)).toBe(true);
  });
});

describe('createWatchFilter — parity with glob() as used by indexAll()', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pindex-watch-filter-'));
    const files = [
      'a.ts', 'b.js', 'README.md', 'logo.png', '.eslintrc.js',
      'src/index.ts', 'src/view.tsx', 'src/types.d.ts', 'src/lib.min.js', 'src/style.css',
      'src/deep/x/y/z.mjs', 'src/.hidden/secret.ts',
      'node_modules/pkg/index.js', 'packages/app/node_modules/dep/a.ts',
      'dist/out.js', 'build/out.js', 'docs/guide.md', 'docs/ci.yml',
      '.github/workflows/ci.yml', '.pindex/index.md',
      'my_node_modules_docs/a.ts', 'vendor/lib.js', 'out/gen.ts',
    ];
    for (const rel of files) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), '');
    }
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Walks the tree the way chokidar does: consult ignored() per entry, skip pruned dirs. */
  function walk(filter: ReturnType<typeof createWatchFilter>, dirPath: string, out: string[]): void {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const abs = join(dirPath, entry.name);
      if (filter.ignored(abs)) continue;
      if (entry.isDirectory()) {
        if (!filter.ignored(abs, dir)) walk(filter, abs, out);
      } else if (!filter.ignored(abs, file)) {
        out.push(relative(root, abs).replace(/\\/g, '/'));
      }
    }
  }

  it('the watcher sees exactly the files indexAll() would index', async () => {
    const expected = (await glob(INCLUDE, { cwd: root, ignore: DEFAULT_IGNORE, posix: true })).sort();
    const filter = createWatchFilter({ projectRoot: root, include: INCLUDE, ignore: DEFAULT_IGNORE });
    const seen: string[] = [];
    walk(filter, root, seen);

    expect(seen.sort()).toEqual(expected);
    expect(expected).toContain('src/deep/x/y/z.mjs');
    expect(expected).not.toContain('src/types.d.ts');
  });
});
