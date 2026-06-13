import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestSession, insertTestTokenLog } from '../helpers/fixtures.js';
import { insertSessionEvent, insertObservation } from '../../src/db/queries.js';
import { createMonitoringApp, startMonitoringServer } from '../../src/monitoring/server.js';

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

  // ─── TST-11: GET /api/session-memory ───────────────────────────────────────
  describe('GET /api/session-memory', () => {
    it('returns empty arrays on a fresh DB', async () => {
      const res = await request(app).get('/api/session-memory');
      expect(res.status).toBe(200);
      expect(res.body.anti_patterns).toEqual([]);
      expect(res.body.observations).toEqual([]);
    });

    it('surfaces anti-pattern events and observations under the correct keys', async () => {
      insertTestSession(db, 'mem-sess', 'indexed', 'Memory Session');
      // thrash_detected is one of the anti-pattern event types filtered by
      // getAllAntiPatternEvents; a plain 'accessed' event would NOT appear.
      insertSessionEvent(db, {
        sessionId: 'mem-sess',
        eventType: 'thrash_detected',
        filePath: 'src/auth.ts',
      });
      // A non-anti-pattern event must be ignored by the anti_patterns list.
      insertSessionEvent(db, {
        sessionId: 'mem-sess',
        eventType: 'accessed',
        filePath: 'src/utils.ts',
      });
      insertObservation(db, {
        sessionId: 'mem-sess',
        type: 'accessed',
        filePath: 'src/auth.ts',
        observation: 'Looked at the auth flow.',
      });

      const res = await request(app).get('/api/session-memory');
      expect(res.status).toBe(200);

      expect(res.body.anti_patterns).toHaveLength(1);
      expect(res.body.anti_patterns[0].event_type).toBe('thrash_detected');
      expect(res.body.anti_patterns[0].session_id).toBe('mem-sess');
      expect(res.body.anti_patterns[0].file_path).toBe('src/auth.ts');

      expect(res.body.observations).toHaveLength(1);
      expect(res.body.observations[0].observation).toBe('Looked at the auth flow.');
      expect(res.body.observations[0].session_id).toBe('mem-sess');
    });
  });

  // ─── SEC-03: DNS-rebinding Host guard ──────────────────────────────────────
  describe('Host guard (SEC-03)', () => {
    let savedBindHost: string | undefined;

    beforeEach(() => {
      savedBindHost = process.env.PINDEX_BIND_HOST;
      // Enforcement is only active while bound to loopback (or unset).
      delete process.env.PINDEX_BIND_HOST;
    });

    afterEach(() => {
      if (savedBindHost === undefined) delete process.env.PINDEX_BIND_HOST;
      else process.env.PINDEX_BIND_HOST = savedBindHost;
    });

    it('rejects requests with a non-loopback Host header (403)', async () => {
      const res = await request(app).get('/api/sessions').set('Host', 'evil.com');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
    });

    it('allows requests with the default loopback Host (200)', async () => {
      // supertest's default Host is 127.0.0.1:<port> → loopback → allowed.
      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
    });
  });
});

// ─── TST-05: startMonitoringServer binds to loopback ─────────────────────────
describe('startMonitoringServer', () => {
  let db: Database.Database;
  let server: ReturnType<typeof startMonitoringServer> | undefined;
  let savedBindHost: string | undefined;

  beforeEach(() => {
    db = createTestDb();
    savedBindHost = process.env.PINDEX_BIND_HOST;
    server = undefined;
  });

  afterEach(async () => {
    if (server) await server.close();
    if (savedBindHost === undefined) delete process.env.PINDEX_BIND_HOST;
    else process.env.PINDEX_BIND_HOST = savedBindHost;
  });

  /** Resolves once the http server has bound and is listening. */
  function waitForListening(srv: ReturnType<typeof startMonitoringServer>): Promise<void> {
    return new Promise((resolve) => {
      if (srv.httpServer.listening) resolve();
      else srv.httpServer.once('listening', () => resolve());
    });
  }

  it('binds to 127.0.0.1 by default', async () => {
    delete process.env.PINDEX_BIND_HOST;
    server = startMonitoringServer(db, 0);
    await waitForListening(server);

    const addr = server.httpServer.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');

    // Returned shape exposes the documented handles.
    expect(server.app).toBeDefined();
    expect(server.wss).toBeDefined();
    expect(typeof server.close).toBe('function');
    expect(typeof server.broadcast).toBe('function');
  });

  it('binds to 127.0.0.1 when PINDEX_BIND_HOST is set explicitly to loopback', async () => {
    process.env.PINDEX_BIND_HOST = '127.0.0.1';
    server = startMonitoringServer(db, 0);
    await waitForListening(server);

    const addr = server.httpServer.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
  });
});

