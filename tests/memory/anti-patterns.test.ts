import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { AntiPatternDetector } from '../../src/memory/anti-patterns.js';
import { insertSessionEvent, getAntiPatternEvents, getObservationsBySession } from '../../src/db/queries.js';

/**
 * Insert a file-change event (counts toward thrash) and backdate its timestamp
 * to a recent ISO instant within the 5-minute window.
 *
 * This is required because `getRecentFileChangeEvents` compares the stored
 * timestamp against `new Date(...).toISOString()` (UTC, `T`/`Z` format). Rows
 * written with SQLite's default `CURRENT_TIMESTAMP` use the space-separated
 * format, which sorts *before* the ISO cutoff and is therefore filtered out.
 * Setting an explicit ISO timestamp makes the row visible to the window query.
 */
function insertChange(
  db: Database.Database,
  filePath: string,
  symbolName: string,
  msAgo: number,
): void {
  const id = insertSessionEvent(db, {
    sessionId: SESSION,
    eventType: 'sig_changed',
    filePath,
    symbolName,
  });
  db.prepare('UPDATE session_events SET timestamp = ? WHERE id = ?').run(
    new Date(Date.now() - msAgo).toISOString(),
    id,
  );
}

const SESSION = 'session-abc';
const FILE = 'src/auth.ts';
const SYM = 'parseToken';

