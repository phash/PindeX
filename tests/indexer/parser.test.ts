import { describe, it, expect } from 'vitest';
import type { AstNode } from '../../src/types.js';
import {
  extractSymbols,
  extractImports,
  estimateTokens,
  detectLanguage,
  buildSignature,
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
