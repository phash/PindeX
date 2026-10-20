import type Database from 'better-sqlite3';
import { getAllRefs, getSymbolsByName, type SymbolRefRow } from '../db/queries.js';

/** EXTRACTED = resolved via the caller's own file or an import; INFERRED = unique name project-wide
 *  (for member calls on another object additionally: same file or an import relation to its file). */
export type Confidence = 'EXTRACTED' | 'INFERRED';

export interface SymbolNode {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
}

export interface CallEdge {
  /** Enclosing symbol of the call site; null for module-level calls. */
  from: SymbolNode | null;
  fromFile: string;
  to: SymbolNode;
  line: number;
  confidence: Confidence;
  /** Call site was a member call on some other object (`x.f()`, x ≠ this). */
  foreignReceiver: boolean;
}

export interface ResolveResult {
  edges: CallEdge[];
  /** Refs whose callee name has several definitions and no same-file/import hint. */
  ambiguous: number;
}

/** Kinds a call or `new` can target; interfaces, types, enums etc. never resolve. */
export const CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'class', 'const']);

/** Common method names of built-in/library objects (arrays, strings, maps, promises, streams,
 *  sqlite statements, emitters). Member calls with these names on a foreign receiver are too
 *  noisy for structural ranking (hubs, community weights); find_usages still reports them. */
export const BUILTIN_METHOD_NAMES: ReadonlySet<string> = new Set([
  'filter', 'map', 'forEach', 'reduce', 'find', 'some', 'every', 'includes', 'indexOf',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'split', 'replace',
  'trim', 'toString', 'get', 'set', 'has', 'delete', 'add', 'clear', 'keys', 'values',
  'entries', 'all', 'run', 'prepare', 'exec', 'log', 'warn', 'error', 'then', 'catch',
  'finally', 'emit', 'on', 'once', 'write', 'end', 'close', 'send',
]);

interface SymbolIndex {
  /** All symbols (callers may be of any kind). */
  byId: Map<number, SymbolNode>;
  /** Symbol id → file id. */
  fileOf: Map<number, number>;
  /** `${fileId}\0${name}` → callable symbols, in deterministic candidate order. */
  byFileAndName: Map<string, SymbolNode[]>;
  /** name → callable symbols. */
  byName: Map<string, SymbolNode[]>;
}

interface ImportIndex {
  /** `${fromFile}\0${symbolName}` → imported-from file ids. */
  byName: Map<string, number[]>;
  /** `${fromFile}>${toFile}` for every dependency row (any symbol). */
  filePairs: Set<string>;
}

const key = (fileId: number, name: string): string => `${fileId}\0${name}`;

