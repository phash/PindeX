import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { glob } from 'glob';
import type Database from 'better-sqlite3';
import type { IndexResult, ParsedFile, ParsedImport } from '../types.js';
import { ParsePool } from './parse-pool.js';
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
import { computeAstDiff, type AstDiffResult } from '../memory/ast-diff.js';
import { Summarizer, type SummarizerOptions } from './summarizer.js';
import { LspPythonClient } from './lsp-python.js';

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
  // PHP / Go
  '**/vendor/**',
];

/** Glob patterns per language name (as used in EXTENSION_MAP). */
export const LANGUAGE_PATTERNS: Record<string, string[]> = {
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
  go:          ['**/*.go'],
  rust:        ['**/*.rs'],
};

const DEFAULT_LANGUAGES = ['typescript', 'javascript'];

/** Maximum file size to index (1 MB). Larger files are skipped to prevent OOM. */
const MAX_FILE_SIZE = 1024 * 1024;

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
  summarizerOptions?: SummarizerOptions;
  documentPatterns?: string[];
  /** 0 = run parsing synchronously on main (test / small-project mode).
   *  undefined = auto-select based on CPU count. */
  maxParseWorkers?: number;
  /** Enable the LSP-backed Python parser. Default: process.env.PINDEX_LSP !== 'false'. */
  lspEnabled?: boolean;
}

export interface IndexAllOptions {
  additionalPaths?: string[];
  force?: boolean;
}

export interface IndexFileResult {
  status: 'indexed' | 'updated' | 'skipped' | 'error';
  errors: string[];
  /** AST-level diff vs. the previous snapshot; only present on 'indexed'/'updated'. */
  diff?: AstDiffResult;
}

export class Indexer {
  private readonly db: Database.Database;
  readonly projectRoot: string;
  private readonly languages: string[];
  private readonly ignorePatterns: string[];
  private readonly generateSummaries: boolean;
  private readonly summarizer: Summarizer;
  private readonly documentPatterns: string[];
  private pool: ParsePool | null = null;
  private readonly configuredMaxWorkers: number;
  private lastImportsCache: Map<string, ParsedImport[]> | null = null;
  private lsp: LspPythonClient | null = null;

  constructor(options: IndexerOptions) {
    this.db = options.db;
    this.projectRoot = resolve(options.projectRoot);
    this.languages = options.languages ?? DEFAULT_LANGUAGES;
    this.ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE;
    this.generateSummaries = options.generateSummaries ?? false;
    this.summarizer = new Summarizer(options.summarizerOptions ?? { enabled: false });
    this.documentPatterns = options.documentPatterns ?? DEFAULT_DOCUMENT_PATTERNS;
    this.configuredMaxWorkers = ParsePool.pickDefaultWorkerCount(options.maxParseWorkers);
    const lspEnabled = options.lspEnabled ?? (process.env.PINDEX_LSP !== 'false');
    if (lspEnabled) {
      this.lsp = new LspPythonClient({ projectRoot: this.projectRoot, enabled: true });
    }
  }

  /** Discovers and indexes all source files and document files in the project root. */
  async indexAll(options: IndexAllOptions = {}): Promise<IndexResult> {
    const result: IndexResult = { indexed: 0, updated: 0, skipped: 0, errors: [] };
    const codePatterns = buildCodePatterns(this.languages);

    const [codePaths, docPaths] = await Promise.all([
      glob(codePatterns, { cwd: this.projectRoot, ignore: this.ignorePatterns, absolute: false }),
      glob(this.documentPatterns, { cwd: this.projectRoot, ignore: this.ignorePatterns, absolute: false }),
    ]);

    const allCodePaths = [...codePaths, ...(options.additionalPaths ?? [])];

    const jobs = allCodePaths.map((rel) => ({
      absolutePath: join(this.projectRoot, rel),
      relativePath: rel,
    }));

    const importsCache = new Map<string, ParsedImport[]>();

    const effectiveWorkers = ParsePool.pickEffectiveWorkerCount(
      jobs.length,
      this.configuredMaxWorkers,
    );
    // Close any pool from a prior indexAll call and size a new one for this batch.
    if (this.pool) await this.pool.close();
    this.pool = new ParsePool({ maxWorkers: effectiveWorkers });

    for await (const parseResult of this.pool.parseMany(jobs)) {
      if (parseResult.status === 'skipped') {
        result.skipped++;
        continue;
      }
      if (parseResult.status === 'error') {
        result.errors.push(parseResult.error);
        continue;
      }
      const fileRes = await this.processParsedFile(
        parseResult.relativePath,
        parseResult.parsed,
        parseResult.content,
        parseResult.hash,
        options.force ?? false,
      );
      if (fileRes.status === 'indexed') result.indexed++;
      else if (fileRes.status === 'updated') result.updated++;
      else if (fileRes.status === 'skipped') result.skipped++;
      result.errors.push(...fileRes.errors);

      importsCache.set(parseResult.relativePath, parseResult.parsed.imports);
    }

    // Documents stay sequential; they are few and cheap.
    for (const relativePath of docPaths) {
      const fileResult = await this.indexDocument(relativePath, options.force);
      if (fileResult.status === 'indexed') result.indexed++;
      else if (fileResult.status === 'updated') result.updated++;
      else if (fileResult.status === 'skipped') result.skipped++;
      result.errors.push(...fileResult.errors);
    }

    // Stash the cache for resolveDependencies (Task 7 will consume it).
    this.lastImportsCache = importsCache;

    return result;
  }

