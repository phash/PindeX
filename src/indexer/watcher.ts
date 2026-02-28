import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { Indexer } from './index.js';
import type { SessionObserver } from '../memory/observer.js';

export interface WatcherOptions {
  db: Database.Database;
  indexer: Indexer;
  projectRoot: string;
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

    this.watcher = chokidar.watch(['**/*.ts', '**/*.tsx', '**/*.js'], {
      cwd: this.options.projectRoot,
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      persistent: true,
      ignoreInitial: true,
    });

    (this.watcher as ReturnType<typeof chokidar.watch>)
      .on('add', (path: string) => this.handleChange('add', path))
      .on('change', (path: string) => this.handleChange('change', path))
      .on('unlink', (path: string) => this.handleChange('unlink', path));
  }

  /** Stops the file watcher. */
  async stop(): Promise<void> {
    if (this.watcher) {
      await (this.watcher as { close(): Promise<void> }).close();
      this.watcher = null;
      this.started = false;
    }
  }

  private async handleChange(type: 'add' | 'change' | 'unlink', path: string): Promise<void> {
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
    }
    // Note: 'unlink' events could trigger file removal from the index
    // (future enhancement – for now we leave stale entries)
  }
}
