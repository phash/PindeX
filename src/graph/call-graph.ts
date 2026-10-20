import type Database from 'better-sqlite3';
import { getAllRefs, getSymbolsByName, type SymbolRefRow } from '../db/queries.js';

/** EXTRACTED = resolved via the caller's own file or an import; INFERRED = unique name project-wide. */
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
}

export interface ResolveResult {
  edges: CallEdge[];
  /** Refs whose callee name has several definitions and no same-file/import hint. */
  ambiguous: number;
}

interface SymbolIndex {
  byId: Map<number, SymbolNode>;
  /** `${fileId}\0${name}` → symbols, in deterministic candidate order. */
  byFileAndName: Map<string, SymbolNode[]>;
  byName: Map<string, SymbolNode[]>;
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

  const index: SymbolIndex = { byId: new Map(), byFileAndName: new Map(), byName: new Map() };
  for (const r of rows) {
    const node: SymbolNode = { id: r.id, name: r.name, kind: r.kind, file: r.file_path, line: r.start_line ?? 0 };
    index.byId.set(node.id, node);
    pushTo(index.byFileAndName, key(r.file_id, r.name), node);
    pushTo(index.byName, r.name, node);
  }
  return index;
}

/** `${fromFile}\0${symbolName}` → imported-from file ids. */
function loadImports(db: Database.Database): Map<string, number[]> {
  const rows = db
    .prepare('SELECT from_file, to_file, symbol_name FROM dependencies WHERE symbol_name IS NOT NULL ORDER BY id')
    .all() as Array<{ from_file: number; to_file: number; symbol_name: string }>;
  const imports = new Map<string, number[]>();
  for (const r of rows) pushTo(imports, key(r.from_file, r.symbol_name), r.to_file);
  return imports;
}

function resolveOne(
  ref: SymbolRefRow,
  symbols: SymbolIndex,
  imports: Map<string, number[]>,
): { to: SymbolNode; confidence: Confidence } | 'ambiguous' | null {
  // (1) defined in the caller's own file (`this.x()` only matches methods)
  const local = symbols.byFileAndName.get(key(ref.file_id, ref.callee_name)) ?? [];
  const sameFile = ref.receiver === 'this' ? local.filter((s) => s.kind === 'method') : local;
  if (sameFile.length > 0) return { to: sameFile[0], confidence: 'EXTRACTED' };

  // (2) imported by name from a file that defines it
  for (const toFile of imports.get(key(ref.file_id, ref.callee_name)) ?? []) {
    const target = symbols.byFileAndName.get(key(toFile, ref.callee_name));
    if (target && target.length > 0) return { to: target[0], confidence: 'EXTRACTED' };
  }

  // (3) exactly one definition project-wide
  const global = symbols.byName.get(ref.callee_name) ?? [];
  if (global.length === 1) return { to: global[0], confidence: 'INFERRED' };
  return global.length > 1 ? 'ambiguous' : null;
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
    });
  }
  return { edges, ambiguous };
}

export function buildCallGraph(db: Database.Database): ResolveResult {
  return resolveRefs(db, getAllRefs(db));
}

/** Definitions of `name`, optionally restricted to one (normalized) file path.
 *  Order: exported first, then path, then start line. */
export function findSymbolCandidates(db: Database.Database, name: string, file?: string): SymbolNode[] {
  return getSymbolsByName(db, name, file).map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    file: s.file_path,
    line: s.start_line,
  }));
}
