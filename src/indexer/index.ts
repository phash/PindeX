import { readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { glob } from 'glob';
import type Database from 'better-sqlite3';
import type { IndexResult } from '../types.js';
import { parseFile, parseDocument, hashContent } from './parser.js';
import {
  upsertFile,
  upsertSymbol,
  upsertDependency,
  deleteSymbolsByFileId,
  deleteDependenciesByFile,
  deleteUsagesByFile,
  getFileByPath,
  insertDocumentChunk,
  deleteDocumentChunksByFileId,
} from '../db/queries.js';

// ─── Default Configuration ────────────────────────────────────────────────────

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/*.min.js',
  '**/*.d.ts',
  // Java / Kotlin build artifacts
  '**/target/**',
  '**/.gradle/**',
  '**/out/**',
  // Python
  '**/__pycache__/**',
  '**/*.pyc',
  '**/.venv/**',
  '**/venv/**',
  // PHP
  '**/vendor/**',
];

/** Glob patterns per language name (as used in EXTENSION_MAP). */
const LANGUAGE_PATTERNS: Record<string, string[]> = {
  typescript:  ['**/*.ts', '**/*.tsx'],
  javascript:  ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.jsx'],
  java:        ['**/*.java'],
  kotlin:      ['**/*.kt', '**/*.kts'],
  python:      ['**/*.py'],
  vue:         ['**/*.vue'],
  svelte:      ['**/*.svelte'],
  php:         ['**/*.php'],
  ruby:        ['**/*.rb'],
  csharp:      ['**/*.cs'],
};

const DEFAULT_LANGUAGES = ['typescript', 'javascript'];

/** Builds the set of glob patterns for the given language list. */
function buildCodePatterns(languages: string[]): string[] {
  const patterns = new Set<string>();
  for (const lang of languages) {
    for (const p of LANGUAGE_PATTERNS[lang] ?? []) patterns.add(p);
  }
  return [...patterns];
}

const DEFAULT_DOCUMENT_PATTERNS = [
  '**/*.md',
  '**/*.markdown',
  '**/*.yaml',
  '**/*.yml',
  '**/*.txt',
];

// ─── Indexer Class ────────────────────────────────────────────────────────────

export interface IndexerOptions {
  db: Database.Database;
  projectRoot: string;
  languages?: string[];
  ignorePatterns?: string[];
  generateSummaries?: boolean;
  documentPatterns?: string[];
}

export interface IndexAllOptions {
  additionalPaths?: string[];
  force?: boolean;
}

export interface IndexFileResult {
  status: 'indexed' | 'updated' | 'skipped' | 'error';
  errors: string[];
}

export class Indexer {
  private readonly db: Database.Database;
  readonly projectRoot: string;
  private readonly languages: string[];
  private readonly ignorePatterns: string[];
  private readonly generateSummaries: boolean;
  private readonly documentPatterns: string[];

  constructor(options: IndexerOptions) {
    this.db = options.db;
    this.projectRoot = resolve(options.projectRoot);
    this.languages = options.languages ?? DEFAULT_LANGUAGES;
    this.ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE;
    this.generateSummaries = options.generateSummaries ?? false;
    this.documentPatterns = options.documentPatterns ?? DEFAULT_DOCUMENT_PATTERNS;
  }

  /** Discovers and indexes all source files and document files in the project root. */
  async indexAll(options: IndexAllOptions = {}): Promise<IndexResult> {
    const result: IndexResult = { indexed: 0, updated: 0, skipped: 0, errors: [] };
    const codePatterns = buildCodePatterns(this.languages);

    const [codePaths, docPaths] = await Promise.all([
      glob(codePatterns, {
        cwd: this.projectRoot,
        ignore: this.ignorePatterns,
        absolute: false,
      }),
      glob(this.documentPatterns, {
        cwd: this.projectRoot,
        ignore: this.ignorePatterns,
        absolute: false,
      }),
    ]);

    // Include any additional paths requested
    const allCodePaths = [...codePaths, ...(options.additionalPaths ?? [])];

    for (const relativePath of allCodePaths) {
      const fileResult = await this.indexFile(relativePath, options.force);
      if (fileResult.status === 'indexed') result.indexed++;
      else if (fileResult.status === 'updated') result.updated++;
      else if (fileResult.status === 'skipped') result.skipped++;
      result.errors.push(...fileResult.errors);
    }

    for (const relativePath of docPaths) {
      const fileResult = await this.indexDocument(relativePath, options.force);
      if (fileResult.status === 'indexed') result.indexed++;
      else if (fileResult.status === 'updated') result.updated++;
      else if (fileResult.status === 'skipped') result.skipped++;
      result.errors.push(...fileResult.errors);
    }

    return result;
  }

  /** Indexes (or re-indexes) a single file given its project-relative path. */
  async indexFile(relativePath: string, force = false): Promise<IndexFileResult> {
    const absolutePath = join(this.projectRoot, relativePath);

    if (!existsSync(absolutePath)) {
      return {
        status: 'error',
        errors: [`File not found: ${relativePath}`],
      };
    }

    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      return {
        status: 'error',
        errors: [`Failed to read ${relativePath}: ${String(err)}`],
      };
    }

    const hash = hashContent(content);

