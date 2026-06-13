import { describe, it, expect } from 'vitest';
import type { AstNode } from '../../src/types.js';
import {
  extractSymbols,
  extractImports,
  estimateTokens,
  detectLanguage,
  buildSignature,
  parseFile,
  parseDocument,
  hashContent,
  isDocumentLanguage,
} from '../../src/indexer/parser.js';

// ─── Mock AstNode Helpers ─────────────────────────────────────────────────────

function makeNode(
  type: string,
  text: string,
  startRow: number,
  endRow: number,
  options: Partial<AstNode> = {},
): AstNode {
  return {
    type,
    text,
    startPosition: { row: startRow, column: 0 },
    endPosition: { row: endRow, column: 0 },
    children: [],
    namedChildren: [],
    childForFieldName: () => null,
    descendantsOfType: () => [],
    ...options,
  };
}

function makeIdentifier(name: string): AstNode {
  return makeNode('identifier', name, 0, 0);
}

function makeTypeAnnotation(typeName: string): AstNode {
  return makeNode('type_annotation', `: ${typeName}`, 0, 0, {
    children: [makeNode('type_identifier', typeName, 0, 0)],
  });
}

function makeFormalParameters(text: string): AstNode {
  return makeNode('formal_parameters', text, 0, 0);
}

function makeReturnType(typeName: string): AstNode {
  return makeNode('type_annotation', `: ${typeName}`, 0, 0);
}

function makeFunctionDeclaration(
  name: string,
  params: string,
  returnType: string | null,
  startRow: number,
  endRow: number,
): AstNode {
  const node = makeNode('function_declaration', `function ${name}${params}`, startRow, endRow);
  node.childForFieldName = (field: string) => {
    if (field === 'name') return makeIdentifier(name);
    if (field === 'parameters') return makeFormalParameters(params);
    if (field === 'return_type') return returnType ? makeReturnType(returnType) : null;
    return null;
  };
  return node;
}

function makeClassDeclaration(name: string, startRow: number, endRow: number): AstNode {
  const node = makeNode('class_declaration', `class ${name} {}`, startRow, endRow);
  node.childForFieldName = (field: string) => {
    if (field === 'name') return makeIdentifier(name);
    return null;
  };
  node.descendantsOfType = (type: string | string[]) => {
    if (type === 'method_definition' || (Array.isArray(type) && type.includes('method_definition')))
      return [];
    return [];
  };
  return node;
}

function makeInterfaceDeclaration(name: string, startRow: number, endRow: number): AstNode {
  const node = makeNode('interface_declaration', `interface ${name} {}`, startRow, endRow);
  node.childForFieldName = (field: string) => {
    if (field === 'name') return makeIdentifier(name);
    return null;
  };
  return node;
}

function makeTypeAliasDeclaration(name: string, startRow: number, endRow: number): AstNode {
  const node = makeNode('type_alias_declaration', `type ${name} = string`, startRow, endRow);
  node.childForFieldName = (field: string) => {
    if (field === 'name') return makeIdentifier(name);
    if (field === 'value') return makeNode('predefined_type', 'string', 0, 0);
    return null;
  };
  return node;
}

function makeExportStatement(declaration: AstNode): AstNode {
  const node = makeNode('export_statement', `export ${declaration.text}`, declaration.startPosition.row, declaration.endPosition.row, {
    children: [declaration],
    namedChildren: [declaration],
  });
  node.childForFieldName = (field: string) => {
    if (field === 'declaration') return declaration;
    return null;
  };
  return node;
}

function makeImportStatement(source: string, importedNames: string[]): AstNode {
  const node = makeNode(
    'import_statement',
    `import { ${importedNames.join(', ')} } from '${source}'`,
    0, 0,
  );
  const namedImports: AstNode = {
    type: 'named_imports',
    text: `{ ${importedNames.join(', ')} }`,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    children: importedNames.map((n) => makeNode('import_specifier', n, 0, 0, {
      childForFieldName: (f) => f === 'name' ? makeIdentifier(n) : null,
      descendantsOfType: () => [],
    })),
    namedChildren: importedNames.map((n) => makeNode('import_specifier', n, 0, 0)),
    childForFieldName: () => null,
    descendantsOfType: () => [],
  };
  const sourceNode = makeNode('string', `'${source}'`, 0, 0, {
    text: `'${source}'`,
  });
  node.childForFieldName = (field: string) => {
    if (field === 'source') return sourceNode;
    return null;
  };
  node.descendantsOfType = (type: string | string[]) => {
    if (type === 'named_imports' || (Array.isArray(type) && type.includes('named_imports')))
      return [namedImports];
    if (type === 'import_specifier' || (Array.isArray(type) && type.includes('import_specifier')))
      return importedNames.map((n) => makeNode('import_specifier', n, 0, 0, {
        childForFieldName: (f) => f === 'name' ? makeIdentifier(n) : null,
        descendantsOfType: () => [],
      }));
    return [];
  };
  return node;
}

