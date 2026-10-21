import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { Indexer } from '../../src/indexer/index.js';
import { getAllFiles, getFileByPath, getSymbolsByFileId, upsertFile } from '../../src/db/queries.js';
import { LspPythonClient } from '../../src/indexer/lsp-python.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

let testDir: string;

function createTempProject(): string {
  const dir = join(tmpdir(), `pindex-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });

  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `export function hello(name: string): string { return 'Hello ' + name; }`,
  );
  writeFileSync(
    join(dir, 'src', 'service.ts'),
    `import { hello } from './index';\nexport class MyService { greet() { return hello('world'); } }`,
  );
  // This should be ignored
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.ts'), 'export const x = 1;');

  return dir;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Indexer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    testDir = createTempProject();
  });

  it('indexes all TypeScript files in a project directory', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    const result = await indexer.indexAll();

    expect(result.indexed + result.updated).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    const files = getAllFiles(db);
    const filePaths = files.map((f) => f.path);
    expect(filePaths).toContain('src/index.ts');
    expect(filePaths).toContain('src/service.ts');
  });

  it('ignores node_modules directory', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    const files = getAllFiles(db);
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('skips unchanged files on second run (hash-based)', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    const result2 = await indexer.indexAll();
    // All files should be skipped (unchanged), so indexed should be 0
    expect(result2.indexed).toBe(0);
    expect(result2.updated).toBe(0);
  });

  it('re-indexes a file when its content changes', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    // Modify a file
    writeFileSync(
      join(testDir, 'src', 'index.ts'),
      `export function hello(name: string): string { return 'Hi ' + name; }\nexport function bye(): void {}`,
    );

    const result2 = await indexer.indexAll();
    expect(result2.updated).toBe(1);
  });

  it('stores a valid hash for each indexed file', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    const file = getFileByPath(db, 'src/index.ts');
    expect(file).not.toBeNull();
    expect(file!.hash).toMatch(/^[a-f0-9]{32}$/); // MD5 hex
  });

  it('stores a raw_token_estimate > 0 for non-empty files', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    const file = getFileByPath(db, 'src/index.ts');
    expect(file!.raw_token_estimate).toBeGreaterThan(0);
  });

  it('indexFile handles a non-existent file gracefully', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    const result = await indexer.indexFile('src/ghost.ts');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('indexAll returns errors array for problematic files', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    // Override to inject an error path
    const result = await indexer.indexAll({ additionalPaths: ['nonexistent/ghost.ts'] });
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('resolveDependencies reuses parsed imports from indexAll (no file re-read)', async () => {
    const indexer = new Indexer({ db, projectRoot: testDir });
    await indexer.indexAll();

    // Delete the source file between indexAll and resolveDependencies; the
    // cached imports should still be used, so the call must not error.
    rmSync(join(testDir, 'src', 'service.ts'));
    await expect(indexer.resolveDependencies()).resolves.toBeUndefined();
  });

  // ─── SEC-01: path traversal rejection ──────────────────────────────────────
  describe('rejects path traversal (SEC-01)', () => {
    it('indexFile rejects a "../"-escaping relative path without reading', async () => {
      const indexer = new Indexer({ db, projectRoot: testDir, maxParseWorkers: 0 });
      const result = await indexer.indexFile('../../../../etc/passwd', true);
      expect(result.status).toBe('error');
      expect(result.errors.join(' ')).toMatch(/escapes project root/i);
    });

    it('indexFile rejects an absolute path outside the root', async () => {
      const indexer = new Indexer({ db, projectRoot: testDir, maxParseWorkers: 0 });
      const result = await indexer.indexFile('/etc/passwd', true);
      expect(result.status).toBe('error');
      expect(result.errors.join(' ')).toMatch(/escapes project root/i);
    });

    it('indexDocument rejects a "../"-escaping relative path', async () => {
      const indexer = new Indexer({ db, projectRoot: testDir, maxParseWorkers: 0 });
      const result = await indexer.indexDocument('../escape.md', true);
      expect(result.status).toBe('error');
      expect(result.errors.join(' ')).toMatch(/escapes project root/i);
    });

    it('indexFile still indexes a legitimate in-root file', async () => {
      const indexer = new Indexer({ db, projectRoot: testDir, maxParseWorkers: 0 });
      const result = await indexer.indexFile('src/index.ts', true);
      expect(result.status).not.toBe('error');
      expect(result.errors).toHaveLength(0);
    });
  });

  it('overwrites regex symbols with LSP result when LSP is ready', async () => {
    class FakeLsp extends LspPythonClient {
      async start(): Promise<void> { (this as never as { _state: string })._state = 'ready'; }
      get ready(): boolean { return true; }
      get state(): 'ready' { return 'ready'; }
      async getDocumentSymbols() {
        return {
          symbols: [
            {
              name: 'from_lsp',
              kind: 'function' as const,
              signature: 'from_lsp',
              startLine: 1,
              endLine: 3,
              isExported: true,
              isAsync: false,
              hasTryCatch: false,
            },
          ],
          imports: [{ source: 'os', symbols: [] }],
        };
      }
      async close(): Promise<void> { /* no-op */ }
    }

    const pyDir = join(tmpdir(), `pindex-lsp-indexer-${Date.now()}`);
    mkdirSync(pyDir, { recursive: true });
    writeFileSync(join(pyDir, 'x.py'), 'def not_from_lsp(): pass\n');

    try {
      const indexer = new Indexer({ db, projectRoot: pyDir, languages: ['python'] });
      // Inject the fake LSP client.
      (indexer as never as { lsp: LspPythonClient }).lsp = new FakeLsp({
        projectRoot: pyDir,
        enabled: true,
      });

      await indexer.indexAll();

      const file = getFileByPath(db, 'x.py');
      expect(file).not.toBeNull();
      const symbols = getSymbolsByFileId(db, file!.id);
      expect(symbols.map((s) => s.name)).toContain('from_lsp');
      expect(symbols.map((s) => s.name)).not.toContain('not_from_lsp');
    } finally {
      rmSync(pyDir, { recursive: true, force: true });
    }
  });
});

describe('resolveDependencies — import specifiers', () => {
  let db: Database.Database;
  let dir: string;
  let indexer: Indexer;

  const edges = (): string[] =>
    (db
      .prepare(
        `SELECT f1.path AS a, f2.path AS b, d.symbol_name AS s FROM dependencies d
         JOIN files f1 ON d.from_file = f1.id JOIN files f2 ON d.to_file = f2.id
         ORDER BY a, b, s`,
      )
      .all() as Array<{ a: string; b: string; s: string }>).map((r) => `${r.a}->${r.b}:${r.s}`);

  const addFile = (path: string, content = 'export const x = 1;'): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
    upsertFile(db, { path, language: 'typescript', hash: path + content, rawTokenEstimate: 1, summary: null });
  };

  beforeEach(() => {
    db = createTestDb();
    dir = join(tmpdir(), `pindex-edges-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, 'src'), { recursive: true });
    indexer = new Indexer({ db, projectRoot: dir });
  });

  it('maps a .js specifier to the .ts file', async () => {
    addFile('src/a.ts');
    addFile('src/b.ts');
    await indexer.resolveDependencies(new Map([['src/a.ts', [{ source: './b.js', symbols: ['b'] }]]]));
    expect(edges()).toEqual(['src/a.ts->src/b.ts:b']);
  });

  it('maps a .js specifier to a .tsx file', async () => {
    addFile('src/a.ts');
    addFile('src/c.tsx');
    await indexer.resolveDependencies(new Map([['src/a.ts', [{ source: './c.js', symbols: ['c'] }]]]));
    expect(edges()).toEqual(['src/a.ts->src/c.tsx:c']);
  });

  it('prefers the exact .js file over the .ts sibling', async () => {
    addFile('src/a.ts');
    addFile('src/d.js');
    addFile('src/d.ts');
    await indexer.resolveDependencies(new Map([['src/a.ts', [{ source: './d.js', symbols: ['d'] }]]]));
    expect(edges()).toEqual(['src/a.ts->src/d.js:d']);
  });

  it('resolves a directory import to index.tsx', async () => {
    addFile('src/a.ts');
    addFile('src/dir/index.tsx');
    await indexer.resolveDependencies(new Map([['src/a.ts', [{ source: './dir', symbols: ['x'] }]]]));
    expect(edges()).toEqual(['src/a.ts->src/dir/index.tsx:x']);
  });

  it('keeps edges of every importer of the same target', async () => {
    addFile('src/a.ts');
    addFile('src/z.ts');
    addFile('src/b.ts');
    await indexer.resolveDependencies(
      new Map([
        ['src/a.ts', [{ source: './b.js', symbols: ['b'] }]],
        ['src/z.ts', [{ source: './b.js', symbols: ['b'] }]],
      ]),
    );
    expect(edges()).toEqual(['src/a.ts->src/b.ts:b', 'src/z.ts->src/b.ts:b']);
  });

  it('does not wipe incoming edges when the target is re-indexed', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), `import { b } from './b.js';`);
    writeFileSync(join(dir, 'src', 'b.ts'), `export const b = 1;`);
    await indexer.indexFile('src/a.ts');
    await indexer.indexFile('src/b.ts');
    await indexer.resolveDependencies(new Map([['src/a.ts', [{ source: './b.js', symbols: ['b'] }]]]));
    expect(edges()).toEqual(['src/a.ts->src/b.ts:b']);

    writeFileSync(join(dir, 'src', 'b.ts'), `export const b = 2;`);
    await indexer.indexFile('src/b.ts', true);
    expect(edges()).toEqual(['src/a.ts->src/b.ts:b']);
  });
});


