import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestSession } from '../helpers/fixtures.js';
import { TokenLogger } from '../../src/monitoring/token-logger.js';
import { getSessionStats } from '../../src/db/queries.js';

describe('TokenLogger', () => {
  let db: Database.Database;
  let emitter: EventEmitter;

  beforeEach(() => {
    db = createTestDb();
    emitter = new EventEmitter();
    insertTestSession(db, 'sess-123', 'indexed', 'Test Session');
  });

  it('logs a tool call to the database', () => {
    const logger = new TokenLogger({ db, sessionId: 'sess-123', emitter });
    logger.log({
      toolName: 'search_symbols',
      tokensUsed: 50,
      tokensWithoutIndex: 500,
      query: 'myFunc',
    });

    const stats = getSessionStats(db, 'sess-123');
    expect(stats.calls).toHaveLength(1);
    expect(stats.tokens_used).toBe(50);
  });

  it('emits a token_event via the emitter', () => {
    const logger = new TokenLogger({ db, sessionId: 'sess-123', emitter });
    const listener = vi.fn();
    emitter.on('token_event', listener);

    logger.log({ toolName: 'get_symbol', tokensUsed: 80, tokensWithoutIndex: 800 });

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0][0];
    expect(event.type).toBe('tool_call');
    expect(event.tool).toBe('get_symbol');
    expect(event.tokens_actual).toBe(80);
    expect(event.tokens_estimated).toBe(800);
  });

  it('returns the current session ID', () => {
    const logger = new TokenLogger({ db, sessionId: 'sess-123', emitter });
    expect(logger.getCurrentSessionId()).toBe('sess-123');
  });

  it('accumulates cumulative totals across multiple logs', () => {
    const logger = new TokenLogger({ db, sessionId: 'sess-123', emitter });
    const events: Array<{ cumulative_actual: number }> = [];
    emitter.on('token_event', (e) => events.push(e));

    logger.log({ toolName: 'search_symbols', tokensUsed: 50, tokensWithoutIndex: 500 });
    logger.log({ toolName: 'get_symbol', tokensUsed: 80, tokensWithoutIndex: 800 });

    expect(events[0].cumulative_actual).toBe(50);
    expect(events[1].cumulative_actual).toBe(130);
  });

  it('includes savings_percent in emitted events', () => {
    const logger = new TokenLogger({ db, sessionId: 'sess-123', emitter });
    const events: Array<{ savings_percent: number }> = [];
    emitter.on('token_event', (e) => events.push(e));

    logger.log({ toolName: 'search_symbols', tokensUsed: 100, tokensWithoutIndex: 1000 });

    expect(events[0].savings_percent).toBeGreaterThan(0);
  });
});
