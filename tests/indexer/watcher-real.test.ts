/**
 * FileWatcher on real chokidar 4 (no glob support) + real Indexer.
 * Verifies that the watch-filter reproduces the old glob behaviour end to end:
 * watched files are (re)indexed and removed, ignored and dot directories stay silent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Real chokidar (the unit setup mocks it) and real tree-sitter, so this runs end to end.
vi.unmock('chokidar');
vi.unmock('tree-sitter');
vi.unmock('tree-sitter-typescript');

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { Indexer } from '../../src/indexer/index.js';
import { FileWatcher, type FileChangeEvent } from '../../src/indexer/watcher.js';
import { getFileByPath, getSymbolsByFileId } from '../../src/db/queries.js';

async function waitFor(check: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
}

describe('FileWatcher on real chokidar 4', () => {
  let root: string;
  let db: Database.Database;
  let indexer: Indexer;
  let watcher: FileWatcher;
  let events: FileChangeEvent[];

  const edges = (): Array<{ a: string; b: string }> =>
    db.prepare(
      `SELECT f1.path AS a, f2.path AS b FROM dependencies d
       JOIN files f1 ON d.from_file = f1.id JOIN files f2 ON d.to_file = f2.id`,
    ).all() as Array<{ a: string; b: string }>;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pindex-watch-')));
    write(root, 'src/a.ts', `import { b } from './b.js';\nexport const a = () => b;\n`);
    write(root, 'node_modules/pkg/index.ts', 'export const dep = 1;\n');
    write(root, '.git/HEAD', 'ref: refs/heads/main\n');

    db = createTestDb();
    indexer = new Indexer({ db, projectRoot: root });
    await indexer.indexAll();
    await indexer.resolveDependencies();

    watcher = new FileWatcher({ db, indexer, projectRoot: root });
    events = [];
    watcher.on('change', (e: FileChangeEvent) => events.push(e));
    await watcher.start();
    await watcher.whenReady();
  });

  afterEach(async () => {
    await watcher.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('indexes an added file and links the earlier unresolved import to it', async () => {
    expect(edges()).toEqual([]);
    write(root, 'src/b.ts', 'export const b = 2;\n');

    await waitFor(() => getFileByPath(db, 'src/b.ts') != null, 'src/b.ts indexed');
    await waitFor(() => edges().length === 1, 'a -> b edge');
    expect(edges()).toEqual([{ a: 'src/a.ts', b: 'src/b.ts' }]);
  });

  it('re-indexes a changed file', async () => {
    write(root, 'src/a.ts', 'export function renamedFn() { return 1; }\n');

    await waitFor(() => {
      const f = getFileByPath(db, 'src/a.ts');
      return !!f && getSymbolsByFileId(db, f.id).some((s) => s.name === 'renamedFn');
    }, 'renamedFn symbol');
  });

  it('removes a deleted file from the index', async () => {
    expect(getFileByPath(db, 'src/a.ts')).not.toBeNull();
    rmSync(join(root, 'src/a.ts'));

    await waitFor(() => getFileByPath(db, 'src/a.ts') == null, 'src/a.ts removed');
  });

  it('picks up files in directories created after the watcher started', async () => {
    write(root, 'src/feature/deep/new.ts', 'export const fresh = true;\n');

    await waitFor(() => getFileByPath(db, 'src/feature/deep/new.ts') != null, 'nested file');
  });

  it('indexes added documents', async () => {
    write(root, 'docs/notes.md', '# Notes\n\nSome text.\n');

    await waitFor(() => getFileByPath(db, 'docs/notes.md') != null, 'docs/notes.md');
  });

  it('stays silent for ignored dirs, dot dirs and non-matching files', async () => {
    write(root, 'node_modules/pkg/extra.ts', 'export const x = 1;\n');
    write(root, 'packages/app/node_modules/dep/a.ts', 'export const y = 1;\n');
    write(root, 'dist/out.js', 'module.exports = 1;\n');
    write(root, '.git/objects/a.ts', 'x\n');
    write(root, '.pindex/notes.md', '# hidden\n');
    write(root, 'src/types.d.ts', 'export type T = 1;\n');
    write(root, 'assets/logo.png', 'png');
    rmSync(join(root, 'node_modules/pkg/index.ts'));
    // Sentinel: once it arrives, every earlier event has been delivered as well.
    write(root, 'src/sentinel.ts', 'export const s = 1;\n');

    await waitFor(() => events.some((e) => e.path === 'src/sentinel.ts'), 'sentinel event');
    expect(events.map((e) => e.path)).toEqual(['src/sentinel.ts']);
    expect(getFileByPath(db, 'node_modules/pkg/extra.ts')).toBeNull();
    expect(getFileByPath(db, 'src/types.d.ts')).toBeNull();
  });
});
