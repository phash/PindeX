import { describe, it, expect } from 'vitest';
import type { DocumentSymbol, SymbolKind as LspSymbolKind } from 'vscode-languageserver-protocol';
import { mapDocumentSymbols } from '../../src/indexer/lsp-mapper.js';

// LSP SymbolKind numeric values we need:
// 5=Class, 6=Method, 12=Function, 13=Variable, 14=Constant
const CLASS = 5 as LspSymbolKind;
const METHOD = 6 as LspSymbolKind;
const FUNCTION = 12 as LspSymbolKind;
const VARIABLE = 13 as LspSymbolKind;

function sym(
  name: string,
  kind: LspSymbolKind,
  startLine: number,
  endLine: number,
  children?: DocumentSymbol[],
): DocumentSymbol {
  return {
    name,
    kind,
    range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 0 } },
    selectionRange: { start: { line: startLine, character: 0 }, end: { line: startLine, character: name.length } },
    children,
  };
}

describe('mapDocumentSymbols', () => {
  it('returns an empty array for empty input', () => {
    expect(mapDocumentSymbols([])).toEqual([]);
  });

  it('maps a top-level function', () => {
    const result = mapDocumentSymbols([sym('foo', FUNCTION, 0, 4)]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'foo',
      kind: 'function',
      startLine: 1, // 1-indexed in PindeX
      endLine: 5,
      isExported: true,
      isAsync: false,
      hasTryCatch: false,
    });
  });

  it('flattens class methods into individual method entries', () => {
    const result = mapDocumentSymbols([
      sym('MyClass', CLASS, 0, 20, [
        sym('__init__', METHOD, 1, 3),
        sym('greet', METHOD, 5, 10),
      ]),
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.name)).toEqual(['MyClass', '__init__', 'greet']);
    expect(result.map((s) => s.kind)).toEqual(['class', 'method', 'method']);
  });

  it('maps module-level variables and constants to kind=variable', () => {
    const result = mapDocumentSymbols([
      sym('MAX', VARIABLE, 0, 0),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('variable');
  });

  it('uses the symbol name as the signature (no hover info available)', () => {
    const result = mapDocumentSymbols([sym('foo', FUNCTION, 0, 3)]);
    expect(result[0].signature).toBe('foo');
  });

  it('handles deeply nested structures without infinite recursion', () => {
    const result = mapDocumentSymbols([
      sym('Outer', CLASS, 0, 50, [
        sym('Inner', CLASS, 2, 30, [
          sym('deep_method', METHOD, 5, 10),
        ]),
      ]),
    ]);
    expect(result.map((s) => s.name)).toEqual(['Outer', 'Inner', 'deep_method']);
  });

  it('ignores symbols with unsupported LSP kinds', () => {
    const NAMESPACE = 3 as LspSymbolKind; // not in our SymbolKind enum
    const result = mapDocumentSymbols([sym('ns', NAMESPACE, 0, 5)]);
    expect(result).toEqual([]);
  });
});
