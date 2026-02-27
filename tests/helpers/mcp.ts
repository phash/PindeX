import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { Indexer } from '../../src/indexer/index.js';
import { TokenLogger } from '../../src/monitoring/token-logger.js';
import { createMcpServer } from '../../src/server.js';
import { createSession } from '../../src/db/queries.js';

/** Creates a test MCP server with an in-memory DB and a fake project root.
 *  Returns both the server and the underlying DB for assertions. */
export function createTestServer(
  db: Database.Database,
  projectRoot = '/test/project',
) {
  const sessionId = uuidv4();
  createSession(db, { id: sessionId, mode: 'indexed', label: 'Test' });

  const indexer = new Indexer({ db, projectRoot });
  const emitter = new EventEmitter();
  const tokenLogger = new TokenLogger({ db, sessionId, emitter });

  const server = createMcpServer(db, indexer, tokenLogger, null, {
    projectRoot,
    monitoringPort: 7842,
    baselineMode: false,
  });

  return { server, db, indexer, tokenLogger, emitter, sessionId };
}
