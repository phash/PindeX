import type { DocumentSymbol } from 'vscode-languageserver-protocol';
import type { ParsedSymbol, SymbolKind } from '../types.js';

// LSP SymbolKind → PindeX SymbolKind.
// Numeric values per LSP spec:
//  5 Class / 9 Constructor / 6 Method / 12 Function / 13 Variable / 14 Constant
const KIND_MAP: Record<number, SymbolKind> = {
  5: 'class',
  6: 'method',
  9: 'method',   // constructors are methods in our model
  12: 'function',
  13: 'variable',
  14: 'variable',
};

/** Flattens an LSP DocumentSymbol tree into PindeX's flat ParsedSymbol array.
 *  Nested class members are emitted as individual method/variable entries. */
export function mapDocumentSymbols(symbols: DocumentSymbol[]): ParsedSymbol[] {
  const out: ParsedSymbol[] = [];
  walk(symbols, out);
  return out;
}

function walk(nodes: DocumentSymbol[], out: ParsedSymbol[]): void {
  for (const node of nodes) {
    const kind = KIND_MAP[node.kind as number];
    if (kind) {
      // LSP ranges are 0-indexed; PindeX stores 1-indexed start/end lines.
      out.push({
        name: node.name,
        kind,
        signature: node.name,
        startLine: node.range.start.line + 1,
        endLine: node.range.end.line + 1,
        isExported: true,
        isAsync: false,
        hasTryCatch: false,
      });
    }
    if (node.children && node.children.length > 0) {
      walk(node.children, out);
    }
  }
}
