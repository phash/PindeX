import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePindexHome, writeFileSecure } from './project-detector.js';

const DEFAULT_CONFIG = {
  version: '1.0.0',
  daemon: {
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

/** Writes the default global config file. */
export function writeGlobalConfig(): void {
  const home = ensurePindexHome();

  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) {
    writeFileSecure(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}

/** Runs the complete one-time setup. */
export async function runSetup(): Promise<void> {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║        PindeX – Setup                    ║');
  console.log('  ╚══════════════════════════════════════════╝\n');

  // Write global config
  process.stdout.write('  Creating global configuration...');
  writeGlobalConfig();
  console.log(' ✓');

  console.log('\n  ══════════════════════════════════════════');
  console.log('  ✅  Setup complete!\n');
  console.log('  Next: run  pindex  in any project directory');
  console.log('  to generate .mcp.json and activate indexing.\n');
  console.log('  Dashboard: pindex-gui');
  console.log('  ══════════════════════════════════════════\n');
}
