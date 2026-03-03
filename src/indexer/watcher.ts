import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { type Indexer, LANGUAGE_PATTERNS } from './index.js';
import type { SessionObserver } from '../memory/observer.js';
import { deleteFile } from '../db/queries.js';

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

    this.watcher = chokidar.watch(patterns, {
      cwd: this.options.projectRoot,
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      persistent: true,
      ignoreInitial: true,
    });

    (this.watcher as ReturnType<typeof chokidar.watch>)
      .on('add', (path: string) => this.debouncedHandleChange('add', path))
      .on('change', (path: string) => this.debouncedHandleChange('change', path))
      .on('unlink', (path: string) => this.debouncedHandleChange('unlink', path));
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
    const event: FileChangeEvent = { type, path };
    this.emit('change', event);

    if (type === 'add' || type === 'change') {
      try {
        const result = await this.indexer.indexFile(path, true);
        this.emit('indexed', path);
        if (this.observer && result.diff) {
          this.observer.onFileDiff(result.diff);
        }
      } catch (err) {
        this.emit('error', err);
      }
    } else if (type === 'unlink') {
      try {
        deleteFile(this.options.db, path);
        this.emit('removed', path);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }
}
