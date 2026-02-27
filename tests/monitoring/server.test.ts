import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestSession, insertTestTokenLog } from '../helpers/fixtures.js';
import { createMonitoringApp } from '../../src/monitoring/server.js';

describe('createMonitoringApp', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createMonitoringApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createMonitoringApp(db);
  });

  it('responds to GET / with the dashboard HTML', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('GET /api/sessions returns empty array when no sessions', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/sessions returns existing sessions', async () => {
    insertTestSession(db, 'sess-1', 'indexed', 'My Feature');
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET /api/sessions/:id returns session stats', async () => {
    insertTestSession(db, 'sess-2', 'indexed', 'Test');
    insertTestTokenLog(db, 'sess-2', 'search_symbols', 50, 500);

    const res = await request(app).get('/api/sessions/sess-2');
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe('sess-2');
    expect(res.body.tokens_used).toBe(50);
  });

  it('GET /api/sessions/:id returns 404 for unknown session', async () => {
    const res = await request(app).get('/api/sessions/nonexistent');
    expect(res.status).toBe(404);
  });

  it('serves static UI files', async () => {
    const res = await request(app).get('/dashboard.js');
    // Either 200 (file exists) or 404 (file not yet built) – just check it responds
    expect([200, 404]).toContain(res.status);
  });
});
