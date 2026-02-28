import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ParsedSymbol } from '../types.js';
import {
  getSnapshotsByFile,
  upsertAstSnapshot,
  deleteSnapshotsByFile,
} from '../db/queries.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SymbolChangeType = 'added' | 'removed' | 'sig_changed';

export interface SymbolChange {
  type: SymbolChangeType;
  name: string;
  kind: string;
  oldSignature?: string;
  newSignature?: string;
  /** Human-readable description suitable for an observation text. */
  description: string;
}

export interface AstDiffResult {
  filePath: string;
  changes: SymbolChange[];
  hasChanges: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalises whitespace before hashing so trivial formatting changes are ignored. */
export function hashSignature(sig: string): string {
  return createHash('md5')
    .update(sig.trim().replace(/\s+/g, ' '))
    .digest('hex')
    .slice(0, 8);
}

// ─── Core diff ────────────────────────────────────────────────────────────────

/**
 * Computes an AST-level diff for one file by comparing the freshly-parsed
 * symbols against the stored snapshots.
 *
 * Side effect: updates ast_snapshots after computing the diff so subsequent
 * calls reflect the current state.
 */
export function computeAstDiff(
  db: Database.Database,
  filePath: string,
  newSymbols: ParsedSymbol[],
): AstDiffResult {
  const snapshots = getSnapshotsByFile(db, filePath);

  // First time we see this file — just store the baseline, nothing to diff against.
  if (snapshots.length === 0) {
    deleteSnapshotsByFile(db, filePath);
    for (const sym of newSymbols) {
      upsertAstSnapshot(db, {
        filePath,
        symbolName: sym.name,
        kind: sym.kind,
        signature: sym.signature,
        signatureHash: hashSignature(sym.signature),
      });
    }
    return { filePath, changes: [], hasChanges: false };
  }

  const snapshotMap = new Map(snapshots.map((s) => [s.symbol_name, s]));
  const newMap = new Map(newSymbols.map((s) => [s.name, s]));

  const changes: SymbolChange[] = [];

  // Removed + sig_changed
  for (const [name, snap] of snapshotMap) {
    const sym = newMap.get(name);
    if (!sym) {
      changes.push({
        type: 'removed',
        name,
        kind: snap.kind,
        oldSignature: snap.signature,
        description: `${snap.kind} \`${name}\` removed`,
      });
    } else if (hashSignature(sym.signature) !== snap.signature_hash) {
      changes.push({
        type: 'sig_changed',
        name,
        kind: sym.kind,
        oldSignature: snap.signature,
        newSignature: sym.signature,
        description: `${sym.kind} \`${name}\` signature changed`,
      });
    }
  }

  // Added
  for (const [name, sym] of newMap) {
    if (!snapshotMap.has(name)) {
      changes.push({
        type: 'added',
        name,
        kind: sym.kind,
        newSignature: sym.signature,
        description: `${sym.kind} \`${name}\` added`,
      });
    }
  }

  // Update snapshots to reflect current state
  deleteSnapshotsByFile(db, filePath);
  for (const sym of newSymbols) {
    upsertAstSnapshot(db, {
      filePath,
      symbolName: sym.name,
      kind: sym.kind,
      signature: sym.signature,
      signatureHash: hashSignature(sym.signature),
    });
  }

  return { filePath, changes, hasChanges: changes.length > 0 };
}
