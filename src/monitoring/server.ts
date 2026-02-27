import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';
import { WebSocketServer } from 'ws';
import type Database from 'better-sqlite3';
import type { MonitoringEvent } from '../types.js';
import { listSessions, getSessionStats } from '../db/queries.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, 'ui');

export interface MonitoringServer {
  app: express.Application;
  httpServer: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  emitter: EventEmitter;
  close(): Promise<void>;
  broadcast(event: MonitoringEvent): void;
}

/** Creates the Express application (without starting it).
 *  Suitable for supertest-based testing. */
export function createMonitoringApp(db: Database.Database): express.Application {
  const app = express();
  app.use(express.json());

  // Serve static UI files
  app.use(express.static(UI_DIR));

  // Fallback: serve index.html for the root
  app.get('/', (_req, res) => {
    res.sendFile(join(UI_DIR, 'index.html'), (err) => {
      if (err) {
        // index.html doesn't exist yet (pre-build) – send a placeholder
        res.status(200).send(`<!DOCTYPE html><html><body>
          <h1>MCP Codebase Indexer – Monitoring</h1>
          <p>Dashboard will be available after build.</p>
        </body></html>`);
      }
    });
  });

  // ─── REST API ──────────────────────────────────────────────────────────────

  app.get('/api/sessions', (_req, res) => {
    const sessions = listSessions(db);
    res.json(sessions);
  });

  app.get('/api/sessions/:id', (req, res) => {
    const sessions = listSessions(db);
    const session = sessions.find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const stats = getSessionStats(db, req.params.id);
    res.json(stats);
  });

  return app;
}

/** Creates and starts the full monitoring server with WebSocket support. */
export function startMonitoringServer(
  db: Database.Database,
  port: number,
): MonitoringServer {
  const app = createMonitoringApp(db);
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  const emitter = new EventEmitter();

  // Forward events from emitter to all WebSocket clients
  emitter.on('event', (event: MonitoringEvent) => {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data);
      }
    }
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`[pindex] Monitoring port ${port} in use — monitoring disabled\n`);
    } else {
      process.stderr.write(`[pindex] Monitoring server error: ${err.message}\n`);
    }
  });

  httpServer.listen(port);

  const broadcast = (event: MonitoringEvent): void => {
    emitter.emit('event', event);
  };

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      wss.close(() => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

  return { app, httpServer, wss, emitter, close, broadcast };
}
