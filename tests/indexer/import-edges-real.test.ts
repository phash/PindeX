import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Real tree-sitter so indexFile() produces actual import lists.
vi.unmock('tree-sitter');
vi.unmock('tree-sitter-typescript');

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { Indexer } from '../../src/indexer/index.js';

describe('import edges are rebuilt on single-file reindex (real parser)', () => {
  let db: Database.Database;
  let root: string;

  const edgeCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM dependencies').get() as { n: number }).n;

  beforeEach(() => {
    db = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'pindex-edges-real-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), `import { b } from './b.js';\nexport const a = b;\n`);
    writeFileSync(join(root, 'src', 'b.ts'), `export const b = 1;\n`);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps a->b after b changes and re-creates it after a is re-indexed', async () => {
    const indexer = new Indexer({ db, projectRoot: root });
    await indexer.indexAll();
    await indexer.resolveDependencies();
    expect(edgeCount()).toBe(1);

    writeFileSync(join(root, 'src', 'b.ts'), `export const b = 2;\n`);
    await indexer.indexFile('src/b.ts', true);
    expect(edgeCount()).toBe(1);

    writeFileSync(join(root, 'src', 'a.ts'), `import { b } from './b.js';\nexport const a = b + 1;\n`);
    await indexer.indexFile('src/a.ts', true);
    expect(edgeCount()).toBe(1);
  });

  it('resolveImportersOf links an earlier unresolved import once the target file is added', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), `import { c } from './c.js';\nexport const a = c;\n`);
    const indexer = new Indexer({ db, projectRoot: root });
    await indexer.indexAll();
    await indexer.resolveDependencies();
    expect(edgeCount()).toBe(0); // c.ts does not exist yet

    writeFileSync(join(root, 'src', 'c.ts'), `export const c = 1;\n`);
    expect((await indexer.indexFile('src/c.ts')).status).toBe('indexed');
    indexer.resolveImportersOf('src/c.ts');

    const edge = db.prepare(
      `SELECT f1.path AS a, f2.path AS b FROM dependencies d
       JOIN files f1 ON d.from_file = f1.id JOIN files f2 ON d.to_file = f2.id`,
    ).all() as Array<{ a: string; b: string }>;
    expect(edge).toEqual([{ a: 'src/a.ts', b: 'src/c.ts' }]);
  });

  it('resolveImportersOf ignores importers that were forgotten (deleted)', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), `import { c } from './c.js';\nexport const a = c;\n`);
    const indexer = new Indexer({ db, projectRoot: root });
    await indexer.indexAll();
    await indexer.resolveDependencies();
    indexer.forgetFile('src/a.ts');

    writeFileSync(join(root, 'src', 'c.ts'), `export const c = 1;\n`);
    await indexer.indexFile('src/c.ts');
    indexer.resolveImportersOf('src/c.ts');
    expect(edgeCount()).toBe(0);
  });
});

