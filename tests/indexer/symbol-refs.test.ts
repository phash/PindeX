import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ParsedFile } from '../../src/types.js';

vi.mock('../../src/indexer/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/indexer/parser.js')>();
  return { ...actual, parseFile: vi.fn() };
});

import { parseFile } from '../../src/indexer/parser.js';
import { createTestDb } from '../helpers/db.js';
import { Indexer } from '../../src/indexer/index.js';
import { getAllRefs } from '../../src/db/queries.js';

function parsed(partial: Partial<ParsedFile>): ParsedFile {
  return { language: 'typescript', symbols: [], imports: [], references: [], rawTokenEstimate: 1, ...partial };
}

const sym = (name: string, startLine: number, endLine: number) => ({
  name, kind: 'method' as const, signature: `${name}()`, startLine, endLine,
  isExported: false, isAsync: false, hasTryCatch: false,
});

describe('Indexer symbol_refs persistence', () => {
  let db: Database.Database;
  let dir: string;
  let indexer: Indexer;

  beforeEach(() => {
    vi.mocked(parseFile).mockReset();
    db = createTestDb();
    dir = mkdtempSync(join(tmpdir(), 'pindex-refs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'v1');
    indexer = new Indexer({ db, projectRoot: dir });
  });

  it('stores refs with the right caller for same-named methods in different classes', async () => {
    vi.mocked(parseFile).mockReturnValue(parsed({
      symbols: [sym('run', 2, 4), sym('run', 10, 12)],
      references: [
        { callee: 'p', receiver: null, kind: 'call', line: 3, caller: 'run', callerLine: 2 },
        { callee: 'q', receiver: 'this', kind: 'call', line: 11, caller: 'run', callerLine: 10 },
        { callee: 'Top', receiver: null, kind: 'new', line: 20, caller: null, callerLine: null },
      ],
    }));
    await indexer.indexFile('src/a.ts');
    const rows = getAllRefs(db);
    expect(rows).toHaveLength(3);
    const startLineOf = (id: number | null) =>
      id === null ? null : (db.prepare('SELECT start_line FROM symbols WHERE id = ?').get(id) as { start_line: number }).start_line;
    expect(startLineOf(rows.find((r) => r.callee_name === 'p')!.caller_symbol_id)).toBe(2);
    expect(startLineOf(rows.find((r) => r.callee_name === 'q')!.caller_symbol_id)).toBe(10);
    expect(rows.find((r) => r.callee_name === 'Top')).toMatchObject({ caller_symbol_id: null, kind: 'new' });
  });

  it('re-index with no references clears the old refs for that file', async () => {
    vi.mocked(parseFile).mockReturnValue(parsed({
      symbols: [sym('f', 1, 3)],
      references: [{ callee: 'g', receiver: null, kind: 'call', line: 2, caller: 'f', callerLine: 1 }],
    }));
    await indexer.indexFile('src/a.ts');
    expect(getAllRefs(db)).toHaveLength(1);

    writeFileSync(join(dir, 'src', 'a.ts'), 'v2');
    vi.mocked(parseFile).mockReturnValue(parsed({ symbols: [sym('f', 1, 3)] }));
    await indexer.indexFile('src/a.ts');
    expect(getAllRefs(db).filter((r) => r.file_path === 'src/a.ts')).toHaveLength(0);
  });

  it('a file that grows past MAX_FILE_SIZE is skipped and keeps its previous refs', async () => {
    vi.mocked(parseFile).mockReturnValue(parsed({
      symbols: [sym('f', 1, 3)],
      references: [{ callee: 'g', receiver: null, kind: 'call', line: 2, caller: 'f', callerLine: 1 }],
    }));
    await indexer.indexFile('src/a.ts');

    writeFileSync(join(dir, 'src', 'a.ts'), 'x'.repeat(1024 * 1024 + 1));
    const res = await indexer.indexFile('src/a.ts');
    expect(res.status).toBe('skipped');
    expect(getAllRefs(db)).toHaveLength(1);
  });
});

describe('Indexer summary reuse after the v6 forced re-parse (hash NULL)', () => {
  it('reuses file and same-name symbol summaries instead of re-summarizing', async () => {
    const { Summarizer } = await import('../../src/indexer/summarizer.js');
    const fileSpy = vi.spyOn(Summarizer.prototype, 'summarizeFile').mockResolvedValue('file summary');
    const symSpy = vi.spyOn(Summarizer.prototype, 'summarizeSymbol')
      .mockImplementation(async (signature: string) => `sum ${signature}`);
    try {
      const db = createTestDb();
      const dir = mkdtempSync(join(tmpdir(), 'pindex-reuse-'));
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'v1');
      const indexer = new Indexer({ db, projectRoot: dir, generateSummaries: true });

      vi.mocked(parseFile).mockReturnValue(parsed({ symbols: [sym('keep', 1, 2)] }));
      await indexer.indexFile('src/a.ts');
      expect(fileSpy).toHaveBeenCalledTimes(1);
      expect(symSpy).toHaveBeenCalledTimes(1);
      db.prepare("UPDATE symbols SET summary = 'old keep'").run();

      db.prepare('UPDATE files SET hash = NULL').run();
      vi.mocked(parseFile).mockReturnValue(parsed({ symbols: [sym('keep', 1, 2), sym('fresh', 4, 5)] }));
      await indexer.indexFile('src/a.ts');

      expect(fileSpy).toHaveBeenCalledTimes(1);
      expect(symSpy).toHaveBeenCalledTimes(2);
      expect(symSpy).toHaveBeenLastCalledWith('fresh()', expect.any(String));
      const rows = db.prepare('SELECT name, summary FROM symbols ORDER BY start_line').all();
      expect(rows).toEqual([{ name: 'keep', summary: 'old keep' }, { name: 'fresh', summary: 'sum fresh()' }]);
      expect(db.prepare('SELECT summary, hash FROM files').get()).toEqual({ summary: 'file summary', hash: expect.any(String) });

      // A real content change (non-null hash) re-summarizes as before.
      writeFileSync(join(dir, 'src', 'a.ts'), 'v2');
      await indexer.indexFile('src/a.ts');
      expect(fileSpy).toHaveBeenCalledTimes(2);
    } finally {
      fileSpy.mockRestore();
      symSpy.mockRestore();
    }
  });
});