describe('AntiPatternDetector', () => {
  let db: Database.Database;
  let detector: AntiPatternDetector;

  beforeEach(() => {
    db = createTestDb();
    detector = new AntiPatternDetector(db, SESSION);
  });

  // ─── Dead-end ───────────────────────────────────────────────────────────────

  describe('checkDeadEnd', () => {
    it('does nothing if only symbol_added event exists', () => {
      insertSessionEvent(db, { sessionId: SESSION, eventType: 'symbol_added', filePath: FILE, symbolName: SYM });
      detector.checkDeadEnd(FILE, SYM);
      expect(getAntiPatternEvents(db, SESSION)).toHaveLength(0);
    });

    it('does nothing if only symbol_removed event exists', () => {
      insertSessionEvent(db, { sessionId: SESSION, eventType: 'symbol_removed', filePath: FILE, symbolName: SYM });
      detector.checkDeadEnd(FILE, SYM);
      expect(getAntiPatternEvents(db, SESSION)).toHaveLength(0);
    });

    it('emits dead_end event when add + remove both present', () => {
      insertSessionEvent(db, { sessionId: SESSION, eventType: 'symbol_added', filePath: FILE, symbolName: SYM });
      insertSessionEvent(db, { sessionId: SESSION, eventType: 'symbol_removed', filePath: FILE, symbolName: SYM });
      detector.checkDeadEnd(FILE, SYM);

      const events = getAntiPatternEvents(db, SESSION);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('dead_end');
    });

    it('emits an observation for dead_end', () => {
      insertSessionEvent(db, { sessionId: SESSION, eventType: 'symbol_added', filePath: FILE, symbolName: SYM });
      insertSessionEvent(db, { sessionId: SESSION, eventType: 'symbol_removed', filePath: FILE, symbolName: SYM });
      detector.checkDeadEnd(FILE, SYM);

      const obs = getObservationsBySession(db, SESSION);
      expect(obs).toHaveLength(1);
      expect(obs[0].observation).toContain(SYM);
      expect(obs[0].observation).toContain('false start');
    });

    it('does not emit twice for the same symbol', () => {
      insertSessionEvent(db, { sessionId: SESSION, eventType: 'symbol_added', filePath: FILE, symbolName: SYM });
      insertSessionEvent(db, { sessionId: SESSION, eventType: 'symbol_removed', filePath: FILE, symbolName: SYM });
      detector.checkDeadEnd(FILE, SYM);
      detector.checkDeadEnd(FILE, SYM);
      expect(getAntiPatternEvents(db, SESSION)).toHaveLength(1);
    });
  });

  // ─── Redundant access ────────────────────────────────────────────────────────

  describe('checkRedundantAccess', () => {
    it('does not emit before count=5', () => {
      for (let i = 1; i < 5; i++) {
        detector.checkRedundantAccess(i, FILE, SYM);
      }
      expect(getAntiPatternEvents(db, SESSION)).toHaveLength(0);
    });

    it('emits at exactly count=5', () => {
      detector.checkRedundantAccess(5, FILE, SYM);
      const events = getAntiPatternEvents(db, SESSION);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('redundant_access');
    });

    it('does not emit again at count=6', () => {
      detector.checkRedundantAccess(5, FILE, SYM);
      detector.checkRedundantAccess(6, FILE, SYM);
      expect(getAntiPatternEvents(db, SESSION)).toHaveLength(1);
    });

    it('works for file-only access (no symbol)', () => {
      detector.checkRedundantAccess(5, FILE);
      expect(getAntiPatternEvents(db, SESSION)).toHaveLength(1);
    });
  });

  // ─── Repeated failed search ──────────────────────────────────────────────────

  describe('checkRepeatedFailedSearch', () => {
    it('does not emit before count=3', () => {
      detector.checkRepeatedFailedSearch('parseToken', 2);
      expect(getObservationsBySession(db, SESSION)).toHaveLength(0);
    });

    it('emits observation at count=3', () => {
      detector.checkRepeatedFailedSearch('parseToken', 3);
      const obs = getObservationsBySession(db, SESSION);
      expect(obs).toHaveLength(1);
      expect(obs[0].observation).toContain('parseToken');
    });

    it('does not emit again at count=4', () => {
      detector.checkRepeatedFailedSearch('parseToken', 3);
      detector.checkRepeatedFailedSearch('parseToken', 4);
      expect(getObservationsBySession(db, SESSION)).toHaveLength(1);
    });
  });

  // ─── File thrashing ──────────────────────────────────────────────────────────

  describe('checkThrash', () => {
    it('emits thrash_detected + observation at 4 changes within the window', () => {
      for (let i = 0; i < 4; i++) {
        insertChange(db, FILE, SYM, i * 1000);
      }
      detector.checkThrash(FILE);

      const events = getAntiPatternEvents(db, SESSION).filter(
        (e) => e.event_type === 'thrash_detected',
      );
      expect(events).toHaveLength(1);
      expect(events[0].file_path).toBe(FILE);
      // change_count reflects the number of recent file-change events (4)
      expect(JSON.parse(events[0].extra_json!)).toMatchObject({
        change_count: 4,
        window_minutes: 5,
      });

      const obs = getObservationsBySession(db, SESSION);
      expect(obs).toHaveLength(1);
      expect(obs[0].type).toBe('anti_pattern');
      expect(obs[0].observation).toContain(FILE);
      expect(obs[0].observation).toContain('4×');
    });

    it('does nothing with only 3 changes (below the threshold)', () => {
      for (let i = 0; i < 3; i++) {
        insertChange(db, FILE, SYM, i * 1000);
      }
      detector.checkThrash(FILE);

      expect(
        getAntiPatternEvents(db, SESSION).filter(
          (e) => e.event_type === 'thrash_detected',
        ),
      ).toHaveLength(0);
      expect(getObservationsBySession(db, SESSION)).toHaveLength(0);
    });

    it('does not re-emit when a recent thrash_detected already exists (de-dup guard)', () => {
      for (let i = 0; i < 4; i++) {
        insertChange(db, FILE, SYM, i * 1000);
      }
      // Pre-seed a recent (ISO-timestamped) thrash_detected for this file so the
      // recency guard (msAgo < 5 min) suppresses a second emission.
      const tid = insertSessionEvent(db, {
        sessionId: SESSION,
        eventType: 'thrash_detected',
        filePath: FILE,
      });
      db.prepare('UPDATE session_events SET timestamp = ? WHERE id = ?').run(
        new Date(Date.now() - 1000).toISOString(),
        tid,
      );

      detector.checkThrash(FILE);

      // Still only the pre-seeded event; no new thrash_detected, no observation.
      expect(
        getAntiPatternEvents(db, SESSION).filter(
          (e) => e.event_type === 'thrash_detected',
        ),
      ).toHaveLength(1);
      expect(getObservationsBySession(db, SESSION)).toHaveLength(0);
    });
  });

  // ─── Tool error loop ─────────────────────────────────────────────────────────

  describe('checkToolErrorLoop', () => {
    it('emits environment observation at count=3', () => {
      detector.checkToolErrorLoop('get_symbol', FILE, 3);
      const obs = getObservationsBySession(db, SESSION);
      expect(obs).toHaveLength(1);
      expect(obs[0].type).toBe('environment');
      expect(obs[0].observation).toContain('get_symbol');
    });

    it('does not emit at count=2', () => {
      detector.checkToolErrorLoop('get_symbol', FILE, 2);
      expect(getObservationsBySession(db, SESSION)).toHaveLength(0);
    });
  });
});