function makeProgramNode(children: AstNode[]): AstNode {
  return {
    type: 'program',
    text: children.map((c) => c.text).join('\n'),
    startPosition: { row: 0, column: 0 },
    endPosition: { row: children.length, column: 0 },
    children,
    namedChildren: children,
    childForFieldName: () => null,
    descendantsOfType: (type: string | string[]) => {
      const types = Array.isArray(type) ? type : [type];
      return children.filter((c) => types.includes(c.type));
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates tokens as ceil(chars / 4)', () => {
    expect(estimateTokens('1234')).toBe(1);
    expect(estimateTokens('12345')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('is consistent for larger content', () => {
    const content = 'a'.repeat(400);
    expect(estimateTokens(content)).toBe(100);
  });
});

describe('detectLanguage', () => {
  it('detects typescript for .ts files', () => {
    expect(detectLanguage('src/app.ts')).toBe('typescript');
  });

  it('detects tsx for .tsx files', () => {
    expect(detectLanguage('src/App.tsx')).toBe('tsx');
  });

  it('detects javascript for .js files', () => {
    expect(detectLanguage('src/app.js')).toBe('javascript');
  });

  it('detects javascript for .mjs files', () => {
    expect(detectLanguage('src/app.mjs')).toBe('javascript');
  });

  it('returns unknown for unrecognized extensions', () => {
    expect(detectLanguage('file.xyz')).toBe('unknown');
  });

  it('returns markdown for .md files', () => {
    expect(detectLanguage('README.md')).toBe('markdown');
  });

  it('returns yaml for .yaml files', () => {
    expect(detectLanguage('config.yaml')).toBe('yaml');
  });
});

describe('extractSymbols', () => {
  it('extracts a function declaration', () => {
    const funcNode = makeFunctionDeclaration('myFunc', '(a: string)', 'void', 0, 4);
    const root = makeProgramNode([funcNode]);
    const symbols = extractSymbols(root, funcNode.text);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('myFunc');
    expect(symbols[0].kind).toBe('function');
    expect(symbols[0].startLine).toBe(1); // 1-indexed
    expect(symbols[0].isExported).toBe(false);
  });

  it('marks exported function declarations', () => {
    const funcNode = makeFunctionDeclaration('exportedFunc', '()', null, 0, 4);
    const exportNode = makeExportStatement(funcNode);
    const root = makeProgramNode([exportNode]);
    const symbols = extractSymbols(root, exportNode.text);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('exportedFunc');
    expect(symbols[0].isExported).toBe(true);
  });

  it('extracts a class declaration', () => {
    const classNode = makeClassDeclaration('MyService', 0, 10);
    const root = makeProgramNode([classNode]);
    const symbols = extractSymbols(root, classNode.text);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('MyService');
    expect(symbols[0].kind).toBe('class');
  });

  it('extracts an interface declaration', () => {
    const iface = makeInterfaceDeclaration('UserInterface', 0, 5);
    const root = makeProgramNode([iface]);
    const symbols = extractSymbols(root, iface.text);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('UserInterface');
    expect(symbols[0].kind).toBe('interface');
  });

  it('extracts a type alias declaration', () => {
    const typeAlias = makeTypeAliasDeclaration('UserId', 0, 0);
    const root = makeProgramNode([typeAlias]);
    const symbols = extractSymbols(root, typeAlias.text);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('UserId');
    expect(symbols[0].kind).toBe('type');
  });

  it('returns empty array for empty program', () => {
    const root = makeProgramNode([]);
    expect(extractSymbols(root, '')).toHaveLength(0);
  });

  it('extracts multiple symbols', () => {
    const func1 = makeFunctionDeclaration('foo', '()', null, 0, 3);
    const func2 = makeFunctionDeclaration('bar', '()', null, 5, 8);
    const root = makeProgramNode([func1, func2]);
    const symbols = extractSymbols(root, '');
    expect(symbols).toHaveLength(2);
    expect(symbols.map((s) => s.name)).toEqual(expect.arrayContaining(['foo', 'bar']));
  });
});

describe('extractImports', () => {
  it('extracts named imports from an import statement', () => {
    const importNode = makeImportStatement('./auth/service', ['AuthService', 'login']);
    const root = makeProgramNode([importNode]);
    const imports = extractImports(root);
    expect(imports).toHaveLength(1);
    expect(imports[0].source).toBe('./auth/service');
    expect(imports[0].symbols).toEqual(expect.arrayContaining(['AuthService', 'login']));
  });

  it('returns empty array when no imports', () => {
    const root = makeProgramNode([]);
    expect(extractImports(root)).toHaveLength(0);
  });
});

describe('buildSignature', () => {
  it('builds a function signature', () => {
    const funcNode = makeFunctionDeclaration('myFunc', '(a: string, b: number)', 'boolean', 0, 4);
    const sig = buildSignature(funcNode, 'function');
    expect(sig).toContain('myFunc');
  });

  it('builds a class signature', () => {
    const classNode = makeClassDeclaration('MyClass', 0, 10);
    const sig = buildSignature(classNode, 'class');
    expect(sig).toContain('MyClass');
  });
});

// ─── TST-17: Full assembled-signature assertions ──────────────────────────────
// These check the COMPLETE one-line signature string buildSignature produces,
// not merely that the name appears somewhere in it.

/** Builds an AstNode whose childForFieldName resolves the given fields. */
function makeFieldedNode(
  type: string,
  text: string,
  fields: Record<string, AstNode | null>,
): AstNode {
  return makeNode(type, text, 0, 0, {
    childForFieldName: (field: string) => fields[field] ?? null,
  });
}

function makeField(text: string): AstNode {
  return makeNode('field', text, 0, 0);
}

describe('buildSignature (full string)', () => {
  it('assembles function signature: name + params + return type', () => {
    // makeFunctionDeclaration's return-type node renders as ": <name>", so pass
    // the bare type name and expect the assembled "name(params): retType".
    const node = makeFunctionDeclaration('compute', '(a: string, b: number)', 'boolean', 0, 4);
    expect(buildSignature(node, 'function')).toBe('compute(a: string, b: number): boolean');
  });

  it('assembles method signature identically to function branch', () => {
    const node = makeFieldedNode('method_definition', 'greet(x: string): void', {
      name: makeIdentifier('greet'),
      parameters: makeField('(x: string)'),
      return_type: makeField(': void'),
    });
    expect(buildSignature(node, 'method')).toBe('greet(x: string): void');
  });

  it('function with no params node defaults to "()" and no return type', () => {
    const node = makeFieldedNode('function_declaration', 'function bare', {
      name: makeIdentifier('bare'),
    });
    expect(buildSignature(node, 'function')).toBe('bare()');
  });

  it('collapses runs of whitespace in the assembled function signature', () => {
    const node = makeFieldedNode('function_declaration', 'noisy', {
      name: makeIdentifier('noisy'),
      parameters: makeField('(  a:   string  )'),
      return_type: makeField('   : void'),
    });
    expect(buildSignature(node, 'function')).toBe('noisy( a: string ) : void');
  });

  it('assembles a class signature without heritage', () => {
    const node = makeFieldedNode('class_declaration', 'class Plain {}', {
      name: makeIdentifier('Plain'),
    });
    expect(buildSignature(node, 'class')).toBe('class Plain');
  });

  it('assembles a class signature WITH heritage clause', () => {
    const node = makeFieldedNode('class_declaration', 'class Derived extends Base {}', {
      name: makeIdentifier('Derived'),
      class_heritage: makeField('extends Base'),
    });
    expect(buildSignature(node, 'class')).toBe('class Derived extends Base');
  });

  it('assembles an interface signature without an extends clause', () => {
    const node = makeFieldedNode('interface_declaration', 'interface Shape {}', {
      name: makeIdentifier('Shape'),
    });
    expect(buildSignature(node, 'interface')).toBe('interface Shape');
  });

  it('assembles an interface signature WITH an extends clause', () => {
    const node = makeFieldedNode('interface_declaration', 'interface Square extends Shape {}', {
      name: makeIdentifier('Square'),
      extends_clause: makeField('extends Shape'),
    });
    expect(buildSignature(node, 'interface')).toBe('interface Square extends Shape');
  });

  it('assembles a type alias signature including its value', () => {
    const node = makeFieldedNode('type_alias_declaration', 'type Id = string', {
      name: makeIdentifier('Id'),
      value: makeField('string | number'),
    });
    expect(buildSignature(node, 'type')).toBe('type Id = string | number');
  });

  it('defaults the type value to "..." when no value field is present', () => {
    const node = makeFieldedNode('type_alias_declaration', 'type Mystery', {
      name: makeIdentifier('Mystery'),
    });
    expect(buildSignature(node, 'type')).toBe('type Mystery = ...');
  });

  it('truncates long type values to 47 chars + ellipsis', () => {
    const longValue = 'A'.repeat(80);
    const node = makeFieldedNode('type_alias_declaration', 'type Big', {
      name: makeIdentifier('Big'),
      value: makeField(longValue),
    });
    const sig = buildSignature(node, 'type');
    expect(sig).toBe(`type Big = ${'A'.repeat(47)}...`);
    // 'type Big = ' (11) + 47 + '...' (3) === 61
    expect(sig.length).toBe(61);
  });

  it('assembles an enum signature', () => {
    const node = makeFieldedNode('enum_declaration', 'enum Color { Red }', {
      name: makeIdentifier('Color'),
    });
    expect(buildSignature(node, 'enum')).toBe('enum Color');
  });
});

// ─── SEC-06 / SEC-11: regex parser perf + line-number correctness ─────────────
// parseCsharp / the other language parsers are reached via parseFile('*.cs', …).
// They run REAL regexes on the raw content (no tree-sitter), so these tests
// exercise the de-catastrophized C# method regex (SEC-06) and the
// binary-search line lookup (SEC-11).

describe('regex parsers: performance & line numbers', () => {
  it('C# method regex does not catastrophically backtrack on pathological input', () => {
    // A single huge run of whitespace between a type and an identifier is the
    // classic catastrophic-backtracking trigger for a naive `\s+`-heavy regex.
    const content = 'int ' + ' '.repeat(200_000) + 'x';
    const start = Date.now();
    const result = parseFile('Pathological.cs', content);
    const elapsed = Date.now() - start;
    expect(result.language).toBe('csharp');
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });

  it('C# parser stays fast on a file with very many method lines', () => {
    const lines: string[] = ['public class Big {'];
    for (let i = 0; i < 5000; i++) {
      lines.push(`    public void Method${i}() { }`);
    }
    lines.push('}');
    const content = lines.join('\n');

    const start = Date.now();
    const result = parseFile('Big.cs', content);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1500);
    // The class + a healthy number of methods should be discovered.
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('Big');
    expect(names).toContain('Method0');
    expect(names).toContain('Method4999');
  });

  it('produces correct 1-based line numbers via the binary-search lookup', () => {
    // A normal multi-line C# file: verify each symbol lands on its real line.
    const content = [
      'using System;',          // line 1
      '',                       // line 2
      'public class Foo {',     // line 3
      '    public void Bar() {',// line 4
      '    }',                  // line 5
      '    public int Baz() {', // line 6
      '        return 0;',      // line 7
      '    }',                  // line 8
      '}',                      // line 9
    ].join('\n');

    const { symbols } = parseFile('Foo.cs', content);
    const byName = new Map(symbols.map((s) => [s.name, s]));

    expect(byName.get('Foo')?.startLine).toBe(3);
    expect(byName.get('Bar')?.startLine).toBe(4);
    expect(byName.get('Baz')?.startLine).toBe(6);
  });

  it('binary-search line lookup matches a naive slice+split across many lines (Python)', () => {
    // Build a file where each def sits on a known line; cross-check the parser's
    // reported line against an independent computation.
    const blocks: string[] = [];
    const expected = new Map<string, number>();
    let line = 1;
    for (let i = 0; i < 300; i++) {
      // two filler lines, then a def
      blocks.push(`# filler ${i}`);
      blocks.push('');
      const name = `fn_${i}`;
      expected.set(name, line + 2); // def is the 3rd line of this block
      blocks.push(`def ${name}():`);
      blocks.push('    pass');
      line += 4;
    }
    const content = blocks.join('\n');

    const { symbols } = parseFile('many.py', content);
    for (const sym of symbols) {
      if (expected.has(sym.name)) {
        expect(sym.startLine).toBe(expected.get(sym.name));
      }
    }
    // Sanity: we actually found the defs.
    expect(symbols.some((s) => s.name === 'fn_0')).toBe(true);
    expect(symbols.some((s) => s.name === 'fn_299')).toBe(true);
  });
});

// ─── Regex parsers: per-language symbol + import extraction ────────────────────
// Each language without a tree-sitter grammar is routed through parseFile() to a
// dedicated regex parser. These tests feed representative source and assert the
// extracted symbol names/kinds AND the import source/symbols.

/** Convenience: maps a parsed result's symbols to {name, kind} pairs. */
function symKinds(symbols: { name: string; kind: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of symbols) out[s.name] = s.kind;
  return out;
}

describe('regex parser: Java (parseFile *.java)', () => {
  it('extracts classes/interfaces/enums/records and methods with modifiers', () => {
    const content = [
      'package com.example.app;',                       // 1
      '',                                               // 2
      'import java.util.List;',                         // 3
      'import static org.junit.Assert.assertEquals;',   // 4
      'import com.example.util.*;',                      // 5
      '',                                               // 6
      'public abstract class Service {',                // 7
      '    public static void main(String[] args) {}',  // 8
      '    private int compute(int a, int b) {',        // 9
      '        return a + b;',                          // 10
      '    }',                                          // 11
      '    protected abstract String name();',          // 12
      '}',                                              // 13
      '',                                               // 14
      'interface Repository {',                         // 15
      '    List<String> findAll();',                    // 16
      '}',                                              // 17
      '',                                               // 18
      'enum Color { RED, GREEN }',                      // 19
      '',                                               // 20
      'record Point(int x, int y) {}',                  // 21
    ].join('\n');

    const result = parseFile('Service.java', content);
    expect(result.language).toBe('java');

    const kinds = symKinds(result.symbols);
    // class-family declarations
    expect(kinds.Service).toBe('class');
    expect(kinds.Repository).toBe('class');
    expect(kinds.Color).toBe('class');
    expect(kinds.Point).toBe('class');
    // methods (indented, with various modifiers / return types)
    expect(kinds.main).toBe('method');
    expect(kinds.compute).toBe('method');
    expect(kinds.name).toBe('method');
    expect(kinds.findAll).toBe('method');

    // imports: package source + final segment as symbol; '*' => no symbols
    const bySource = new Map(result.imports.map((i) => [i.source, i.symbols]));
    expect(bySource.get('java.util')).toEqual(['List']);
    expect(bySource.get('org.junit.Assert')).toEqual(['assertEquals']);
    expect(bySource.get('com.example.util')).toEqual([]);

    // correct 1-based line numbers
    const byName = new Map(result.symbols.map((s) => [s.name, s.startLine]));
    expect(byName.get('Service')).toBe(7);
    expect(byName.get('compute')).toBe(9);
    expect(byName.get('Color')).toBe(19);
  });
});

describe('regex parser: Kotlin (parseFile *.kt)', () => {
  it('extracts class/interface/object and fun declarations + imports', () => {
    const content = [
      'package com.example',                                  // 1
      'import kotlin.collections.List',                       // 2
      'import com.example.util.Helper as H',                  // 3
      'import com.example.ext.*',                             // 4
      '',                                                     // 5
      'data class User(val id: Int)',                         // 6
      'sealed interface Shape',                               // 7
      'object Singleton',                                     // 8
      '',                                                     // 9
      'fun topLevel(): Int = 1',                              // 10
      'suspend fun fetch(url: String) {}',                    // 11
      'private inline fun <T> wrap(x: T): T = x',             // 12
    ].join('\n');

    const result = parseFile('App.kt', content);
    expect(result.language).toBe('kotlin');

    const kinds = symKinds(result.symbols);
    expect(kinds.User).toBe('class');
    expect(kinds.Shape).toBe('class');
    expect(kinds.Singleton).toBe('class');
    expect(kinds.topLevel).toBe('function');
    expect(kinds.fetch).toBe('function');
    expect(kinds.wrap).toBe('function');

    const bySource = new Map(result.imports.map((i) => [i.source, i.symbols]));
    expect(bySource.get('kotlin.collections')).toEqual(['List']);
    // alias import: only the dotted path before "as" is matched
    expect(bySource.get('com.example.util')).toEqual(['Helper']);
    // wildcard: [\w.]+ swallows the trailing '.' (not the '*'), so the last
    // segment is empty → source='com.example.ext', symbol=''.
    expect(bySource.get('com.example.ext')).toEqual(['']);
  });

  it('also resolves .kts script extension to kotlin', () => {
    const result = parseFile('build.gradle.kts', 'fun configure() {}');
    expect(result.language).toBe('kotlin');
    expect(symKinds(result.symbols).configure).toBe('function');
  });
});

describe('regex parser: Python (parseFile *.py)', () => {
  it('extracts classes and (async) defs + from/plain imports', () => {
    const content = [
      'import os',                              // 1
      'import sys as system',                   // 2
      'from typing import List, Dict, Any',     // 3
      'from .local import thing as t',          // 4
      '',                                       // 5
      'class Animal:',                          // 6
      '    def speak(self):',                   // 7  (indented → NOT matched by ^def)
      '        pass',                           // 8
      '',                                       // 9
      'async def fetch(url):',                  // 10
      '    return url',                         // 11
      '',                                       // 12
      'def helper():',                          // 13
      '    pass',                               // 14
    ].join('\n');

    const result = parseFile('app.py', content);
    expect(result.language).toBe('python');

    const kinds = symKinds(result.symbols);
    expect(kinds.Animal).toBe('class');
    // The Python regex anchors def/class at column 0 (^), so the indented
    // method 'speak' is intentionally not captured.
    expect(kinds.speak).toBeUndefined();
    expect(kinds.fetch).toBe('function');   // async def at column 0
    expect(kinds.helper).toBe('function');
    // fetch lands on its real line (10)
    expect(result.symbols.find((s) => s.name === 'fetch')?.startLine).toBe(10);

    const bySource = new Map(result.imports.map((i) => [i.source, i.symbols]));
    // from X import a, b, c  → symbols list, "as" alias stripped
    expect(bySource.get('typing')).toEqual(['List', 'Dict', 'Any']);
    expect(bySource.get('.local')).toEqual(['thing']);
    // plain import X → empty symbols
    expect(bySource.get('os')).toEqual([]);
    expect(bySource.get('sys')).toEqual([]);
  });
});

describe('regex parser: PHP (parseFile *.php)', () => {
  it('extracts class/interface/trait/enum + functions with modifiers + use imports', () => {
    const content = [
      '<?php',                                        // 1
      'use App\\Models\\User;',                       // 2
      'use App\\Services\\Mailer;',                   // 3
      '',                                             // 4
      'abstract class BaseController {',              // 5
      '    public function index() {',               // 6
      '        return 1;',                            // 7
      '    }',                                        // 8
      '    private static function helper() {}',      // 9
      '}',                                            // 10
      '',                                             // 11
      'interface Renderable {}',                      // 12
      'trait Loggable {}',                            // 13
      'enum Suit {}',                                 // 14
      '',                                             // 15
      'function globalFn() {}',                       // 16
    ].join('\n');

    const result = parseFile('Controller.php', content);
    expect(result.language).toBe('php');

    const kinds = symKinds(result.symbols);
    expect(kinds.BaseController).toBe('class');
    expect(kinds.Renderable).toBe('class');
    expect(kinds.Loggable).toBe('class');
    expect(kinds.Suit).toBe('class');
    expect(kinds.index).toBe('function');
    expect(kinds.helper).toBe('function');
    expect(kinds.globalFn).toBe('function');

    const bySource = new Map(result.imports.map((i) => [i.source, i.symbols]));
    expect(bySource.get('App\\Models')).toEqual(['User']);
    expect(bySource.get('App\\Services')).toEqual(['Mailer']);
  });
});

describe('regex parser: Ruby (parseFile *.rb)', () => {
  it('extracts module/class and def (incl self. and ?/!) + require imports', () => {
    const content = [
      "require 'json'",                       // 1
      "require_relative 'helper'",            // 2
      '',                                     // 3
      'module Admin',                         // 4
      '  class UsersController',              // 5
      '    def index',                        // 6
      '    end',                              // 7
      '    def self.create',                  // 8
      '    end',                              // 9
      '    def valid?',                       // 10
      '    end',                              // 11
      '    def save!',                        // 12
      '    end',                              // 13
      '  end',                                // 14
      'end',                                  // 15
    ].join('\n');

    const result = parseFile('users.rb', content);
    expect(result.language).toBe('ruby');

    const kinds = symKinds(result.symbols);
    expect(kinds.Admin).toBe('class'); // module mapped to 'class'
    expect(kinds.UsersController).toBe('class');
    expect(kinds.index).toBe('method');
    expect(kinds.create).toBe('method'); // self. stripped
    expect(kinds['valid?']).toBe('method');
    expect(kinds['save!']).toBe('method');

    const sources = result.imports.map((i) => i.source);
    expect(sources).toContain('json');
    expect(sources).toContain('helper');
    expect(result.imports.every((i) => i.symbols.length === 0)).toBe(true);
  });
});

describe('regex parser: C# (parseFile *.cs)', () => {
  it('extracts class/struct/record/enum + methods + using imports', () => {
    const content = [
      'using System;',                                // 1
      'using System.Collections.Generic;',            // 2
      'using static System.Math;',                    // 3
      '',                                             // 4
      'public sealed class Repository {',             // 5
      '    public async Task<int> GetAsync() {',      // 6
      '        return 0;',                            // 7
      '    }',                                        // 8
      '    private static void Helper() {}',          // 9
      '}',                                            // 10
      '',                                             // 11
      'public struct Point {}',                       // 12
      'public record Money {}',                       // 13
      'public enum Status {}',                        // 14
      'internal interface IService {}',               // 15
    ].join('\n');

    const result = parseFile('Repository.cs', content);
    expect(result.language).toBe('csharp');

    const kinds = symKinds(result.symbols);
    expect(kinds.Repository).toBe('class');
    expect(kinds.Point).toBe('class');
    expect(kinds.Money).toBe('class');
    expect(kinds.Status).toBe('class');
    expect(kinds.IService).toBe('class');
    expect(kinds.GetAsync).toBe('method');
    expect(kinds.Helper).toBe('method');

    // For multi-segment usings the final segment is the symbol, the rest is source.
    const bySource = new Map(result.imports.map((i) => [i.source, i.symbols]));
    expect(bySource.get('System.Collections')).toEqual(['Generic']);
    // For multi-segment "using static System.Math;": source='System', sym='Math'
    expect(bySource.get('System')).toEqual(['Math']);
    // Single-segment "using System;" → source='' (no dots), symbol is 'System'.
    expect(bySource.get('')).toEqual(['System']);
  });
});

describe('regex parser: Go (parseFile *.go)', () => {
  it('extracts struct/interface types and funcs + single & block imports', () => {
    const content = [
      'package main',                              // 1
      '',                                          // 2
      'import "fmt"',                              // 3
      '',                                          // 4
      'import (',                                  // 5
      '\t"net/http"',                              // 6
      '\t"strings"',                               // 7
      ')',                                         // 8
      '',                                          // 9
      'type Server struct {',                      // 10
      '    addr string',                           // 11
      '}',                                         // 12
      '',                                          // 13
      'type Handler interface {',                  // 14
      '    Serve()',                               // 15
      '}',                                         // 16
      '',                                          // 17
      'func New() *Server {',                      // 18
      '    return nil',                            // 19
      '}',                                         // 20
      '',                                          // 21
      'func (s *Server) Start() error {',          // 22
      '    return nil',                            // 23
      '}',                                         // 24
    ].join('\n');

    const result = parseFile('server.go', content);
    expect(result.language).toBe('go');

    const kinds = symKinds(result.symbols);
    expect(kinds.Server).toBe('class');
    expect(kinds.Handler).toBe('class');
    expect(kinds.New).toBe('function');
    expect(kinds.Start).toBe('function'); // method with receiver

    const sources = result.imports.map((i) => i.source);
    expect(sources).toContain('fmt');      // single import
    expect(sources).toContain('net/http'); // block import
    expect(sources).toContain('strings');  // block import
    expect(result.imports.every((i) => i.symbols.length === 0)).toBe(true);
  });
});

describe('regex parser: Rust (parseFile *.rs)', () => {
  it('extracts struct/enum/trait, fns, type/const/static + use imports', () => {
    const content = [
      'use std::collections::HashMap;',                // 1
      'use serde::{Serialize, Deserialize};',          // 2
      '',                                              // 3
      'pub struct Config {',                           // 4
      '    name: String,',                             // 5
      '}',                                             // 6
      '',                                              // 7
      'pub enum State { On, Off }',                    // 8
      'pub trait Render {}',                           // 9
      '',                                              // 10
      'pub fn build() -> Config {',                    // 11
      '    Config { name: String::new() }',            // 12
      '}',                                             // 13
      '',                                              // 14
      'pub async fn run() {}',                         // 15
      'pub const MAX: u32 = 10;',                      // 16
      'static GREETING: &str = "hi";',                 // 17
      'pub type Id = u64;',                            // 18
    ].join('\n');

    const result = parseFile('config.rs', content);
    expect(result.language).toBe('rust');

    const kinds = symKinds(result.symbols);
    expect(kinds.Config).toBe('class');
    expect(kinds.State).toBe('class');
    expect(kinds.Render).toBe('class');
    expect(kinds.build).toBe('function');
    expect(kinds.run).toBe('function');
    expect(kinds.MAX).toBe('variable');
    expect(kinds.GREETING).toBe('variable');
    expect(kinds.Id).toBe('variable');

    const sources = result.imports.map((i) => i.source);
    expect(sources).toContain('std::collections::HashMap');
    // grouped use: source captured includes the brace group
    expect(sources.some((s) => s.startsWith('serde::'))).toBe(true);
  });
});

// ─── Vue / Svelte SFC <script> extraction ─────────────────────────────────────
// The tree-sitter parser is globally mocked to return an EMPTY program, so we
// can't assert real symbols here — but we CAN exercise both branches of the SFC
// path: (a) non-empty <script> → runs the parser, (b) empty/whitespace <script>
// → early return. Both go through extractSfcScript().

describe('SFC parsers: Vue & Svelte', () => {
  it('Vue file with a non-empty <script> block parses without error', () => {
    const content = [
      '<template>',
      '  <div>{{ msg }}</div>',
      '</template>',
      '<script>',
      "import { ref } from 'vue';",
      'export function setup() { return {}; }',
      '</script>',
    ].join('\n');
    const result = parseFile('Component.vue', content);
    expect(result.language).toBe('vue');
    // mocked tree-sitter → empty extraction, but arrays must be present
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(Array.isArray(result.imports)).toBe(true);
    expect(result.rawTokenEstimate).toBeGreaterThan(0);
  });

  it('Vue file with an empty <script> block returns empty symbols early', () => {
    const content = '<template><p>hi</p></template>\n<script>\n   \n</script>';
    const result = parseFile('Empty.vue', content);
    expect(result.language).toBe('vue');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
  });

  it('Vue file with no <script> tag at all returns empty', () => {
    const content = '<template><span>nope</span></template>';
    const result = parseFile('NoScript.vue', content);
    expect(result.language).toBe('vue');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
  });

  it('Svelte file with <script lang="ts"> attributes parses without error', () => {
    const content = [
      '<script lang="ts">',
      "  import { onMount } from 'svelte';",
      '  let count = 0;',
      '</script>',
      '<h1>{count}</h1>',
    ].join('\n');
    const result = parseFile('Widget.svelte', content);
    expect(result.language).toBe('svelte');
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(Array.isArray(result.imports)).toBe(true);
  });

  it('Svelte file without a script block returns empty', () => {
    const result = parseFile('Static.svelte', '<p>static markup</p>');
    expect(result.language).toBe('svelte');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
  });
});

// ─── parseFile: TS/JS path + unknown languages + edge cases ───────────────────

describe('parseFile: TS/JS dispatch and unknown languages', () => {
  it('routes .ts files through tree-sitter (mocked → empty) with language set', () => {
    const result = parseFile('app.ts', 'export const x = 1;');
    expect(result.language).toBe('typescript');
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(Array.isArray(result.imports)).toBe(true);
  });

  it('routes .tsx files (uses tsx grammar) without error', () => {
    const result = parseFile('App.tsx', 'export const App = () => null;');
    expect(result.language).toBe('tsx');
    expect(Array.isArray(result.symbols)).toBe(true);
  });

  it('routes .jsx files without error', () => {
    const result = parseFile('App.jsx', 'export const App = () => null;');
    expect(result.language).toBe('jsx');
    expect(Array.isArray(result.symbols)).toBe(true);
  });

  it('returns empty symbols/imports for an unknown extension', () => {
    const result = parseFile('data.xyz', 'whatever content here');
    expect(result.language).toBe('unknown');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.rawTokenEstimate).toBeGreaterThan(0);
  });

  it('returns empty for a document language routed through parseFile (yaml)', () => {
    // yaml is not a code language and has no regex parser → empty branch
    const result = parseFile('config.yaml', 'key: value');
    expect(result.language).toBe('yaml');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
  });

  it('handles empty content for a regex language', () => {
    const result = parseFile('Empty.java', '');
    expect(result.language).toBe('java');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.rawTokenEstimate).toBe(0);
  });

  it('handles content with no symbols for a regex language', () => {
    const result = parseFile('comment.py', '# just a comment\n# another comment\n');
    expect(result.language).toBe('python');
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
  });
});

