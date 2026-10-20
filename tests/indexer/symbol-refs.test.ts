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