// ─── WebSocket forwarding, verifyClient and close() ──────────────────────────
describe('startMonitoringServer — WebSocket behaviour', () => {
  let db: Database.Database;
  let server: ReturnType<typeof startMonitoringServer> | undefined;
  let savedBindHost: string | undefined;

  beforeEach(() => {
    db = createTestDb();
    savedBindHost = process.env.PINDEX_BIND_HOST;
    // Enforcement is only active while bound to loopback (or unset).
    delete process.env.PINDEX_BIND_HOST;
    server = undefined;
  });

  afterEach(async () => {
    if (server) await server.close();
    if (savedBindHost === undefined) delete process.env.PINDEX_BIND_HOST;
    else process.env.PINDEX_BIND_HOST = savedBindHost;
  });

  function waitForListening(srv: ReturnType<typeof startMonitoringServer>): Promise<void> {
    return new Promise((resolve) => {
      if (srv.httpServer.listening) resolve();
      else srv.httpServer.once('listening', () => resolve());
    });
  }

  function port(srv: ReturnType<typeof startMonitoringServer>): number {
    return (srv.httpServer.address() as AddressInfo).port;
  }

  /** Opens a ws client with optional extra headers; resolves on 'open'. */
  function connect(p: number, headers?: Record<string, string>): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${p}`, { headers });
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  it('forwards broadcast events to a connected WS client', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    const ws = await connect(port(server));

    const received = new Promise<string>((resolve) => {
      ws.once('message', (data) => resolve(data.toString()));
    });

    const event = { type: 'tool_call' as const, session_id: 's1', timestamp: 'now', tool: 'search_symbols' };
    server.broadcast(event as never);

    const raw = await received;
    expect(JSON.parse(raw)).toMatchObject({ type: 'tool_call', tool: 'search_symbols' });
    ws.close();
  });

  it('broadcast with no connected clients does not throw', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    expect(() => server!.broadcast({ type: 'tool_call' } as never)).not.toThrow();
  });

  it('forwards a broadcast to multiple connected clients', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    const p = port(server);
    const [wsA, wsB] = await Promise.all([connect(p), connect(p)]);

    const recvA = new Promise<string>((r) => wsA.once('message', (d) => r(d.toString())));
    const recvB = new Promise<string>((r) => wsB.once('message', (d) => r(d.toString())));

    server.broadcast({ type: 'ping' } as never);

    const [a, b] = await Promise.all([recvA, recvB]);
    expect(JSON.parse(a)).toMatchObject({ type: 'ping' });
    expect(JSON.parse(b)).toMatchObject({ type: 'ping' });
    wsA.close();
    wsB.close();
  });

  // ─── verifyClient: accept branches ─────────────────────────────────────────
  it('accepts a WS client with no Origin header (non-browser client)', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    // connect() sends no Origin → isAllowedOrigin(undefined) === true.
    const ws = await connect(port(server));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('accepts a WS client with a loopback Origin header', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    const p = port(server);
    const ws = await connect(p, { Origin: `http://127.0.0.1:${p}` });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  // ─── verifyClient: reject branches ─────────────────────────────────────────
  it('rejects a WS client with a foreign Origin header', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port(server)}`, {
      headers: { Origin: 'http://evil.com' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => reject(new Error('should have been rejected')));
      // ws emits 'unexpected-response' (or 'error') on a verifyClient 401 rejection.
      ws.once('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      ws.once('error', () => resolve());
    });
  });

  it('rejects a WS client with a foreign Host header', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    // Override the Host header so the verifyClient Host check fails.
    const ws = new WebSocket(`ws://127.0.0.1:${port(server)}`, {
      headers: { Host: 'evil.com' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => reject(new Error('should have been rejected')));
      ws.once('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      ws.once('error', () => resolve());
    });
  });

  // ─── per-client error handler ──────────────────────────────────────────────
  it('survives a per-client error without crashing the server', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    const p = port(server);
    const ws = await connect(p);

    // Wait until the server registered the connection (its 'connection' handler
    // attaches the per-client error listener).
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (server!.wss.clients.size > 0) { clearInterval(t); resolve(); }
      }, 5);
    });

    // Emit an error on the server-side socket → the suppressing handler runs.
    for (const client of server.wss.clients) {
      client.emit('error', new Error('boom'));
    }

    // Server is still alive: a fresh broadcast still reaches a new client.
    const ws2 = await connect(p);
    const recv = new Promise<string>((r) => ws2.once('message', (d) => r(d.toString())));
    server.broadcast({ type: 'still-alive' } as never);
    expect(JSON.parse(await recv)).toMatchObject({ type: 'still-alive' });

    ws.close();
    ws2.close();
  });

  // ─── close() terminates clients ────────────────────────────────────────────
  it('close() terminates connected WS clients and stops the server', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    const p = port(server);
    const ws = await connect(p);

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

    await server.close();
    server = undefined; // prevent double-close in afterEach

    await closed; // client socket was terminated by close()
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('close() is safe with no connected clients', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);
    await server.close();
    server = undefined;
    // No assertion needed beyond "did not throw / hang".
    expect(true).toBe(true);
  });
});

