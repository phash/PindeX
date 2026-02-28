import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AstNode, ParsedFile, ParsedSymbol, ParsedImport, SymbolKind, ParsedDocument, DocumentChunk } from '../types.js';

// CJS require wrapper — needed because tree-sitter ships as CommonJS but this
// package uses ESM ("type": "module"). createRequire gives us a proper require
// that also works with vi.mock() in Vitest (same module cache is used).
const _require = createRequire(import.meta.url);

// ─── Language Detection ───────────────────────────────────────────────────────

const EXTENSION_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  vue: 'vue',
  svelte: 'svelte',
  php: 'php',
  rb: 'ruby',
  cs: 'csharp',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  txt: 'text',
};

/** Returns true for file types that should be indexed as text documents (not code). */
export function isDocumentLanguage(language: string): boolean {
  return language === 'markdown' || language === 'yaml' || language === 'text';
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MAP[ext] ?? 'unknown';
}

// ─── Token Estimation ─────────────────────────────────────────────────────────

/** Estimates token count using the ~4 chars/token heuristic. */
export function estimateTokens(content: string): number {
  if (!content) return 0;
  return Math.ceil(content.length / 4);
}

// ─── Signature Building ───────────────────────────────────────────────────────

/** Builds a concise one-line signature for a declaration node. */
export function buildSignature(node: AstNode, kind: string): string {
  const namePart = node.childForFieldName('name');
  const name = namePart?.text ?? '';

  switch (kind) {
    case 'function':
    case 'method': {
      const params = node.childForFieldName('parameters');
      const returnType = node.childForFieldName('return_type');
      const paramText = params?.text ?? '()';
      const retText = returnType?.text ?? '';
      return `${name}${paramText}${retText}`.replace(/\s+/g, ' ').trim();
    }
    case 'class': {
      const heritage = node.childForFieldName('class_heritage');
      return heritage ? `class ${name} ${heritage.text}` : `class ${name}`;
    }
    case 'interface': {
      const heritage = node.childForFieldName('extends_clause');
      return heritage ? `interface ${name} ${heritage.text}` : `interface ${name}`;
    }
    case 'type': {
      const value = node.childForFieldName('value');
      const valueText = value?.text ?? '...';
      const truncated = valueText.length > 50 ? valueText.substring(0, 47) + '...' : valueText;
      return `type ${name} = ${truncated}`;
    }
    case 'enum': {
      return `enum ${name}`;
    }
    default:
      return name || node.text.split('\n')[0].trim().substring(0, 60);
  }
}

// ─── Symbol Extraction ────────────────────────────────────────────────────────

const DECLARATION_TYPES: Array<{ nodeType: string; kind: SymbolKind }> = [
  { nodeType: 'function_declaration', kind: 'function' },
  { nodeType: 'class_declaration', kind: 'class' },
  { nodeType: 'interface_declaration', kind: 'interface' },
  { nodeType: 'type_alias_declaration', kind: 'type' },
  { nodeType: 'enum_declaration', kind: 'enum' },
];

function nodeIsAsync(node: AstNode): boolean {
  return node.children.some((c) => c.type === 'async');
}

function nodeHasTryCatch(node: AstNode): boolean {
  return node.descendantsOfType('try_statement').length > 0;
}

function extractFromDeclarationNode(
  node: AstNode,
  kind: SymbolKind,
  isExported: boolean,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  return {
    name: nameNode.text,
    kind,
    signature: buildSignature(node, kind),
    startLine: node.startPosition.row + 1, // convert 0-indexed to 1-indexed
    endLine: node.endPosition.row + 1,
    isExported,
    isAsync: nodeIsAsync(node),
    hasTryCatch: nodeHasTryCatch(node),
  };
}

function extractMethodsFromClass(classNode: AstNode): ParsedSymbol[] {
  const methods: ParsedSymbol[] = [];
  const methodNodes = classNode.descendantsOfType('method_definition');

  for (const methodNode of methodNodes) {
    const nameNode = methodNode.childForFieldName('name');
    if (!nameNode) continue;
    const methodName = nameNode.text;
    if (methodName === 'constructor') continue;

    methods.push({
      name: methodName,
      kind: 'method',
      signature: buildSignature(methodNode, 'method'),
      startLine: methodNode.startPosition.row + 1,
      endLine: methodNode.endPosition.row + 1,
      isExported: false,
      isAsync: nodeIsAsync(methodNode),
      hasTryCatch: nodeHasTryCatch(methodNode),
    });
  }
  return methods;
}

