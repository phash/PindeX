import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { getMcpIndexerHome } from './project-detector.js';

const DEFAULT_CONFIG = {
  version: '1.0.0',
  daemon: {
    mcpPort: 7841,
    monitoringPort: 7842,
    autoStart: true,
  },
  indexing: {
    languages: ['typescript', 'javascript'],
    ignore: ['node_modules', '.git', 'dist', 'build', '.next'],
    generateSummaries: false,
  },
  tokenPrice: {
    inputPerMillion: 3.0,
    model: 'claude-sonnet',
  },
};

/** Writes or merges the MCP server registration into Claude Code's config. */
export function registerMcpServer(): void {
  const claudeConfigPath = join(homedir(), '.claude', 'claude_code_config.json');

  const mcpServerEntry = {
    'codebase-indexer': {
      command: 'mcp-indexer-daemon',
      args: ['--client-mode'],
      env: {},
    },
  };

  let config: Record<string, unknown> = {};

  if (existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
    } catch {
      config = {};
    }
  }

  const existing = (config.mcpServers as Record<string, unknown>) ?? {};
  config.mcpServers = { ...existing, ...mcpServerEntry };

  const dir = join(homedir(), '.claude');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

/** Writes the default global config file. */
export function writeGlobalConfig(): void {
  const home = getMcpIndexerHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });

  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  }
}

/** Installs a systemd user service (Linux). */
export function installSystemdService(execPath: string): void {
  const serviceDir = join(homedir(), '.config', 'systemd', 'user');
  if (!existsSync(serviceDir)) mkdirSync(serviceDir, { recursive: true });

  const serviceContent = `[Unit]
Description=MCP Codebase Indexer Daemon
After=network.target

[Service]
Type=simple
ExecStart=${execPath}
Restart=on-failure
StandardOutput=append:${getMcpIndexerHome()}/daemon.log
StandardError=append:${getMcpIndexerHome()}/daemon.log

[Install]
WantedBy=default.target
`;
  writeFileSync(join(serviceDir, 'mcp-indexer.service'), serviceContent, 'utf-8');
}

/** Runs the complete one-time setup. */
export async function runSetup(): Promise<void> {
  console.log('\n  ╔══════════════════════════════════════════════╗');
  console.log('  ║     MCP Codebase Indexer – Setup             ║');
  console.log('  ╚══════════════════════════════════════════════╝\n');

  // 1. Write global config
  process.stdout.write('  [1/3] Creating global configuration...');
  writeGlobalConfig();
  console.log(' ✓');

  // 2. Register with Claude Code
  process.stdout.write('  [2/3] Registering MCP server with Claude Code...');
  registerMcpServer();
  console.log(' ✓');

  // 3. Set up autostart (Linux only for now)
  process.stdout.write('  [3/3] Setting up autostart...');
  const plt = platform();
  if (plt === 'linux') {
    try {
      const execPath = process.execPath + ' ' + process.argv[1];
      installSystemdService(execPath);
      console.log(' ✓ (systemd)');
    } catch {
      console.log(' ⚠ (skipped – could not write systemd service)');
    }
  } else {
    console.log(` ✓ (${plt} – manual start required)`);
  }

  console.log('\n  ════════════════════════════════════════════════');
  console.log('  ✅  Setup complete!\n');
  console.log('  Start Claude Code in a project:');
  console.log('    cd /your/project && claude code .\n');
  console.log('  Monitoring Dashboard: http://localhost:7842');
  console.log('  ════════════════════════════════════════════════\n');
}
