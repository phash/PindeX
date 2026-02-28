import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { AntiPatternDetector } from '../../src/memory/anti-patterns.js';
import { insertSessionEvent, getAntiPatternEvents, getObservationsBySession } from '../../src/db/queries.js';

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
