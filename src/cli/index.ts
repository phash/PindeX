#!/usr/bin/env node
/** CLI entry point: pindex <command> [options] */

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSetup } from './setup.js';
import { isDaemonRunning, stopDaemon, showStatus, getDaemonPid } from './daemon.js';
import { openDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';
import { Indexer } from '../indexer/index.js';
import {
  getProjectIndexPath,
  getProjectsDir,
  GlobalRegistry,
  findProjectRoot,
  hashProjectPath,
} from './project-detector.js';
import { initProject, addFederatedRepo, removeFederatedRepo, injectClaudeMdSection, injectClaudeSettings, removeClaudeMdSection, removeClaudeSettings, removeMcpJson, writeMcpJson, injectGitignore } from './init.js';

const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    // ── Default: no args → smart init for current project
    case undefined:
    case 'init':
      await initProject(process.cwd());
      break;

    case 'setup':
      await runSetup();
      break;

    case 'reinit': {
      const projectRoot = findProjectRoot(process.cwd());
      const force = args.includes('--force');
      const mdResult = injectClaudeMdSection(projectRoot, { force });
      const hkResult = injectClaudeSettings(projectRoot, { force });
      const mdLabel =
        mdResult === 'created' ? 'CLAUDE.md created' :
        mdResult === 'added'   ? 'PindeX section added' :
        mdResult === 'updated' ? 'PindeX section updated' :
                                 'CLAUDE.md already present (use --force to update)';
      const hkLabel =
        hkResult === 'created' ? 'hooks created' :
        hkResult === 'added'   ? 'hook added' :
                                 'hooks already present (use --force to update)';
      console.log(`\n  ${mdLabel} · ${hkLabel}\n  ${projectRoot}\n`);
      break;
    }

    case 'start': {
      const projectRoot = findProjectRoot(process.cwd());
      const hash = hashProjectPath(projectRoot);
      if (isDaemonRunning(hash)) {
        console.log('pindex is already running for this project.');
      } else {
        console.log('Use `pindex` (no args) to set up this project, then open Claude Code.');
        console.log('The pindex-server is started automatically by Claude Code via .mcp.json.');
      }
      break;
    }

    case 'stop': {
      const projectRoot = findProjectRoot(process.cwd());
      await stopDaemon(hashProjectPath(projectRoot));
      break;
    }

    case 'restart': {
      const projectRoot = findProjectRoot(process.cwd());
      const hash = hashProjectPath(projectRoot);
      await stopDaemon(hash);
      console.log('Stopped. Open Claude Code to restart pindex-server via .mcp.json.');
      break;
    }

    case 'status': {
      const registry = new GlobalRegistry();
      const projects = registry.list();
      if (projects.length === 0) {
        console.log('No projects registered. Run `pindex` in a project directory.');
        break;
      }
      console.log(`\n  ${projects.length} registered project(s):\n`);
      for (const p of projects) {
        const pid = getDaemonPid(p.hash);
        const status = pid ? `running (PID ${pid})` : 'idle';
        const federated = p.federatedRepos.length > 0
          ? `  + ${p.federatedRepos.length} federated repo(s)`
          : '';
        console.log(`  [${status}]  ${p.name}${federated}`);
        console.log(`           ${p.path}`);
        console.log(`           port: ${p.monitoringPort}  index: ${p.path}/.pindex/\n`);
      }
      break;
    }

    case 'index': {
      const force = args.includes('--force');
      const targetPath = args.find(a => !a.startsWith('--')) ?? process.cwd();
      console.log(`Indexing: ${targetPath}`);

      const dbPath = getProjectIndexPath(targetPath);
      const db = openDatabase(dbPath);
      runMigrations(db);

      const languages = process.env.LANGUAGES?.split(',').map((l) => l.trim()).filter(Boolean);
      const indexer = new Indexer({ db, projectRoot: targetPath, languages });
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
      const registry = new GlobalRegistry();
      const projects = registry.list();
      if (projects.length === 0) {
        console.log('No projects registered yet.');
      } else {
        for (const p of projects) {
          const fedStr = p.federatedRepos.length > 0
            ? ` [+${p.federatedRepos.length} federated]`
            : '';
          console.log(`  ${p.name}${fedStr}  —  ${p.path}`);
        }
      }
      break;
    }

    case 'add': {
      if (!args[0]) {
        console.error('Usage: pindex add <path-to-repo>');
        process.exit(1);
      }
      await addFederatedRepo(process.cwd(), args[0]);
      break;
    }

    case 'remove': {
      if (!args[0]) {
        // Remove the current project: unregister + clean up all PindeX artifacts
        const projectRoot = findProjectRoot(process.cwd());
        const registry = new GlobalRegistry();
        await stopDaemon(hashProjectPath(projectRoot));
        registry.remove(projectRoot);

        const mdResult  = removeClaudeMdSection(projectRoot);
        const hkResult  = removeClaudeSettings(projectRoot);
        const mcpResult = removeMcpJson(projectRoot);

        console.log(`\n  ✓ Removed from registry: ${projectRoot}`);
        console.log(`  CLAUDE.md  : ${mdResult === 'removed' ? 'PindeX section removed' : mdResult === 'not_found' ? 'no section found' : 'file not found'}`);
        console.log(`  Hooks      : ${hkResult === 'removed' ? 'hook removed' : hkResult === 'not_found' ? 'no hook found' : 'file not found'}`);
        console.log(`  .mcp.json  : ${mcpResult === 'removed' ? 'deleted' : 'not found'}\n`);
        console.log('  Index data (.pindex/ in project folder) kept — delete manually if desired.\n');
      } else {
        // Remove a federated repo link
        await removeFederatedRepo(process.cwd(), args[0]);
      }
      break;
    }

    case 'gui':
    case 'monitor': {
      const { default: open } = await import('open');
      const registry = new GlobalRegistry();
      const projects = registry.list();
      // pindex-gui runs on 7842 by default
      const port = process.env.GUI_PORT ?? '7842';
      if (projects.length === 0) {
        console.log('No projects registered. Run `pindex` in a project first.');
      }
      await open(`http://localhost:${port}`);
      console.log(`Opening dashboard: http://localhost:${port}`);
      break;
    }

    case 'stats': {
      console.log('Run `pindex-gui` for full statistics. Or open http://localhost:7842');
      break;
    }

    case 'migrate': {
      const registry = new GlobalRegistry();
      const projects = registry.list();
      if (projects.length === 0) {
        console.log('No projects registered.');
        break;
      }
      console.log(`\n  Migrating ${projects.length} project(s) to local .pindex/ storage...\n`);
      for (const p of projects) {
        const oldDir = join(getProjectsDir(), p.hash);
        const oldDb  = join(oldDir, 'index.db');
        const newDir = join(p.path, '.pindex');
        const newDb  = join(newDir, 'index.db');

        process.stdout.write(`  ${p.name}\n  ${p.path}\n`);

        if (!existsSync(p.path)) {
          console.log(`    ⚠ project directory not found — skipped\n`);
          continue;
        }
        if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });

        if (existsSync(newDb)) {
          console.log(`    ✓ already at .pindex/index.db — skipped`);
        } else if (existsSync(oldDb)) {
          copyFileSync(oldDb, newDb);
          const oldMeta = join(oldDir, 'meta.json');
          if (existsSync(oldMeta)) copyFileSync(oldMeta, join(newDir, 'meta.json'));
          console.log(`    ✓ copied from ~/.pindex/projects/${p.hash}/`);
        } else {
          console.log(`    ⚠ no existing index found — will be built on next Claude Code start`);
        }
        writeMcpJson(p.path, p);
        injectGitignore(p.path);
        console.log(`    ✓ .mcp.json updated, .gitignore patched\n`);
      }
      console.log('  Done. Restart Claude Code in each project to activate.\n');
      break;
    }

    case 'uninstall': {
      console.log('Stopping any running daemons...');
      const registry = new GlobalRegistry();
      for (const p of registry.list()) {
        await stopDaemon(p.hash);
      }
      console.log(`Done. You can remove ~/.pindex (registry) and each project's .pindex/ folder manually to wipe all data.`);
      break;
    }

    default:
      console.log(`
  pindex – MCP Codebase Indexer

  Usage: pindex [command] [options]

  Commands:
    (none)          Init this project: write .mcp.json, register globally
    init            Same as above

    add <path>      Link another repo for cross-repo search (federation)
    remove          Unregister project, remove .mcp.json, CLAUDE.md section & hook
    remove <path>   Remove a federated repo link only
    reinit          Re-inject PindeX section into CLAUDE.md
    reinit --force  Replace existing section with current template

    setup           One-time global setup (autostart config)
    status          Show all registered projects and their status
    list            List all registered projects

    index [path]    Manually index a directory (default: current directory)
    index --force   Force re-index all files

    gui             Open the monitoring dashboard in the browser
    stats           Show token stats overview

    migrate         Move all project indexes from ~/.pindex/projects/ to {project}/.pindex/
    uninstall       Stop all daemons (data kept in ~/.pindex)

  Examples:
    cd /my/project && pindex        # set up this project
    pindex add /other/project       # link another repo
    pindex status                   # show all projects
    pindex-gui                      # open stats dashboard
`);
      break;
  }
}

main().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