function extractFromExportStatement(node: AstNode): ParsedSymbol[] {
  const declaration = node.childForFieldName('declaration');
  if (!declaration) return [];

  const symbols: ParsedSymbol[] = [];
  for (const { nodeType, kind } of DECLARATION_TYPES) {
    if (declaration.type === nodeType) {
      const sym = extractFromDeclarationNode(declaration, kind, true);
      if (sym) {
        symbols.push(sym);
        if (kind === 'class') {
          symbols.push(...extractMethodsFromClass(declaration));
        }
      }
      return symbols;
    }
  }

  // export const x = ...
  if (
    declaration.type === 'lexical_declaration' ||
    declaration.type === 'variable_declaration'
  ) {
    const declarators = declaration.descendantsOfType('variable_declarator');
    for (const decl of declarators) {
      const nameNode = decl.childForFieldName('name');
      if (!nameNode) continue;
      // Check if the value is an async function
      const valueNode = decl.childForFieldName('value');
      symbols.push({
        name: nameNode.text,
        kind: 'const',
        signature: nameNode.text,
        startLine: declaration.startPosition.row + 1,
        endLine: declaration.endPosition.row + 1,
        isExported: true,
        isAsync: valueNode ? nodeIsAsync(valueNode) : false,
        hasTryCatch: valueNode ? nodeHasTryCatch(valueNode) : false,
      });
    }
  }
  return symbols;
}

/** Extracts all symbols from a parsed AST root node. */
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'use']);