// ─── regexSymbols: signature truncation to 80 chars ───────────────────────────

describe('regex parser: signature truncation (80 chars)', () => {
  it('truncates the captured signature line to 80 characters', () => {
    // Build a Python def line longer than 80 chars (after whitespace collapse).
    const longParams = Array.from({ length: 20 }, (_, i) => `param_number_${i}`).join(', ');
    const line = `def really_long_function(${longParams}):`;
    expect(line.length).toBeGreaterThan(80);
    const result = parseFile('long.py', line + '\n    pass\n');
    const sym = result.symbols.find((s) => s.name === 'really_long_function');
    expect(sym).toBeDefined();
    expect(sym!.signature.length).toBe(80);
    expect(sym!.signature.startsWith('def really_long_function(')).toBe(true);
  });

  it('collapses internal whitespace runs in the signature', () => {
    const result = parseFile('spaced.py', 'class    Spaced   :\n    pass\n');
    const sym = result.symbols.find((s) => s.name === 'Spaced');
    expect(sym).toBeDefined();
    expect(sym!.signature).toBe('class Spaced :');
  });
});

// ─── isDocumentLanguage ───────────────────────────────────────────────────────

describe('isDocumentLanguage', () => {
  it('is true for markdown, yaml, and text', () => {
    expect(isDocumentLanguage('markdown')).toBe(true);
    expect(isDocumentLanguage('yaml')).toBe(true);
    expect(isDocumentLanguage('text')).toBe(true);
  });

  it('is false for code languages', () => {
    expect(isDocumentLanguage('typescript')).toBe(false);
    expect(isDocumentLanguage('python')).toBe(false);
    expect(isDocumentLanguage('unknown')).toBe(false);
  });
});

