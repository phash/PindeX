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
});