/** Tries to extract an Express-style route registration from an expression statement. */
function extractRouteFromExpression(node: AstNode): ParsedSymbol | null {
  // Look for a call_expression child
  const callNode = node.namedChildren.find((c) => c.type === 'call_expression');
  if (!callNode) return null;

  const fnNode = callNode.childForFieldName('function');
  if (!fnNode || fnNode.type !== 'member_expression') return null;

  const propNode = fnNode.childForFieldName('property');
  if (!propNode) return null;
  const method = propNode.text.toLowerCase();
  if (!HTTP_METHODS.has(method) || method === 'use') return null;

  // First argument should be the path string
  const argsNode = callNode.childForFieldName('arguments');
  if (!argsNode) return null;
  const firstArg = argsNode.namedChildren[0];
  if (!firstArg) return null;

  // Extract path — strip quotes
  let routePath = firstArg.text.replace(/^['"`]|['"`]$/g, '');
  if (!routePath.startsWith('/')) return null;

  const name = `${method.toUpperCase()} ${routePath}`;
  const handlerNode = argsNode.namedChildren[argsNode.namedChildren.length - 1];
  const hasTryCatch = handlerNode ? nodeHasTryCatch(handlerNode) : false;

  return {
    name,
    kind: 'route',
    signature: `${method.toUpperCase()} ${routePath}`,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: false,
    isAsync: true, // Express route handlers are typically async
    hasTryCatch,
  };
}

/** Extracts all symbols from a parsed AST root node. */
export function extractSymbols(rootNode: AstNode, _content: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.namedChildren) {
    // Handle export statements
    if (child.type === 'export_statement') {
      symbols.push(...extractFromExportStatement(child));
      continue;
    }

    // Detect Express route registrations
    if (child.type === 'expression_statement') {
      const route = extractRouteFromExpression(child);
      if (route) {
        symbols.push(route);
        continue;
      }
    }

    // Handle direct declarations
    for (const { nodeType, kind } of DECLARATION_TYPES) {
      if (child.type === nodeType) {
        const sym = extractFromDeclarationNode(child, kind, false);
        if (sym) {
          symbols.push(sym);
          if (kind === 'class') {
            symbols.push(...extractMethodsFromClass(child));
          }
        }
        break;
      }
    }
  }

  return symbols;
}

// ─── Import Extraction ────────────────────────────────────────────────────────

/** Extracts all import statements from a parsed AST root node. */
export function extractImports(rootNode: AstNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  const importNodes = rootNode.descendantsOfType('import_statement');
  for (const importNode of importNodes) {
    const sourceNode = importNode.childForFieldName('source');
    if (!sourceNode) continue;

    // Strip quotes from the source string
    const source = sourceNode.text.replace(/^['"`]|['"`]$/g, '');

    // Extract named imports
    const specifiers = importNode.descendantsOfType('import_specifier');
    const symbols = specifiers.map((spec) => {
      const nameNode = spec.childForFieldName('name');
      return nameNode?.text ?? spec.text;
    }).filter(Boolean);

    imports.push({ source, symbols });
  }

  return imports;
}

// ─── Regex-based Symbol Extraction ───────────────────────────────────────────
// Used for languages without a tree-sitter grammar. Each extractor returns
// symbols and imports parsed from the raw source text via regular expressions.

function regexSymbols(
  content: string,
  patterns: Array<{ re: RegExp; kind: SymbolKind }>,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const lines = content.split('\n');
  for (const { re, kind } of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const lineNum = content.slice(0, m.index).split('\n').length;
      const rawLine = lines[lineNum - 1] ?? '';
      const sig = rawLine.trim().replace(/\s+/g, ' ').substring(0, 80);
      symbols.push({ name, kind, signature: sig, startLine: lineNum, endLine: lineNum, isExported: true, isAsync: false, hasTryCatch: false });
    }
  }
  return symbols;
}

function parseJava(content: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols = regexSymbols(content, [
    { re: /^[ \t]*(?:(?:public|protected|private|static|abstract|final|sealed|non-sealed)\s+)*(?:class|interface|enum|record|@interface)\s+(\w+)/gm, kind: 'class' },
    { re: /^[ \t]+(?:(?:public|protected|private|static|abstract|final|synchronized|default|native)\s+)*(?:<[^>]+>\s+)?(?:void|boolean|int|long|double|float|String|[\w][\w.<>, \[\]]*?)\s+(\w+)\s*\(/gm, kind: 'method' },
  ]);
  const imports: ParsedImport[] = [];
  const importRe = /^import\s+(?:static\s+)?([^;]+);/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    const parts = m[1].trim().split('.');
    const sym = parts.pop() ?? '';
    imports.push({ source: parts.join('.'), symbols: sym === '*' ? [] : [sym] });
  }
  return { symbols, imports };
}

function parseKotlin(content: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols = regexSymbols(content, [
    { re: /^[ \t]*(?:(?:public|private|protected|internal|abstract|open|sealed|data|inner|inline|value|annotation|enum)\s+)*(?:class|interface|object)\s+(\w+)/gm, kind: 'class' },
    { re: /^[ \t]*(?:(?:public|private|protected|internal|override|abstract|open|suspend|inline|operator|infix|tailrec|external)\s+)*fun\s+(?:<[^>]+>\s+)?(\w+)\s*[(<]/gm, kind: 'function' },
  ]);
  const imports: ParsedImport[] = [];
  const importRe = /^import\s+([\w.]+)(?:\s+as\s+\w+)?/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    const parts = m[1].split('.');
    const sym = parts.pop() ?? '';
    imports.push({ source: parts.join('.'), symbols: sym === '*' ? [] : [sym] });
  }
  return { symbols, imports };
}

function parsePython(content: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols = regexSymbols(content, [
    { re: /^class\s+(\w+)/gm, kind: 'class' },
    { re: /^(?:async\s+)?def\s+(\w+)/gm, kind: 'function' },
  ]);
  const imports: ParsedImport[] = [];
  const fromRe = /^from\s+(\S+)\s+import\s+(.+)/gm;
  const plainRe = /^import\s+(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(content)) !== null) {
    const syms = m[2].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    imports.push({ source: m[1], symbols: syms });
  }
  while ((m = plainRe.exec(content)) !== null) {
    imports.push({ source: m[1], symbols: [] });
  }
  return { symbols, imports };
}

function parsePhp(content: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols = regexSymbols(content, [
    { re: /^(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(\w+)/gm, kind: 'class' },
    { re: /^[ \t]*(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+(\w+)\s*\(/gm, kind: 'function' },
  ]);
  const imports: ParsedImport[] = [];
  const useRe = /^use\s+([^;]+);/gm;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(content)) !== null) {
    const parts = m[1].trim().split('\\');
    const sym = parts.pop() ?? '';
    imports.push({ source: parts.join('\\'), symbols: [sym] });
  }
  return { symbols, imports };
}

function parseRuby(content: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols = regexSymbols(content, [
    { re: /^[ \t]*(?:(?:module|class)\s+(\w+))/gm, kind: 'class' },
    { re: /^[ \t]*def\s+(?:self\.)?(\w+[?!]?)/gm, kind: 'method' },
  ]);
  const imports: ParsedImport[] = [];
  const requireRe = /^[ \t]*require(?:_relative)?\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = requireRe.exec(content)) !== null) {
    imports.push({ source: m[1], symbols: [] });
  }
  return { symbols, imports };
}