    // Check if file has changed (skip if unchanged)
    if (!force) {
      const existing = getFileByPath(this.db, relativePath);
      if (existing && existing.hash === hash) {
        return { status: 'skipped', errors: [] };
      }
    }

    const isUpdate = getFileByPath(this.db, relativePath) !== null;

    try {
      const parsed = parseFile(absolutePath, content);

      // Update file record
      upsertFile(this.db, {
        path: relativePath,
        language: parsed.language,
        hash,
        rawTokenEstimate: parsed.rawTokenEstimate,
        summary: null,
      });

      const fileRecord = getFileByPath(this.db, relativePath)!;

      // Replace symbols for this file
      deleteSymbolsByFileId(this.db, fileRecord.id);
      for (const sym of parsed.symbols) {
        upsertSymbol(this.db, {
          fileId: fileRecord.id,
          name: sym.name,
          kind: sym.kind,
          signature: sym.signature,
          summary: null,
          startLine: sym.startLine,
          endLine: sym.endLine,
          isExported: sym.isExported,
        });
      }

      // Update dependencies
      deleteDependenciesByFile(this.db, fileRecord.id);
      // Note: dependency resolution (finding to_file IDs) happens after all files are indexed.
      // We store the raw import sources first; a second pass resolves them.
      // For now, store as strings using the _resolveAndStoreDependencies helper below.

      return { status: isUpdate ? 'updated' : 'indexed', errors: [] };
    } catch (err) {
      return {
        status: 'error',
        errors: [`Failed to index ${relativePath}: ${String(err)}`],
      };
    }
  }

  /** Indexes (or re-indexes) a single document file given its project-relative path. */
  async indexDocument(relativePath: string, force = false): Promise<IndexFileResult> {
    const absolutePath = join(this.projectRoot, relativePath);

    if (!existsSync(absolutePath)) {
      return { status: 'error', errors: [`File not found: ${relativePath}`] };
    }

    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      return { status: 'error', errors: [`Failed to read ${relativePath}: ${String(err)}`] };
    }

    const hash = hashContent(content);

    if (!force) {
      const existing = getFileByPath(this.db, relativePath);
      if (existing && existing.hash === hash) {
        return { status: 'skipped', errors: [] };
      }
    }

    const isUpdate = getFileByPath(this.db, relativePath) !== null;

    try {
      const parsed = parseDocument(absolutePath, content);

      upsertFile(this.db, {
        path: relativePath,
        language: parsed.language,
        hash,
        rawTokenEstimate: parsed.rawTokenEstimate,
        summary: null,
      });

      const fileRecord = getFileByPath(this.db, relativePath)!;

      deleteDocumentChunksByFileId(this.db, fileRecord.id);
      for (const chunk of parsed.chunks) {
        insertDocumentChunk(this.db, {
          fileId: fileRecord.id,
          chunkIndex: chunk.chunkIndex,
          heading: chunk.heading,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
        });
      }

      return { status: isUpdate ? 'updated' : 'indexed', errors: [] };
    } catch (err) {
      return { status: 'error', errors: [`Failed to index document ${relativePath}: ${String(err)}`] };
    }
  }

  /** Second-pass: resolves import strings to file IDs and stores dependencies. */
  async resolveDependencies(): Promise<void> {
    // Re-parse all files to extract imports, then match to known file paths
    const { getAllFiles } = await import('../db/queries.js');
    const allFiles = getAllFiles(this.db);
    const pathIndex = new Map(allFiles.map((f) => [f.path, f.id]));

    for (const file of allFiles) {
      const absolutePath = join(this.projectRoot, file.path);
      if (!existsSync(absolutePath)) continue;

      try {
        const content = readFileSync(absolutePath, 'utf-8');
        const parsed = parseFile(absolutePath, content);

        deleteDependenciesByFile(this.db, file.id);

        for (const imp of parsed.imports) {
          // Resolve relative imports to known project files
          const resolvedPath = this.resolveImportPath(file.path, imp.source);
          if (!resolvedPath) continue;

          const toFileId = pathIndex.get(resolvedPath);
          if (!toFileId) continue;

          for (const sym of imp.symbols.length > 0 ? imp.symbols : [null]) {
            upsertDependency(this.db, {
              fromFile: file.id,
              toFile: toFileId,
              symbolName: sym,
            });
          }
        }
      } catch {
        // Silently skip files that fail dependency resolution
      }
    }
  }

  /** Resolves a relative import path to a project-relative file path. */
  private resolveImportPath(fromFile: string, importSource: string): string | null {
    if (!importSource.startsWith('.')) return null; // Skip external packages

    const fromDir = fromFile.split('/').slice(0, -1).join('/');
    const extensions = ['.ts', '.tsx', '.js', '/index.ts', '/index.js'];

    for (const ext of extensions) {
      const candidate = join(fromDir, importSource + ext).replace(/\\/g, '/');
      if (existsSync(join(this.projectRoot, candidate))) {
        return candidate;
      }
    }

    // Try without extension (already has extension)
    const withoutResolve = join(fromDir, importSource).replace(/\\/g, '/');
    if (existsSync(join(this.projectRoot, withoutResolve))) {
      return withoutResolve;
    }

    return null;
  }
}
