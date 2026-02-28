#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { Indexer } from './indexer/index.js';
import { FileWatcher } from './indexer/watcher.js';
import { startMonitoringServer } from './monitoring/server.js';
import { TokenLogger } from './monitoring/token-logger.js';
import { createMcpServer } from './server.js';
import {
  createSession,
  deleteObservationsOlderThan,
  deleteObservationsExceptSession,
} from './db/queries.js';
import { getProjectIndexPath } from './cli/project-detector.js';
import { SessionObserver } from './memory/observer.js';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';

// ─── Configuration (from environment variables) ───────────────────────────────

const INDEX_PATH = process.env.INDEX_PATH ?? './.codebase-index/index.db';
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? process.cwd();
const LANGUAGES = (process.env.LANGUAGES ?? 'typescript,javascript').split(',');
const AUTO_REINDEX = process.env.AUTO_REINDEX !== 'false';
const MONITORING_PORT = parseInt(process.env.MONITORING_PORT ?? '7842', 10);
const MONITORING_AUTO_OPEN = process.env.MONITORING_AUTO_OPEN === 'true';
const BASELINE_MODE = process.env.BASELINE_MODE === 'true';
const GENERATE_SUMMARIES = process.env.GENERATE_SUMMARIES === 'true';
// 'permanent' | 'session' | '7d' | '30d' | ...
const OBSERVATION_RETENTION = process.env.OBSERVATION_RETENTION ?? 'permanent';

// Federated repos: colon- or comma-separated absolute paths
const FEDERATION_REPOS: string[] = (process.env.FEDERATION_REPOS ?? '')
  .split(/[:，,]/)
  .map((p) => p.trim())
  .filter(Boolean);

async function main(): Promise<void> {
  // 1. Open / create the SQLite database
  const db = openDatabase(INDEX_PATH);
  runMigrations(db);

  // 1b. Open federated repo databases (read-only)
  const federatedDbs = FEDERATION_REPOS.map((repoPath) => {
    const dbPath = getProjectIndexPath(repoPath);
    try {
      const fedDb = openDatabase(dbPath);
      return { path: repoPath, db: fedDb };
    } catch {
      process.stderr.write(`[pindex] Warning: could not open federated DB for ${repoPath}\n`);
      return null;
    }
  }).filter((x): x is { path: string; db: ReturnType<typeof openDatabase> } => x !== null);

  // 2. Set up the indexer
  const indexer = new Indexer({
    db,
    projectRoot: PROJECT_ROOT,
    languages: LANGUAGES,
    generateSummaries: GENERATE_SUMMARIES,
  });

  // 3. Initial indexing (non-blocking)
  indexer.indexAll().then(() => indexer.resolveDependencies()).catch(() => {});

  // 4. Start monitoring server
  const emitter = new EventEmitter();
  const monitoringServer = startMonitoringServer(db, MONITORING_PORT);

  if (MONITORING_AUTO_OPEN) {
    const { default: open } = await import('open');
    open(`http://localhost:${MONITORING_PORT}`).catch(() => {});
  }

  // 5. Set up token logger + session observer for the current session
  const sessionId = uuidv4();
  createSession(db, { id: sessionId, mode: BASELINE_MODE ? 'baseline' : 'indexed', label: null });
  const tokenLogger = new TokenLogger({ db, sessionId, emitter });
  const observer = new SessionObserver({ db, sessionId, projectRoot: PROJECT_ROOT });

  // 5b. Observation retention cleanup
  applyObservationRetention(db, sessionId, OBSERVATION_RETENTION);

  // 6. Start file watcher
  if (AUTO_REINDEX) {
    const watcher = new FileWatcher({ db, indexer, projectRoot: PROJECT_ROOT, observer });
    watcher.start().catch(() => {});
  }

  // 7. Create and start the MCP server
  const server = createMcpServer(db, indexer, tokenLogger, monitoringServer, {
    projectRoot: PROJECT_ROOT,
    monitoringPort: MONITORING_PORT,
    baselineMode: BASELINE_MODE,
    federatedDbs,
    sessionId,
    observer,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Catch any unhandled exception / rejection and exit so Claude Code auto-restarts the server.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[pindex] Uncaught exception – restarting: ${String(err)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[pindex] Unhandled rejection – restarting: ${String(reason)}\n`);
  process.exit(1);
});

main().catch((err) => {
  process.stderr.write(`[pindex] Fatal error: ${String(err)}\n`);
  process.exit(1);
});

/**
 * Applies the OBSERVATION_RETENTION policy on startup.
 * Supported values: 'permanent' (default), 'session', or '<N>d' (e.g. '30d').
 */
function applyObservationRetention(
  db: import('better-sqlite3').Database,
  currentSessionId: string,
  policy: string,
): void {
  if (policy === 'permanent') return;

  if (policy === 'session') {
    deleteObservationsExceptSession(db, currentSessionId);
    return;
  }

  const match = /^(\d+)d$/.exec(policy);
  if (match) {
    const days = parseInt(match[1], 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    deleteObservationsOlderThan(db, cutoff.toISOString());
    return;
  }

  process.stderr.write(
    `[pindex] Unknown OBSERVATION_RETENTION value: "${policy}" — defaulting to permanent\n`,
  );
}