  /** Indexes (or re-indexes) a single file given its project-relative path. */
  async indexFile(relativePath: string, force = false): Promise<IndexFileResult> {
    const absolutePath = join(this.projectRoot, relativePath);

    if (!existsSync(absolutePath)) {
      return { status: 'error', errors: [`File not found: ${relativePath}`] };
    }

    try {
      const stat = statSync(absolutePath);
      if (stat.size > MAX_FILE_SIZE) {
        return { status: 'skipped', errors: [] };
      }
    } catch { /* fall through to read attempt */ }

    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      return { status: 'error', errors: [`Failed to read ${relativePath}: ${String(err)}`] };
    }

    const hash = hashContent(content);

    // Fast path: skip re-parsing unchanged files. The watcher hot path
    // relies on this short-circuit; ParsePool-backed indexAll bypasses
    // indexFile so it does not pay this extra lookup.
    if (!force) {
      const existing = getFileByPath(this.db, relativePath);
      if (existing && existing.hash === hash) {
        return { status: 'skipped', errors: [] };
      }
    }

    let parsed: ParsedFile;
    try {
      parsed = parseFile(absolutePath, content);
    } catch (err) {
      return { status: 'error', errors: [`Failed to parse ${relativePath}: ${String(err)}`] };
    }

    return this.processParsedFile(relativePath, parsed, content, hash, force);
  }

  /** Everything that happens after a file has been read, parsed, and hashed.
   *  Runs entirely on the main thread: summarizer → AST diff → DB transaction. */
  private async processParsedFile(
    relativePath: string,
    parsed: ParsedFile,
    content: string,
    hash: string,
    force: boolean,
  ): Promise<IndexFileResult> {
    const existing = getFileByPath(this.db, relativePath);
    if (!force && existing && existing.hash === hash) {
      return { status: 'skipped', errors: [] };
    }
    const isUpdate = existing !== null;

    if (parsed.language === 'python' && this.lsp) {
      if (this.lsp.state === 'idle') {
        // Fire-and-forget: first Python file proceeds with the regex result
        // while pyright warms up. Subsequent files get LSP-quality output.
        this.lsp.start().catch((err) => {
          process.stderr.write(`[pindex] LSP start failed: ${String(err)}\n`);
        });
      }
      if (this.lsp.ready) {
        const upgraded = await this.lsp.getDocumentSymbols(relativePath, content);
        if (upgraded) {
          parsed = { ...parsed, symbols: upgraded.symbols, imports: upgraded.imports };
        }
      }
    }

    let fileSummary: string | null = null;
    const symbolSummaries = new Map<string, string | null>();

    if (this.generateSummaries) {
      fileSummary = await this.summarizer.summarizeFile(relativePath, content);
      const symbolEntries = parsed.symbols.map(async (sym) => {
        const snippet = content.split('\n').slice(sym.startLine - 1, sym.endLine).join('\n');
        const summary = await this.summarizer.summarizeSymbol(sym.signature, snippet);
        return [sym.name, summary] as const;
      });
      for (const [name, summary] of await Promise.all(symbolEntries)) {
        symbolSummaries.set(name, summary);
      }
    }

    try {
      const runInTransaction = this.db.transaction(() => {
        upsertFile(this.db, {
          path: relativePath,
          language: parsed.language,
          hash,
          rawTokenEstimate: parsed.rawTokenEstimate,
          summary: fileSummary,
        });
        const fileRecord = getFileByPath(this.db, relativePath)!;
        const diff = computeAstDiff(this.db, relativePath, parsed.symbols);
        deleteSymbolsByFileId(this.db, fileRecord.id);
        for (const sym of parsed.symbols) {
          upsertSymbol(this.db, {
            fileId: fileRecord.id,
            name: sym.name,
            kind: sym.kind,
            signature: sym.signature,
            summary: symbolSummaries.get(sym.name) ?? null,
            startLine: sym.startLine,
            endLine: sym.endLine,
            isExported: sym.isExported,
            isAsync: sym.isAsync,
            hasTryCatch: sym.hasTryCatch,
          });
        }
        deleteDependenciesByFile(this.db, fileRecord.id);
        return diff;
      });
      const diff = runInTransaction();
      return { status: isUpdate ? 'updated' : 'indexed', errors: [], diff };
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

    // Skip oversized documents (same guard as indexFile)
    try {
      const stat = statSync(absolutePath);
      if (stat.size > MAX_FILE_SIZE) {
        return { status: 'skipped', errors: [] };
      }
    } catch { /* fall through */ }

    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      return { status: 'error', errors: [`Failed to read ${relativePath}: ${String(err)}`] };
    }

    const hash = hashContent(content);

    // Single DB lookup instead of triple
    const existing = getFileByPath(this.db, relativePath);
    if (!force && existing && existing.hash === hash) {
      return { status: 'skipped', errors: [] };
    }
    const isUpdate = existing !== null;

    try {
      const parsed = parseDocument(absolutePath, content);

      const runInTransaction = this.db.transaction(() => {
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
      });

      runInTransaction();
      return { status: isUpdate ? 'updated' : 'indexed', errors: [] };
    } catch (err) {
      return { status: 'error', errors: [`Failed to index document ${relativePath}: ${String(err)}`] };
    }
  }

  /** Resolves import strings to file IDs and stores dependencies.
   *  Fast path: pass an importsCache built during indexAll() to skip re-reading
   *  and re-parsing every file. Slow path (no cache) re-parses as before. */
  async resolveDependencies(importsCache?: Map<string, ParsedImport[]>): Promise<void> {
    const cache = importsCache ?? this.lastImportsCache ?? undefined;
    const { getAllFiles } = await import('../db/queries.js');
    const allFiles = getAllFiles(this.db);
    const pathIndex = new Map(allFiles.map((f) => [f.path, f.id]));
    const knownPaths = new Set(pathIndex.keys());

    for (const file of allFiles) {
      let imports: ParsedImport[] | undefined;

      if (cache && cache.has(file.path)) {
        imports = cache.get(file.path);
      } else {
        const absolutePath = join(this.projectRoot, file.path);
        if (!existsSync(absolutePath)) continue;
        try {
          const content = readFileSync(absolutePath, 'utf-8');
          imports = parseFile(absolutePath, content).imports;
        } catch (err) {
          process.stderr.write(
            `[pindex] resolveDependencies: re-parse failed for ${file.path}: ${String(err)}\n`,
          );
          continue;
        }
      }

      if (!imports) continue;

      deleteDependenciesByFile(this.db, file.id);
      for (const imp of imports) {
        const resolvedPath = this.resolveImportPath(file.path, imp.source, knownPaths);
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
    }
  }

  /** Terminates any worker threads owned by the parse pool. Safe to call
   *  multiple times; no-op when no pool was ever constructed. */
  async closePool(): Promise<void> {
    if (this.lsp) {
      await this.lsp.close();
      this.lsp = null;
    }
    if (!this.pool) return;
    await this.pool.close();
    this.pool = null;
  }

  /** Resolves a relative import path to a project-relative file path. */
  private resolveImportPath(fromFile: string, importSource: string, knownPaths?: Set<string>): string | null {
    if (!importSource.startsWith('.')) return null; // Skip external packages

    const fromDir = dirname(fromFile).replace(/\\/g, '/');
    const extensions = ['.ts', '.tsx', '.js', '/index.ts', '/index.js'];

    for (const ext of extensions) {
      const candidate = join(fromDir, importSource + ext).replace(/\\/g, '/');
      if (knownPaths ? knownPaths.has(candidate) : existsSync(join(this.projectRoot, candidate))) {
        return candidate;
      }
    }

    // Try without extension (already has extension)
    const withoutResolve = join(fromDir, importSource).replace(/\\/g, '/');
    if (knownPaths ? knownPaths.has(withoutResolve) : existsSync(join(this.projectRoot, withoutResolve))) {
      return withoutResolve;
    }

    return null;
  }
}
