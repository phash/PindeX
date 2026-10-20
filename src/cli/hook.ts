import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { findProjectRoot, getProjectIndexPath, getPindexHome } from './project-detector.js';
import { hashContent, isDocumentLanguage } from '../indexer/parser.js';
import { resolveWithinRoot, normalizeRelPath } from '../util/paths.js';

export interface HookIO {
  stdin: string;
  env: NodeJS.ProcessEnv;
  /** Per-session strict-mode state; default `<pindex home>/hook-state`. */
  stateDir?: string;
}

const MAX_SYMBOLS = 40;
const HINT = 'Use get_context(file, line) or Read with offset/limit for the part you need.';

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; offset?: unknown; limit?: unknown };
}

function buildOutline(db: Database.Database, fileId: number, rel: string, content: string): string {
  const rows = db
    .prepare('SELECT name, kind, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line, id')
    .all(fileId) as { name: string; kind: string; start_line: number; end_line: number }[];
  const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  const shown = rows.slice(0, MAX_SYMBOLS).map((s) => `${s.name}(${s.kind})@${s.start_line}-${s.end_line}`);
  if (rows.length > MAX_SYMBOLS) shown.push(`… +${rows.length - MAX_SYMBOLS} more`);
  return `[PindeX] ${rel} (${lines} lines est.) symbols: ${shown.join(', ')}\n${HINT}`;
}

/** Strict mode: true the first time `rel` is seen in this session (and records it). */
function firstFullRead(stateDir: string, sessionId: string, rel: string): boolean {
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'session';
  const file = join(stateDir, `${safeId}.json`);
  let seen: string[] = [];
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (Array.isArray(parsed)) seen = parsed.filter((x): x is string => typeof x === 'string');
  }
  if (seen.includes(rel)) return false;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify([...seen, rel]), 'utf-8');
  return true;
}

/**
 * Claude Code PreToolUse hook: when the agent reads a whole indexed source file, injects a
 * compact symbol outline (or, with PINDEX_HOOK_STRICT=1, denies the first such read per
 * session). Returns the stdout text; '' means "say nothing". Fails open on any error.
 */
export function runPreToolUseHook(io: HookIO): string {
  let db: Database.Database | null = null;
  try {
    const input = JSON.parse(io.stdin) as HookInput;
    if (input.tool_name !== 'Read') return '';
    const ti = input.tool_input;
    if (!ti || typeof ti.file_path !== 'string') return '';
    if (ti.offset !== undefined || ti.limit !== undefined) return '';

    const root = findProjectRoot(input.cwd ?? process.cwd());
    const abs = isAbsolute(ti.file_path) ? ti.file_path : join(input.cwd ?? root, ti.file_path);
    const rel = normalizeRelPath(relative(root, abs));
    if (!rel || resolveWithinRoot(root, rel) === null || rel.startsWith('..')) return '';

    db = new Database(getProjectIndexPath(root), { readonly: true, fileMustExist: true });
    const file = db.prepare('SELECT id, language, hash FROM files WHERE path = ?').get(rel) as
      | { id: number; language: string; hash: string | null }
      | undefined;
    if (!file || isDocumentLanguage(file.language)) return '';

    const content = readFileSync(abs, 'utf-8');
    if (hashContent(content) !== file.hash) return '';

    const outline = buildOutline(db, file.id, rel, content);
    if (io.env.PINDEX_HOOK_STRICT === '1') {
      const stateDir = io.stateDir ?? join(getPindexHome(), 'hook-state');
      if (firstFullRead(stateDir, input.session_id ?? '', rel)) {
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: outline,
          },
        });
      }
    }
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: outline },
    });
  } catch {
    return '';
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
