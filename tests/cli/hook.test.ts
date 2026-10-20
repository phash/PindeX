import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { hashContent } from '../../src/indexer/parser.js';
import { runPreToolUseHook } from '../../src/cli/hook.js';

const SRC = 'export function alpha() {}\nexport function beta() {}\n';

describe('runPreToolUseHook', () => {
  let root: string;
  let stateDir: string;

  function index(rel: string, content: string, language = 'typescript', symbols = 2): void {
    const db = new Database(join(root, '.pindex', 'index.db'));
    runMigrations(db);
    const info = db
      .prepare('INSERT INTO files (path, language, hash, raw_token_estimate) VALUES (?, ?, ?, 10)')
      .run(rel, language, hashContent(content));
    for (let i = 0; i < symbols; i++) {
      db.prepare(
        "INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line) VALUES (?, ?, 'function', 'sig', ?, ?)",
      ).run(info.lastInsertRowid, i === 0 ? 'alpha' : i === 1 ? 'beta' : `sym${i}`, i + 1, i + 1);
    }
    db.close();
  }

  function stdin(over: Record<string, unknown> = {}, input: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: 's1',
      cwd: root,
      tool_name: 'Read',
      tool_input: { file_path: join(root, 'src', 'a.ts'), ...input },
      ...over,
    });
  }

  const run = (s: string, env: NodeJS.ProcessEnv = {}) => runPreToolUseHook({ stdin: s, env, stateDir });

  beforeEach(() => {
    root = join(tmpdir(), `pindex-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    stateDir = join(root, '_state');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.pindex'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'src', 'a.ts'), SRC);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('injects an outline for a full read of a fresh indexed file', () => {
    index('src/a.ts', SRC);
    const out = JSON.parse(run(stdin()));
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('src/a.ts');
    expect(ctx).toContain('alpha(function)@1-1');
    expect(ctx).toContain('get_context');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('caps the outline at 40 symbols with a "+N more" suffix', () => {
    index('src/a.ts', SRC, 'typescript', 45);
    const ctx: string = JSON.parse(run(stdin())).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('… +5 more');
    expect(ctx).not.toContain('sym44');
  });

  it('says nothing for a targeted read (offset or limit)', () => {
    index('src/a.ts', SRC);
    expect(run(stdin({}, { offset: 10 }))).toBe('');
    expect(run(stdin({}, { limit: 20 }))).toBe('');
  });

  it('fails open on every unusable input', () => {
    expect(run(stdin())).toBe(''); // DB missing
    index('src/a.ts', SRC);
    expect(run(stdin({ tool_name: 'Grep' }))).toBe('');
    expect(run('not json')).toBe('');
    expect(run(stdin({}, { file_path: '/etc/passwd' }))).toBe('');
    expect(run(stdin({}, { file_path: join(root, 'src', 'b.ts') }))).toBe(''); // not indexed
  });

  it('says nothing for indexed documents', () => {
    writeFileSync(join(root, 'README.md'), '# x');
    index('README.md', '# x', 'markdown');
    expect(run(stdin({}, { file_path: join(root, 'README.md') }))).toBe('');
  });

  it('says nothing when the file changed after indexing', () => {
    index('src/a.ts', SRC);
    writeFileSync(join(root, 'src', 'a.ts'), SRC + 'export const c = 1;\n');
    expect(run(stdin())).toBe('');
  });

  it('strict mode denies the first full read per session and file, then advises', () => {
    index('src/a.ts', SRC);
    const env = { PINDEX_HOOK_STRICT: '1' };
    const first = JSON.parse(run(stdin(), env)).hookSpecificOutput;
    expect(first.permissionDecision).toBe('deny');
    expect(first.permissionDecisionReason).toContain('alpha(function)');
    const second = JSON.parse(run(stdin(), env)).hookSpecificOutput;
    expect(second.permissionDecision).toBeUndefined();
    expect(second.additionalContext).toContain('src/a.ts');
    const other = JSON.parse(run(stdin({ session_id: 's2' }), env)).hookSpecificOutput;
    expect(other.permissionDecision).toBe('deny');
  });
});
