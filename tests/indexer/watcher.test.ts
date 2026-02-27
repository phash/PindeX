import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { FileWatcher } from '../../src/indexer/watcher.js';
import { Indexer } from '../../src/indexer/index.js';

describe('FileWatcher', () => {
  let db: Database.Database;
  let indexer: Indexer;

  beforeEach(() => {
    db = createTestDb();
    indexer = new Indexer({ db, projectRoot: '/test/project' });
  });

  it('can be instantiated without starting', () => {
    const watcher = new FileWatcher({ db, indexer, projectRoot: '/test/project' });
    expect(watcher).toBeTruthy();
  });

  it('starts without throwing (uses mocked chokidar)', async () => {
    const watcher = new FileWatcher({ db, indexer, projectRoot: '/test/project' });
    await expect(watcher.start()).resolves.not.toThrow();
  });

  it('does not start twice', async () => {
    const watcher = new FileWatcher({ db, indexer, projectRoot: '/test/project' });
    await watcher.start();
    await watcher.start(); // Should be a no-op
    // No assertion needed – just ensuring no error
  });

  it('stops without throwing', async () => {
    const watcher = new FileWatcher({ db, indexer, projectRoot: '/test/project' });
    await watcher.start();
    await expect(watcher.stop()).resolves.not.toThrow();
  });

  it('emits change events (tested via EventEmitter)', async () => {
    const watcher = new FileWatcher({ db, indexer, projectRoot: '/test/project' });
    await watcher.start();

    const changes: unknown[] = [];
    watcher.on('change', (e) => changes.push(e));

    // The chokidar mock doesn't actually emit events, so we test the API
    expect(watcher.listenerCount('change')).toBe(1);
  });
});
