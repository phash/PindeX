import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { type Indexer, LANGUAGE_PATTERNS } from './index.js';
import { detectLanguage, isDocumentLanguage } from './parser.js';
import type { SessionObserver } from '../memory/observer.js';
import { deleteFile } from '../db/queries.js';
import { createWatchFilter, type WatchFilter } from './watch-filter.js';

export interface WatcherOptions {
  db: Database.Database;
  indexer: Indexer;
  projectRoot: string;
  languages?: string[];
  observer?: SessionObserver;
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
}

export class FileWatcher extends EventEmitter {
  private readonly indexer: Indexer;
  private readonly observer?: SessionObserver;
  private watcher: unknown = null;
  private filter: WatchFilter | null = null;
  private ready: Promise<void> = Promise.resolve();
  private started = false;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DEBOUNCE_MS = 300;

  constructor(private readonly options: WatcherOptions) {
    super();
    this.indexer = options.indexer;
    this.observer = options.observer;
  }

  /** Starts watching the project directory for file changes. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Dynamic import allows mocking chokidar in tests
    const { default: chokidar } = await import('chokidar');

    // Build glob patterns from configured languages (falls back to TS/JS)
    const languages = this.options.languages ?? ['typescript', 'javascript'];
    const patterns: string[] = [];
    for (const lang of languages) {
      const langPatterns = LANGUAGE_PATTERNS[lang];
      if (langPatterns) patterns.push(...langPatterns);
    }
    if (patterns.length === 0) {
      patterns.push('**/*.ts', '**/*.tsx', '**/*.js');
    }
    patterns.push(...this.indexer.documentGlobs);

    // chokidar 4 has no glob support: watch the root, filter with the same globs.
    this.filter = createWatchFilter({
      projectRoot: this.options.projectRoot,
      include: patterns,
      ignore: this.indexer.ignorePatterns,
    });
    this.watcher = chokidar.watch(this.options.projectRoot, {
      cwd: this.options.projectRoot,
      ignored: this.filter.ignored,
      persistent: true,
      ignoreInitial: true,
    });

    this.ready = new Promise<void>((resolve) => {
      (this.watcher as ReturnType<typeof chokidar.watch>).on('ready', () => resolve());
    });
    (this.watcher as ReturnType<typeof chokidar.watch>)
      .on('add', (path: string) => this.debouncedHandleChange('add', path))
      .on('change', (path: string) => this.debouncedHandleChange('change', path))
      .on('unlink', (path: string) => this.debouncedHandleChange('unlink', path));
  }

  /** Resolves once chokidar finished its initial scan; changes before that may be missed. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Stops the file watcher. */
  async stop(): Promise<void> {
    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await (this.watcher as { close(): Promise<void> }).close();
      this.watcher = null;
      this.started = false;
    }
  }

  /** Debounces handleChange per file path (300ms). */
  private debouncedHandleChange(type: 'add' | 'change' | 'unlink', path: string): void {
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);
      this.handleChange(type, path).catch((err) => this.emit('error', err));
    }, FileWatcher.DEBOUNCE_MS);
    this.debounceTimers.set(path, timer);
  }

  private async handleChange(type: 'add' | 'change' | 'unlink', path: string): Promise<void> {
    // Normalize to forward slashes (chokidar may emit backslashes on Windows)
    path = path.replace(/\\/g, '/');
    // Unlinks (and entries chokidar could not stat) reach us unfiltered.
    if (this.filter && !this.filter.accepts(path)) return;
    const event: FileChangeEvent = { type, path };
    this.emit('change', event);

    if (type === 'add' || type === 'change') {
      try {
        const isDoc = isDocumentLanguage(detectLanguage(path));
        const result = isDoc
          ? await this.indexer.indexDocument(path, false)
          : await this.indexer.indexFile(path, false);
        // A new file may satisfy imports of already indexed files that failed to resolve before.
        if (type === 'add' && !isDoc && result.status === 'indexed') {
          this.indexer.resolveImportersOf(path);
        }
        this.emit('indexed', path);
        if (this.observer && 'diff' in result && result.diff) {
          this.observer.onFileDiff(result.diff);
        }
      } catch (err) {
        this.emit('error', err);
      }
    } else if (type === 'unlink') {
      try {
        deleteFile(this.options.db, path);
        this.indexer.forgetFile(path);
        this.emit('removed', path);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }
}

/** Attaches an 'error' listener so watcher errors are logged instead of crashing the process. */
export function attachWatcherErrorLogger(
  watcher: EventEmitter,
  write: (line: string) => void = (line) => { process.stderr.write(line); },
): void {
  watcher.on('error', (err: unknown) => {
    write(`[pindex] File watcher error: ${String(err)}\n`);
  });
}