// ─── parseDocument: markdown headings → chunks, other → fixed-size chunks ──────

describe('parseDocument: markdown', () => {
  it('splits markdown at heading boundaries (#, ##, ###) with correct lines', () => {
    const content = [
      'Intro paragraph before any heading.', // 1
      '',                                    // 2
      '# Title',                             // 3
      'Body of title.',                      // 4
      '',                                    // 5
      '## Section A',                        // 6
      'Section A content.',                  // 7
      '### Sub A1',                          // 8
      'Sub content.',                        // 9
    ].join('\n');

    const doc = parseDocument('README.md', content);
    expect(doc.language).toBe('markdown');
    expect(doc.rawTokenEstimate).toBeGreaterThan(0);

    // Preamble chunk (no heading), then one chunk per heading.
    const headings = doc.chunks.map((c) => c.heading);
    expect(headings).toEqual([null, 'Title', 'Section A', 'Sub A1']);

    // chunkIndex re-numbered sequentially from 0
    expect(doc.chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3]);

    // The preamble chunk starts at line 1; "# Title" chunk starts at line 3.
    expect(doc.chunks[0].startLine).toBe(1);
    expect(doc.chunks[1].startLine).toBe(3);
    expect(doc.chunks[1].heading).toBe('Title');
    expect(doc.chunks[2].startLine).toBe(6);
    expect(doc.chunks[3].startLine).toBe(8);
  });

  it('handles markdown with a leading heading (no preamble chunk)', () => {
    const content = '# Only Heading\nsome text\n';
    const doc = parseDocument('doc.md', content);
    expect(doc.chunks).toHaveLength(1);
    expect(doc.chunks[0].heading).toBe('Only Heading');
    expect(doc.chunks[0].startLine).toBe(1);
  });

  it('filters out empty/whitespace-only chunks', () => {
    const content = '   \n\n# Heading\nreal content';
    const doc = parseDocument('doc.md', content);
    // The whitespace-only preamble must be dropped, leaving only the heading chunk.
    expect(doc.chunks).toHaveLength(1);
    expect(doc.chunks[0].heading).toBe('Heading');
  });

  it('ignores heading levels deeper than h3 (#### is body text)', () => {
    const content = '# Top\n#### Not A Heading Boundary\ncontent';
    const doc = parseDocument('doc.md', content);
    expect(doc.chunks).toHaveLength(1);
    expect(doc.chunks[0].heading).toBe('Top');
  });
});

