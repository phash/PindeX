import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Indexer } from '../../src/indexer/index.js';
import type { SessionObserver } from '../../src/memory/observer.js';

// ─── Local chokidar mock (TST-01) ─────────────────────────────────────────────
// The global mock in tests/setup.ts never emits events. Override it here so the
// test can drive 'add' / 'change' / 'unlink' callbacks directly. The callback
// registry is created via vi.hoisted so the mock factory (hoisted above imports)
// can reference it.
const chokidarState = vi.hoisted(() => {
  return {
    // event name -> registered callback
    handlers: new Map<string, (path: string) => void>(),
    watchCalls: [] as Array<{ patterns: unknown; options: unknown }>,
    closeMock: vi.fn().mockResolvedValue(undefined),
    reset(): void {
      this.handlers.clear();
      this.watchCalls.length = 0;
      this.closeMock.mockClear();
    },
    emit(event: string, path: string): void {
      const cb = this.handlers.get(event);
      if (cb) cb(path);
    },
  };
});

vi.mock('chokidar', () => {
  const makeWatcher = () => {
    const watcher = {
      on(event: string, cb: (path: string) => void) {
        chokidarState.handlers.set(event, cb);
        return watcher; // chainable, like chokidar
      },
      close: chokidarState.closeMock,
    };
    return watcher;
  };
  const watch = vi.fn((patterns: unknown, options: unknown) => {
    chokidarState.watchCalls.push({ patterns, options });
    return makeWatcher();
  });
  return { default: { watch }, watch };
});

// Mock deleteFile from db/queries — the watcher calls it on 'unlink'. Keep the
// rest of the module intact so nothing else in the import graph breaks.
const deleteFileMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/queries.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/db/queries.js')>();
  return { ...actual, deleteFile: deleteFileMock };
});

import { FileWatcher } from '../../src/indexer/watcher.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 300;
const fakeDb = {} as Database.Database;

function makeStubIndexer(): { indexFile: ReturnType<typeof vi.fn> } & Pick<Indexer, never> {
  return {
    indexFile: vi.fn().mockResolvedValue({ status: 'indexed', errors: [] }),
  } as never;
}

describe('FileWatcher (TST-01)', () => {
  let indexer: ReturnType<typeof makeStubIndexer>;

  beforeEach(() => {
    chokidarState.reset();
    deleteFileMock.mockReset();
    vi.useFakeTimers();
    indexer = makeStubIndexer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers add/change/unlink handlers on start', async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    expect(chokidarState.watchCalls).toHaveLength(1);
    expect(chokidarState.handlers.has('add')).toBe(true);
    expect(chokidarState.handlers.has('change')).toBe(true);
    expect(chokidarState.handlers.has('unlink')).toBe(true);
  });

  it("calls indexer.indexFile after the debounce on 'add'", async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    chokidarState.emit('add', 'src/new.ts');
    expect(indexer.indexFile).not.toHaveBeenCalled(); // debounced

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(indexer.indexFile).toHaveBeenCalledTimes(1);
    expect(indexer.indexFile).toHaveBeenCalledWith('src/new.ts', true);
  });

  it("calls indexer.indexFile after the debounce on 'change'", async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    chokidarState.emit('change', 'src/edited.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(indexer.indexFile).toHaveBeenCalledTimes(1);
    expect(indexer.indexFile).toHaveBeenCalledWith('src/edited.ts', true);
  });

  it('normalizes backslash paths to forward slashes before indexing', async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    chokidarState.emit('change', 'src\\windows\\file.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(indexer.indexFile).toHaveBeenCalledWith('src/windows/file.ts', true);
  });

  it("calls deleteFile (not indexFile) on 'unlink', normalized", async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    chokidarState.emit('unlink', 'src\\gone.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(indexer.indexFile).not.toHaveBeenCalled();
    expect(deleteFileMock).toHaveBeenCalledTimes(1);
    expect(deleteFileMock).toHaveBeenCalledWith(fakeDb, 'src/gone.ts');
  });

  it('coalesces multiple rapid changes to the same file into one index call', async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    // Three rapid changes within the debounce window.
    chokidarState.emit('change', 'src/hot.ts');
    await vi.advanceTimersByTimeAsync(100);
    chokidarState.emit('change', 'src/hot.ts');
    await vi.advanceTimersByTimeAsync(100);
    chokidarState.emit('change', 'src/hot.ts');

    // Not yet fired — the timer keeps resetting.
    expect(indexer.indexFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(indexer.indexFile).toHaveBeenCalledTimes(1);
    expect(indexer.indexFile).toHaveBeenCalledWith('src/hot.ts', true);
  });

  it('emits "indexed" after a successful index', async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    const indexed: string[] = [];
    watcher.on('indexed', (p) => indexed.push(p));

    chokidarState.emit('add', 'src/a.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(indexed).toEqual(['src/a.ts']);
  });

  it('emits "removed" after a successful delete', async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    const removed: string[] = [];
    watcher.on('removed', (p) => removed.push(p));

    chokidarState.emit('unlink', 'src/b.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(removed).toEqual(['src/b.ts']);
  });

  it('emits a normalized "change" event for every file event', async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    const events: Array<{ type: string; path: string }> = [];
    watcher.on('change', (e) => events.push(e));

    chokidarState.emit('add', 'src\\c.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(events).toEqual([{ type: 'add', path: 'src/c.ts' }]);
  });

  it('invokes the observer.onFileDiff hook when a diff is produced', async () => {
    const diff = { added: [], removed: [], sigChanged: [] };
    indexer.indexFile.mockResolvedValue({ status: 'updated', errors: [], diff });
    const observer = { onFileDiff: vi.fn() } as never as SessionObserver;

    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
      observer,
    });
    await watcher.start();

    chokidarState.emit('change', 'src/d.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect((observer.onFileDiff as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((observer.onFileDiff as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(diff);
  });

  it('does not call the observer when no observer is configured', async () => {
    const diff = { added: [], removed: [], sigChanged: [] };
    indexer.indexFile.mockResolvedValue({ status: 'updated', errors: [], diff });

    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    // No observer wired — should simply not throw.
    chokidarState.emit('change', 'src/e.ts');
    await expect(vi.advanceTimersByTimeAsync(DEBOUNCE_MS)).resolves.not.toThrow();
    expect(indexer.indexFile).toHaveBeenCalledTimes(1);
  });

  it('emits "error" when indexFile rejects', async () => {
    indexer.indexFile.mockRejectedValue(new Error('boom'));

    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    const errors: unknown[] = [];
    watcher.on('error', (e) => errors.push(e));

    chokidarState.emit('change', 'src/f.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('does not start twice (chokidar.watch called once)', async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();
    await watcher.start(); // no-op

    expect(chokidarState.watchCalls).toHaveLength(1);
  });

  it('closes the underlying chokidar watcher on stop', async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();
    await watcher.stop();

    expect(chokidarState.closeMock).toHaveBeenCalledTimes(1);
  });

  it('clears pending debounce timers on stop (no index after stop)', async () => {
    const watcher = new FileWatcher({
      db: fakeDb,
      indexer: indexer as never as Indexer,
      projectRoot: '/proj',
    });
    await watcher.start();

    chokidarState.emit('change', 'src/pending.ts');
    await watcher.stop(); // should clear the pending timer

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(indexer.indexFile).not.toHaveBeenCalled();
  });
});
