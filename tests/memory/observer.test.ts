import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { SessionObserver } from '../../src/memory/observer.js';
import {
  getSessionEvents,
  getObservationsBySession,
  insertObservation,
} from '../../src/db/queries.js';
import type { AstDiffResult } from '../../src/memory/ast-diff.js';

const SESSION = 'obs-session-1';
const PROJECT_ROOT = '/project';

function makeObserver(db: Database.Database): SessionObserver {
  return new SessionObserver({ db, sessionId: SESSION, projectRoot: PROJECT_ROOT });
}

function makeDiff(
  filePath: string,
  changes: AstDiffResult['changes'],
): AstDiffResult {
  return { filePath, changes, hasChanges: changes.length > 0 };
}

describe('SessionObserver', () => {
  let db: Database.Database;
  let observer: SessionObserver;

  beforeEach(() => {
    db = createTestDb();
    observer = makeObserver(db);
  });

  // ─── Tool call hooks ─────────────────────────────────────────────────────────

  describe('onToolCall — get_symbol', () => {
    it('records accessed event when symbol found', () => {
      observer.onToolCall(
        'get_symbol',
        { name: 'AuthService' },
        { file: 'src/auth.ts', name: 'AuthService' },
        false,
      );
      const events = getSessionEvents(db, SESSION, ['accessed']);
      expect(events).toHaveLength(1);
      expect(events[0].file_path).toBe('src/auth.ts');
      expect(events[0].symbol_name).toBe('AuthService');
    });

    it('records nothing when symbol returns null and no file arg', () => {
      observer.onToolCall('get_symbol', { name: 'Missing' }, null, false);
      expect(getSessionEvents(db, SESSION)).toHaveLength(0);
    });
  });

  describe('onToolCall — get_file_summary', () => {
    it('records accessed event for found file', () => {
      observer.onToolCall(
        'get_file_summary',
        { file: 'src/auth.ts' },
        { symbols: [], imports: [], exports: [], language: 'typescript', summary: null },
        false,
      );
      const events = getSessionEvents(db, SESSION, ['accessed']);
      expect(events).toHaveLength(1);
      expect(events[0].file_path).toBe('src/auth.ts');
    });
  });

  describe('onToolCall — get_context', () => {
    it('records accessed event', () => {
      observer.onToolCall('get_context', { file: 'src/utils.ts', line: 10 }, {}, false);
      const events = getSessionEvents(db, SESSION, ['accessed']);
      expect(events[0].file_path).toBe('src/utils.ts');
    });
  });

  describe('onToolCall — find_usages', () => {
    it('records accessed event with symbol name', () => {
      observer.onToolCall('find_usages', { symbol: 'parseToken' }, [], false);
      const events = getSessionEvents(db, SESSION, ['accessed']);
      expect(events).toHaveLength(1);
      expect(events[0].symbol_name).toBe('parseToken');
    });
  });

  describe('onToolCall — search_symbols', () => {
    it('records failed_search event when results are empty', () => {
      observer.onToolCall('search_symbols', { query: 'parseToken' }, [], false);
      const events = getSessionEvents(db, SESSION, ['failed_search']);
      expect(events).toHaveLength(1);
    });

    it('records no failed_search event when results are non-empty', () => {
      observer.onToolCall('search_symbols', { query: 'parseToken' }, [{ name: 'parseToken' }], false);
      expect(getSessionEvents(db, SESSION, ['failed_search'])).toHaveLength(0);
    });

    it('generates anti-pattern observation after 3 failed searches for same query', () => {
      for (let i = 0; i < 3; i++) {
        observer.onToolCall('search_symbols', { query: 'missingSymbol' }, [], false);
      }
      const obs = getObservationsBySession(db, SESSION);
      expect(obs.some((o) => o.observation.includes('missingSymbol'))).toBe(true);
    });
  });

  describe('onToolCall — errors', () => {
    it('records tool_error event', () => {
      observer.onToolCall('get_symbol', { name: 'Foo' }, { error: 'DB error' }, true);
      const events = getSessionEvents(db, SESSION, ['tool_error']);
      expect(events).toHaveLength(1);
    });
  });

  // ─── Redundant access tracking ───────────────────────────────────────────────

  it('detects redundant access at 5 hits', () => {
    for (let i = 0; i < 5; i++) {
      observer.onToolCall(
        'get_symbol',
        { name: 'AuthService' },
        { file: 'src/auth.ts', name: 'AuthService' },
        false,
      );
    }
    const events = getSessionEvents(db, SESSION, ['redundant_access']);
    expect(events).toHaveLength(1);
  });

  // ─── onFileDiff ──────────────────────────────────────────────────────────────

  describe('onFileDiff', () => {
    it('does nothing when no changes', () => {
      observer.onFileDiff(makeDiff('src/auth.ts', []));
      expect(getSessionEvents(db, SESSION)).toHaveLength(0);
    });

    it('records symbol_added event', () => {
      observer.onFileDiff(
        makeDiff('src/auth.ts', [
          {
            type: 'added',
            name: 'newFn',
            kind: 'function',
            newSignature: 'function newFn(): void',
            description: 'function `newFn` added',
          },
        ]),
      );
      const events = getSessionEvents(db, SESSION, ['symbol_added']);
      expect(events).toHaveLength(1);
      expect(events[0].symbol_name).toBe('newFn');
    });

    it('records sig_changed event', () => {
      observer.onFileDiff(
        makeDiff('src/auth.ts', [
          {
            type: 'sig_changed',
            name: 'foo',
            kind: 'function',
            oldSignature: 'function foo(): void',
            newSignature: 'function foo(x: number): void',
            description: 'function `foo` signature changed',
          },
        ]),
      );
      const events = getSessionEvents(db, SESSION, ['sig_changed']);
      expect(events).toHaveLength(1);
    });

    it('only generates observation for symbols Claude accessed', () => {
      // No prior access — diff should NOT produce an observation
      observer.onFileDiff(
        makeDiff('src/auth.ts', [
          {
            type: 'sig_changed',
            name: 'foo',
            kind: 'function',
            oldSignature: 'function foo(): void',
            newSignature: 'function foo(x: number): void',
            description: 'function `foo` signature changed',
          },
        ]),
      );
      expect(getObservationsBySession(db, SESSION)).toHaveLength(0);
    });

    it('generates observation when file was previously accessed', () => {
      // Access the file first
      observer.onToolCall(
        'get_file_summary',
        { file: 'src/auth.ts' },
        { symbols: [], imports: [], exports: [], language: 'typescript', summary: null },
        false,
      );
      // Now diff triggers an observation
      observer.onFileDiff(
        makeDiff('src/auth.ts', [
          {
            type: 'sig_changed',
            name: 'foo',
            kind: 'function',
            oldSignature: 'function foo(): void',
            newSignature: 'function foo(x: number): void',
            description: 'function `foo` signature changed',
          },
        ]),
      );
      const obs = getObservationsBySession(db, SESSION);
      expect(obs.length).toBeGreaterThanOrEqual(1);
    });

    it('marks prior observations stale on sig_changed', () => {
      insertObservation(db, {
        sessionId: 'old-session',
        type: 'accessed',
        filePath: 'src/auth.ts',
        symbolName: 'foo',
        observation: 'foo was accessed',
      });

      observer.onFileDiff(
        makeDiff('src/auth.ts', [
          {
            type: 'sig_changed',
            name: 'foo',
            kind: 'function',
            oldSignature: 'old',
            newSignature: 'new',
            description: 'changed',
          },
        ]),
      );

      const obs = getObservationsBySession(db, 'old-session');
      expect(obs[0].stale).toBe(1);
    });
  });
});