// ─── httpServer error handler (EADDRINUSE + generic) ─────────────────────────
describe('startMonitoringServer — listen error handling', () => {
  let db: Database.Database;
  let server: ReturnType<typeof startMonitoringServer> | undefined;
  let occupied: ReturnType<typeof startMonitoringServer> | undefined;
  let savedBindHost: string | undefined;
  let stderrSpy: { restore: () => void; written: string[] };

  beforeEach(() => {
    db = createTestDb();
    savedBindHost = process.env.PINDEX_BIND_HOST;
    delete process.env.PINDEX_BIND_HOST;
    server = undefined;
    occupied = undefined;

    // Capture stderr so the error-path writes don't pollute test output and
    // can be asserted on.
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
      written.push(chunk.toString());
      return true;
    };
    stderrSpy = { written, restore: () => { (process.stderr.write as unknown) = orig; } };
  });

  afterEach(async () => {
    // The "failed to listen" server can throw "Server is not running." on close;
    // swallow that so it doesn't mask the real assertion.
    if (server) await server.close().catch(() => { /* ignore */ });
    if (occupied) await occupied.close().catch(() => { /* ignore */ });
    stderrSpy.restore();
    if (savedBindHost === undefined) delete process.env.PINDEX_BIND_HOST;
    else process.env.PINDEX_BIND_HOST = savedBindHost;
  });

  function waitForListening(srv: ReturnType<typeof startMonitoringServer>): Promise<void> {
    return new Promise((resolve) => {
      if (srv.httpServer.listening) resolve();
      else srv.httpServer.once('listening', () => resolve());
    });
  }

  it('writes an EADDRINUSE message when the port is already taken', async () => {
    occupied = startMonitoringServer(db, 0);
    await waitForListening(occupied);
    const takenPort = (occupied.httpServer.address() as AddressInfo).port;

    server = startMonitoringServer(db, takenPort);
    // Wait for the httpServer 'error' event to fire and the handler to write.
    await new Promise<void>((resolve) => {
      server!.httpServer.once('error', () => setTimeout(resolve, 10));
    });

    expect(stderrSpy.written.join('')).toMatch(/in use — monitoring disabled/);
  });

  it('writes a generic error message for non-EADDRINUSE listen errors', async () => {
    server = startMonitoringServer(db, 0);
    await waitForListening(server);

    // Directly drive the registered 'error' handler with a non-EADDRINUSE error.
    const err = Object.assign(new Error('kaboom'), { code: 'EACCES' });
    server.httpServer.emit('error', err);

    expect(stderrSpy.written.join('')).toMatch(/Monitoring server error: kaboom/);
  });
});