function parseCsharp(content: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols = regexSymbols(content, [
    { re: /^[ \t]*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly)\s+)*(?:class|interface|struct|enum|record)\s+(\w+)/gm, kind: 'class' },
    { re: /^[ \t]*(?:(?:public|private|protected|internal|static|abstract|virtual|override|async|extern|sealed|new)\s+)*(?:<[^>]+>\s+)?[\w\[\]<>?,\s]+\s+(\w+)\s*\(/gm, kind: 'method' },
  ]);
  const imports: ParsedImport[] = [];
  const usingRe = /^using(?:\s+static)?\s+([\w.]+);/gm;
  let m: RegExpExecArray | null;
  while ((m = usingRe.exec(content)) !== null) {
    const parts = m[1].split('.');
    const sym = parts.pop() ?? '';
    imports.push({ source: parts.join('.'), symbols: [sym] });
  }
  return { symbols, imports };
}

function parseGo(content: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols = regexSymbols(content, [
    { re: /^type\s+(\w+)\s+(?:struct|interface)/gm, kind: 'class' },
    { re: /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*[(<[]/gm, kind: 'function' },
  ]);
  const imports: ParsedImport[] = [];
  // Single import: import "pkg"
  const singleRe = /^import\s+"([^"]+)"/gm;
  // Block import: import ( "pkg" )
  const blockRe = /"([^"]+)"/gm;
  const blockMatch = /^import\s*\(([^)]+)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(content)) !== null) {
    imports.push({ source: m[1], symbols: [] });
  }
  let block: RegExpExecArray | null;
  while ((block = blockMatch.exec(content)) !== null) {
    const inner = block[1];
    blockRe.lastIndex = 0;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(inner)) !== null) {
      imports.push({ source: bm[1], symbols: [] });
    }
  }
  return { symbols, imports };
}

function parseRust(content: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols = regexSymbols(content, [
    { re: /^(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait|union)\s+(\w+)/gm, kind: 'class' },
    { re: /^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm, kind: 'function' },
    { re: /^(?:pub(?:\([^)]+\))?\s+)?(?:type|const|static)\s+(\w+)/gm, kind: 'variable' },
  ]);
  const imports: ParsedImport[] = [];
  const useRe = /^use\s+([\w:*{}]+(?:::\{[^}]+\})?)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(content)) !== null) {
    imports.push({ source: m[1], symbols: [] });
  }
  return { symbols, imports };
}

/** Extracts the script block content from a Vue or Svelte SFC. */
function extractSfcScript(content: string): string {
  const m = /<script(?:\s[^>]*)?>([^]*?)<\/script>/i.exec(content);
  return m?.[1] ?? '';
}

// ─── Main Parse Function ──────────────────────────────────────────────────────

/** Parses a source file using tree-sitter and extracts symbols + imports.
 *  Falls back gracefully if tree-sitter fails. */
