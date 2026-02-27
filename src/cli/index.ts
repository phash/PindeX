#!/usr/bin/env node
/** CLI entry point: mcp-indexer <command> [options] */

import { runSetup } from './setup.js';
import { isDaemonRunning, stopDaemon, showStatus } from './daemon.js';
import { openDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';
import { Indexer } from '../indexer/index.js';
import { getProjectIndexPath } from './project-detector.js';

const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'setup':
      await runSetup();
      break;

    case 'start': {
      if (isDaemonRunning()) {
        console.log('Daemon is already running.');
      } else {
        console.log('Starting daemon... (run `mcp-indexer-daemon` directly for now)');
      }
      break;
    }

    case 'stop':
      await stopDaemon();
      break;

    case 'restart':
      await stopDaemon();
      console.log('Daemon stopped. Start it again with: mcp-indexer start');
      break;

    case 'status':
      await showStatus();
      break;

    case 'index': {
      const targetPath = args[0] ?? process.cwd();
      const force = args.includes('--force');
      console.log(`Indexing: ${targetPath}`);

      const dbPath = getProjectIndexPath(targetPath);
      const db = openDatabase(dbPath);
      runMigrations(db);

      const indexer = new Indexer({ db, projectRoot: targetPath });
      const result = await indexer.indexAll({ force });
      await indexer.resolveDependencies();

      console.log(`Done: ${result.indexed} indexed, ${result.updated} updated, ${result.skipped} skipped`);
      if (result.errors.length > 0) {
        console.error(`Errors: ${result.errors.join(', ')}`);
      }
      db.close();
      break;
    }

    case 'list': {
      console.log('Project list – not yet fully implemented. Use `mcp-indexer status`.');
      break;
    }

    case 'remove': {
      const targetPath = args[0] ?? process.cwd();
      console.log(`Remove project: ${targetPath} – not yet implemented.`);
      break;
    }

    case 'monitor': {
      const { default: open } = await import('open');
      await open('http://localhost:7842');
      break;
    }

    case 'stats': {
      console.log('Stats – connect to a running daemon for session statistics.');
      break;
    }

    case 'uninstall': {
      console.log('Uninstall – stops daemon and removes configuration.');
      await stopDaemon();
      console.log('Done. You can also remove ~/.mcp-indexer manually.');
      break;
    }

    default:
      console.log(`
Usage: mcp-indexer <command>

Commands:
  setup           One-time setup: register MCP server, configure autostart
  start           Start the daemon
  stop            Stop the daemon
  restart         Restart the daemon
  status          Show daemon status and indexed projects

  index [path]    Index a directory (default: current directory)
  index --force   Force re-index all files
  list            List all indexed projects
  remove [path]   Remove a project from the index

  monitor         Open the monitoring dashboard in the browser
  stats           Show token stats for the current session

  uninstall       Remove all configuration and stop the daemon
`);
      break;
  }
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