describe('parseDocument: non-markdown (fixed-size line chunks)', () => {
  it('splits a yaml/text document into 50-line chunks', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}: value`);
    const content = lines.join('\n');
    const doc = parseDocument('config.yaml', content);
    expect(doc.language).toBe('yaml');
    // 120 lines / 50 → 3 chunks (50, 50, 20)
    expect(doc.chunks).toHaveLength(3);
    expect(doc.chunks.every((c) => c.heading === null)).toBe(true);
    expect(doc.chunks[0].startLine).toBe(1);
    expect(doc.chunks[0].endLine).toBe(50);
    expect(doc.chunks[1].startLine).toBe(51);
    expect(doc.chunks[1].endLine).toBe(100);
    expect(doc.chunks[2].startLine).toBe(101);
    expect(doc.chunks[2].endLine).toBe(120);
    expect(doc.chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
  });

  it('produces a single chunk for short non-markdown content', () => {
    const doc = parseDocument('notes.txt', 'a\nb\nc');
    expect(doc.language).toBe('text');
    expect(doc.chunks).toHaveLength(1);
    expect(doc.chunks[0].startLine).toBe(1);
    expect(doc.chunks[0].endLine).toBe(3);
  });

  it('returns no chunks for empty/whitespace-only content', () => {
    const doc = parseDocument('blank.txt', '   \n   \n');
    expect(doc.chunks).toEqual([]);
  });
});

// ─── extractSymbols: AST-mock branches (methods, const, routes) ───────────────
// These use hand-built mock AstNodes to reach the tree-sitter-only branches that
// the regex parsers never touch.

describe('extractSymbols: class methods, exported const, routes', () => {
  it('extracts methods from a class (skipping the constructor)', () => {
    const methodA = makeFieldedNode('method_definition', 'doThing(x) {}', {
      name: makeIdentifier('doThing'),
      parameters: makeField('(x)'),
    });
    Object.assign(methodA, { startPosition: { row: 2, column: 0 }, endPosition: { row: 4, column: 0 } });
    const ctor = makeFieldedNode('method_definition', 'constructor() {}', {
      name: makeIdentifier('constructor'),
    });
    const classNode = makeNode('class_declaration', 'class Svc {}', 0, 6, {
      childForFieldName: (f: string) => (f === 'name' ? makeIdentifier('Svc') : null),
      descendantsOfType: (type: string | string[]) => {
        const types = Array.isArray(type) ? type : [type];
        return types.includes('method_definition') ? [ctor, methodA] : [];
      },
    });
    const root = makeProgramNode([classNode]);
    const symbols = extractSymbols(root, '');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('Svc');
    expect(names).toContain('doThing');
    expect(names).not.toContain('constructor'); // explicitly skipped
    const m = symbols.find((s) => s.name === 'doThing');
    expect(m?.kind).toBe('method');
    expect(m?.startLine).toBe(3); // row 2 → 1-based line 3
  });

  it('extracts methods from an EXPORTED class declaration', () => {
    const method = makeFieldedNode('method_definition', 'run() {}', {
      name: makeIdentifier('run'),
    });
    const classNode = makeNode('class_declaration', 'class Worker {}', 0, 5, {
      childForFieldName: (f: string) => (f === 'name' ? makeIdentifier('Worker') : null),
      descendantsOfType: (type: string | string[]) => {
        const types = Array.isArray(type) ? type : [type];
        return types.includes('method_definition') ? [method] : [];
      },
    });
    const exportNode = makeExportStatement(classNode);
    const root = makeProgramNode([exportNode]);
    const symbols = extractSymbols(root, '');
    const exported = symbols.find((s) => s.name === 'Worker');
    expect(exported?.isExported).toBe(true);
    expect(symbols.find((s) => s.name === 'run')?.kind).toBe('method');
  });

  it('extracts exported const declarations as kind "const"', () => {
    const declarator = makeFieldedNode('variable_declarator', 'foo = 1', {
      name: makeIdentifier('foo'),
      value: makeNode('number', '1', 0, 0),
    });
    const lexical = makeNode('lexical_declaration', 'const foo = 1', 0, 0, {
      descendantsOfType: (type: string | string[]) => {
        const types = Array.isArray(type) ? type : [type];
        return types.includes('variable_declarator') ? [declarator] : [];
      },
    });
    const exportNode = makeExportStatement(lexical);
    const root = makeProgramNode([exportNode]);
    const symbols = extractSymbols(root, '');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('foo');
    expect(symbols[0].kind).toBe('const');
    expect(symbols[0].isExported).toBe(true);
  });

  it('extracts an Express-style route registration', () => {
    // app.get('/users', handler)
    const pathArg = makeNode('string', "'/users'", 0, 0);
    const handlerArg = makeNode('arrow_function', '() => {}', 0, 0, {
      children: [],
      descendantsOfType: () => [],
    });
    const argsNode = makeNode('arguments', "('/users', handler)", 0, 0, {
      namedChildren: [pathArg, handlerArg],
    });
    const propNode = makeNode('property_identifier', 'get', 0, 0);
    const memberExpr = makeFieldedNode('member_expression', 'app.get', {
      property: propNode,
    });
    const callExpr = makeNode('call_expression', "app.get('/users', handler)", 0, 0, {
      namedChildren: [],
      childForFieldName: (f: string) => {
        if (f === 'function') return memberExpr;
        if (f === 'arguments') return argsNode;
        return null;
      },
    });
    const exprStmt = makeNode('expression_statement', "app.get('/users', handler);", 7, 7, {
      namedChildren: [callExpr],
    });
    const root = makeProgramNode([exprStmt]);
    const symbols = extractSymbols(root, '');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe('route');
    expect(symbols[0].name).toBe('GET /users');
    expect(symbols[0].signature).toBe('GET /users');
    expect(symbols[0].startLine).toBe(8); // row 7 → line 8
  });

  it('ignores app.use() and non-route member calls', () => {
    const argsNode = makeNode('arguments', '(mw)', 0, 0, {
      namedChildren: [makeNode('identifier', 'mw', 0, 0)],
    });
    const memberExpr = makeFieldedNode('member_expression', 'app.use', {
      property: makeNode('property_identifier', 'use', 0, 0),
    });
    const callExpr = makeNode('call_expression', 'app.use(mw)', 0, 0, {
      childForFieldName: (f: string) => {
        if (f === 'function') return memberExpr;
        if (f === 'arguments') return argsNode;
        return null;
      },
    });
    const exprStmt = makeNode('expression_statement', 'app.use(mw);', 0, 0, {
      namedChildren: [callExpr],
    });
    const root = makeProgramNode([exprStmt]);
    expect(extractSymbols(root, '')).toHaveLength(0);
  });
});

describe('buildSignature: default branch', () => {
  it('falls back to the node name for an unknown kind', () => {
    const node = makeFieldedNode('whatever', 'some code', { name: makeIdentifier('thing') });
    expect(buildSignature(node, 'variable')).toBe('thing');
  });

  it('falls back to the first text line when there is no name', () => {
    const node = makeNode('whatever', 'first line\nsecond line', 0, 1, {
      childForFieldName: () => null,
    });
    expect(buildSignature(node, 'variable')).toBe('first line');
  });
});

describe('extractImports: import with no source field is skipped', () => {
  it('skips an import_statement that has no source', () => {
    const noSource = makeNode('import_statement', "import './side-effect'", 0, 0, {
      childForFieldName: () => null,
      descendantsOfType: () => [],
    });
    const root = makeProgramNode([noSource]);
    // makeProgramNode.descendantsOfType only returns direct-child matches by type,
    // so wire it to surface our import node for the 'import_statement' query.
    root.descendantsOfType = (type: string | string[]) => {
      const types = Array.isArray(type) ? type : [type];
      return types.includes('import_statement') ? [noSource] : [];
    };
    expect(extractImports(root)).toEqual([]);
  });
});

// ─── hashContent ──────────────────────────────────────────────────────────────

describe('hashContent', () => {
  it('produces a stable 32-char md5 hex for given content', () => {
    const h = hashContent('hello world');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    // md5("hello world")
    expect(h).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
  });

  it('is deterministic and differs for different content', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });
});