function pushTo<K, V>(map: Map<K, V[]>, k: K, v: V): void {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

function loadSymbols(db: Database.Database): SymbolIndex {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.file_id, s.start_line, f.path AS file_path
       FROM symbols s JOIN files f ON s.file_id = f.id
       ORDER BY s.is_exported DESC, f.path ASC, s.start_line ASC`,
    )
    .all() as Array<{ id: number; name: string; kind: string; file_id: number; start_line: number | null; file_path: string }>;

  const index: SymbolIndex = { byId: new Map(), fileOf: new Map(), byFileAndName: new Map(), byName: new Map() };
  for (const r of rows) {
    const node: SymbolNode = { id: r.id, name: r.name, kind: r.kind, file: r.file_path, line: r.start_line ?? 0 };
    index.byId.set(node.id, node);
    index.fileOf.set(node.id, r.file_id);
    if (!CALLABLE_KINDS.has(r.kind)) continue;
    pushTo(index.byFileAndName, key(r.file_id, r.name), node);
    pushTo(index.byName, r.name, node);
  }
  return index;
}

function loadImports(db: Database.Database): ImportIndex {
  const rows = db
    .prepare('SELECT from_file, to_file, symbol_name FROM dependencies ORDER BY id')
    .all() as Array<{ from_file: number; to_file: number; symbol_name: string | null }>;
  const imports: ImportIndex = { byName: new Map(), filePairs: new Set() };
  for (const r of rows) {
    imports.filePairs.add(`${r.from_file}>${r.to_file}`);
    if (r.symbol_name !== null) pushTo(imports.byName, key(r.from_file, r.symbol_name), r.to_file);
  }
  return imports;
}

/** True for `arr.filter()`-style edges whose callee name is a common built-in method —
 *  usually an unrelated library call that merely shares a project method's name. */
export function isBuiltinMethodNoise(edge: CallEdge): boolean {
  return edge.foreignReceiver && BUILTIN_METHOD_NAMES.has(edge.to.name);
}

/** Member call on some other object (`date.format()`), i.e. receiver type unknown. */
export function isForeignReceiver(receiver: string | null): boolean {
  return receiver !== null && receiver !== 'this';
}

function resolveOne(
  ref: SymbolRefRow,
  symbols: SymbolIndex,
  imports: ImportIndex,
): { to: SymbolNode; confidence: Confidence } | 'ambiguous' | null {
  // Member call on some other object (`date.format()`): its type is unknown, so
  // same-file and import hints don't apply — only a unique name can resolve it.
  const foreign = isForeignReceiver(ref.receiver);
  if (!foreign) {
    const hit = resolveLocally(ref, symbols, imports);
    if (hit) return { to: hit, confidence: 'EXTRACTED' };
  }

  // (3) exactly one definition project-wide
  const global = symbols.byName.get(ref.callee_name) ?? [];
  if (global.length > 1) return 'ambiguous';
  if (global.length === 0) return null;
  const target = global[0];
  // `arr.filter()` must not land on some unrelated `RepoSet.filter`: a foreign receiver
  // only resolves when the caller's file is the target's file or depends on it.
  if (foreign) {
    const targetFile = symbols.fileOf.get(target.id);
    const related = targetFile === ref.file_id || imports.filePairs.has(`${ref.file_id}>${targetFile}`);
    if (!related) return null;
  }
  return { to: target, confidence: 'INFERRED' };
}

/** Steps (1) same file and (2) import. */
function resolveLocally(
  ref: SymbolRefRow,
  symbols: SymbolIndex,
  imports: ImportIndex,
): SymbolNode | null {
  // (1) defined in the caller's own file (`this.x()` only matches methods)
  const local = symbols.byFileAndName.get(key(ref.file_id, ref.callee_name)) ?? [];
  const sameFile = ref.receiver === 'this' ? local.filter((s) => s.kind === 'method') : local;
  if (sameFile.length > 0) return sameFile[0];

  // (2) imported by name from a file that defines it
  for (const toFile of imports.byName.get(key(ref.file_id, ref.callee_name)) ?? []) {
    const target = symbols.byFileAndName.get(key(toFile, ref.callee_name));
    if (target && target.length > 0) return target[0];
  }
  return null;
}

/** Resolves call references to their target symbols. Pure: reads symbols and
 *  dependencies once, no per-ref SQL. Refs with no known definition are dropped
 *  silently (externals, built-ins); refs with several candidates count as ambiguous. */
export function resolveRefs(db: Database.Database, refs: SymbolRefRow[]): ResolveResult {
  if (refs.length === 0) return { edges: [], ambiguous: 0 };
  const symbols = loadSymbols(db);
  const imports = loadImports(db);

  const edges: CallEdge[] = [];
  let ambiguous = 0;
  for (const ref of refs) {
    const resolved = resolveOne(ref, symbols, imports);
    if (resolved === 'ambiguous') ambiguous++;
    if (resolved === null || resolved === 'ambiguous') continue;
    edges.push({
      from: ref.caller_symbol_id !== null ? (symbols.byId.get(ref.caller_symbol_id) ?? null) : null,
      fromFile: ref.file_path,
      to: resolved.to,
      line: ref.line,
      confidence: resolved.confidence,
      foreignReceiver: isForeignReceiver(ref.receiver),
    });
  }
  return { edges, ambiguous };
}

export function buildCallGraph(db: Database.Database): ResolveResult {
  return resolveRefs(db, getAllRefs(db));
}

/** Callable definitions of `name` (see CALLABLE_KINDS), optionally restricted to one
 *  (normalized) file path. Order: exported first, then path, then start line. */
export function findSymbolCandidates(db: Database.Database, name: string, file?: string): SymbolNode[] {
  return getSymbolsByName(db, name, file).filter((s) => CALLABLE_KINDS.has(s.kind)).map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    file: s.file_path,
    line: s.start_line ?? 0,
  }));
}

/** Shortest directed call chain `fromId → … → toId` of at most `maxDepth` edges (BFS,
 *  so cycles terminate). Module-level edges (`from === null`) are not traversable.
 *  Returns null when unreachable within the depth; `[]` when `fromId === toId`. */
export function shortestPath(
  edges: CallEdge[],
  fromId: number,
  toId: number,
  maxDepth: number,
): CallEdge[] | null {
  if (fromId === toId) return [];
  const outgoing = new Map<number, CallEdge[]>();
  for (const e of edges) if (e.from) pushTo(outgoing, e.from.id, e);

  const via = new Map<number, CallEdge>(); // node → edge that first reached it
  const seen = new Set<number>([fromId]);
  let frontier = [fromId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const e of outgoing.get(id) ?? []) {
        if (seen.has(e.to.id)) continue;
        seen.add(e.to.id);
        via.set(e.to.id, e);
        if (e.to.id === toId) {
          const path: CallEdge[] = [];
          for (let cur: CallEdge | undefined = e; cur; cur = cur.from ? via.get(cur.from.id) : undefined) {
            path.unshift(cur);
            if (cur.from?.id === fromId) break;
          }
          return path;
        }
        next.push(e.to.id);
      }
    }
    frontier = next;
  }
  return null;
}
