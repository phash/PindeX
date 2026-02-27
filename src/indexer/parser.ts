import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AstNode, ParsedFile, ParsedSymbol, ParsedImport, SymbolKind, ParsedDocument, DocumentChunk } from '../types.js';

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
      symbols.push({
        name: nameNode.text,
        kind: 'const',
        signature: nameNode.text,
        startLine: declaration.startPosition.row + 1,
        endLine: declaration.endPosition.row + 1,
        isExported: true,
      });
    }
  }
  return symbols;
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

// ─── Main Parse Function ──────────────────────────────────────────────────────

/** Parses a source file using tree-sitter and extracts symbols + imports.
 *  Falls back gracefully if tree-sitter fails. */
export function parseFile(filePath: string, content: string): ParsedFile {
  const language = detectLanguage(filePath);
  const rawTokenEstimate = estimateTokens(content);

  try {
    // Dynamic import to allow mocking in tests
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Parser = require('tree-sitter');
    const parser = new Parser();

    let lang: unknown;
    if (language === 'typescript' || language === 'tsx') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tsLangs = require('tree-sitter-typescript');
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
    if (headingMatch && i > chunkStart) {
      flush(i); // end previous chunk before heading
      chunkStart = i;
      currentHeading = headingMatch[1].trim();
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