export function parseFile(filePath: string, content: string): ParsedFile {
  const language = detectLanguage(filePath);
  const rawTokenEstimate = estimateTokens(content);

  try {
    // _require is a createRequire-based CJS loader (see top of file).
    // Using _require keeps vi.mock('tree-sitter') working in Vitest because
    // both createRequire and vi.mock share the same Node module cache.
    const Parser = _require('tree-sitter') as { new(): { setLanguage(l: unknown): void; parse(s: string): { rootNode: AstNode } } };
    const parser = new Parser();

    // Route non-TS languages to regex-based parsers (no tree-sitter needed)
    if (language === 'java') {
      const { symbols, imports } = parseJava(content);
      return { language, symbols, imports, rawTokenEstimate };
    }
    if (language === 'kotlin') {
      const { symbols, imports } = parseKotlin(content);
      return { language, symbols, imports, rawTokenEstimate };
    }
    if (language === 'python') {
      const { symbols, imports } = parsePython(content);
      return { language, symbols, imports, rawTokenEstimate };
    }
    if (language === 'php') {
      const { symbols, imports } = parsePhp(content);
      return { language, symbols, imports, rawTokenEstimate };
    }
    if (language === 'ruby') {
      const { symbols, imports } = parseRuby(content);
      return { language, symbols, imports, rawTokenEstimate };
    }
    if (language === 'csharp') {
      const { symbols, imports } = parseCsharp(content);
      return { language, symbols, imports, rawTokenEstimate };
    }
    if (language === 'go') {
      const { symbols, imports } = parseGo(content);
      return { language, symbols, imports, rawTokenEstimate };
    }
    if (language === 'rust') {
      const { symbols, imports } = parseRust(content);
      return { language, symbols, imports, rawTokenEstimate };
    }
    if (language === 'vue' || language === 'svelte') {
      // Parse the <script> block as TypeScript via tree-sitter
      const scriptContent = extractSfcScript(content);
      if (!scriptContent.trim()) return { language, symbols: [], imports: [], rawTokenEstimate };
      const Parser = _require('tree-sitter') as { new(): { setLanguage(l: unknown): void; parse(s: string): { rootNode: AstNode } } };
      const parser = new Parser();
      const tsLangs = _require('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
      parser.setLanguage(tsLangs.typescript);
      const tree = parser.parse(scriptContent);
      const symbols = extractSymbols(tree.rootNode as AstNode, scriptContent);
      const imports = extractImports(tree.rootNode as AstNode);
      return { language, symbols, imports, rawTokenEstimate };
    }

    let lang: unknown;
    if (language === 'typescript' || language === 'tsx') {
      const tsLangs = _require('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
      lang = language === 'tsx' ? tsLangs.tsx : tsLangs.typescript;
    } else {
      return { language, symbols: [], imports: [], rawTokenEstimate };
    }

    parser.setLanguage(lang);
    const tree = parser.parse(content);
    const symbols = extractSymbols(tree.rootNode as AstNode, content);
    const imports = extractImports(tree.rootNode as AstNode);

    return { language, symbols, imports, rawTokenEstimate };
  } catch {
    // tree-sitter not available or failed – return metadata only
    return { language, symbols: [], imports: [], rawTokenEstimate };
  }
}

// ─── Document Parsing ─────────────────────────────────────────────────────────

const CHUNK_SIZE = 50; // lines per chunk for non-markdown files

/** Splits markdown content into chunks at heading boundaries. */
function splitMarkdownByHeadings(lines: string[]): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let chunkIndex = 0;
  let chunkStart = 0;
  let currentHeading: string | null = null;
  let chunkLines: string[] = [];

  function flush(endLine: number): void {
    if (chunkLines.length === 0) return;
    chunks.push({
      chunkIndex: chunkIndex++,
      heading: currentHeading,
      startLine: chunkStart + 1, // 1-indexed
      endLine: endLine,
      content: chunkLines.join('\n'),
    });
    chunkLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = /^#{1,3}\s+(.+)$/.exec(line);
    if (headingMatch) {
      if (i > chunkStart) {
        flush(i); // end previous chunk before heading
        chunkStart = i;
      }
      currentHeading = headingMatch[1].trim(); // always capture heading, even at line 0
    }
    chunkLines.push(line);
  }
  flush(lines.length);

  return chunks;
}

/** Splits any text into fixed-size line chunks. */
function splitByLines(lines: string[], chunkSize: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const slice = lines.slice(i, i + chunkSize);
    chunks.push({
      chunkIndex: chunks.length,
      heading: null,
      startLine: i + 1, // 1-indexed
      endLine: Math.min(i + chunkSize, lines.length),
      content: slice.join('\n'),
    });
  }
  return chunks;
}

/** Parses a document file into text chunks for indexing. */
export function parseDocument(filePath: string, content: string): ParsedDocument {
  const language = detectLanguage(filePath);
  const rawTokenEstimate = estimateTokens(content);
  const lines = content.split('\n');

  let chunks: DocumentChunk[];
  if (language === 'markdown') {
    chunks = splitMarkdownByHeadings(lines);
  } else {
    chunks = splitByLines(lines, CHUNK_SIZE);
  }

  // Filter empty chunks
  chunks = chunks.filter((c) => c.content.trim().length > 0);
  // Re-number after filtering
  chunks.forEach((c, i) => { c.chunkIndex = i; });

  return { language, chunks, rawTokenEstimate };
}

/** Computes an MD5 hash of the file content for change detection. */
export function hashContent(content: string): string {
  return createHash('md5').update(content).digest('hex');
}