describe('Indexer.indexAll pruning', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = createTestDb();
    dir = createTempProject();
  });

  function snapshotCount(path: string): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM ast_snapshots WHERE file_path = ?').get(path) as { c: number }).c;
  }

  it('removes rows (and ast_snapshots) for files deleted from disk', async () => {
    const indexer = new Indexer({ db, projectRoot: dir });
    await indexer.indexAll();
    // indexing records AST snapshots; make sure at least one exists
    if (snapshotCount('src/service.ts') === 0) {
      db.prepare(
        `INSERT INTO ast_snapshots (file_path, symbol_name, kind, signature, signature_hash) VALUES (?, ?, ?, ?, ?)`,
      ).run('src/service.ts', 'MyService', 'class', 'class MyService', 'h');
    }
    expect(snapshotCount('src/service.ts')).toBeGreaterThan(0);

    rmSync(join(dir, 'src', 'service.ts'));
    const result = await indexer.indexAll();

    expect(result.removed).toBe(1);
    expect(getFileByPath(db, 'src/service.ts')).toBeNull();
    expect(getFileByPath(db, 'src/index.ts')).not.toBeNull();
    expect(snapshotCount('src/service.ts')).toBe(0);
  });

  it('does not prune when the glob finds no files', async () => {
    const indexer = new Indexer({ db, projectRoot: dir });
    await indexer.indexAll();
    const before = getAllFiles(db).length;

    rmSync(join(dir, 'src'), { recursive: true });
    const result = await indexer.indexAll();

    expect(result.removed).toBe(0);
    expect(getAllFiles(db)).toHaveLength(before);
  });

  it('does not prune files that still exist on disk but are outside the glob', async () => {
    const indexer = new Indexer({ db, projectRoot: dir });
    await indexer.indexAll();
    upsertFile(db, { path: 'src/extra.rb', language: 'ruby', hash: 'x', rawTokenEstimate: 1, summary: null });
    writeFileSync(join(dir, 'src', 'extra.rb'), 'x = 1');

    const result = await indexer.indexAll();
    expect(result.removed).toBe(0);
    expect(getFileByPath(db, 'src/extra.rb')).not.toBeNull();
  });

  it('exposes ignorePatterns', () => {
    const indexer = new Indexer({ db, projectRoot: dir });
    expect(indexer.ignorePatterns).toContain('**/node_modules/**');
  });
});
