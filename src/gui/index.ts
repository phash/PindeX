#!/usr/bin/env node
/**
 * pindex-gui entry point.
 * Starts an aggregated dashboard server and opens the browser.
 */
import { startGuiServer } from './server.js';
import { GUI_DEFAULT_PORT, guiPortCandidates } from '../cli/project-detector.js';

const NO_OPEN = process.argv.includes('--no-open');

const portArgIdx = process.argv.indexOf('--port');
const BASE_PORT = portArgIdx !== -1 && process.argv[portArgIdx + 1]
  ? parseInt(process.argv[portArgIdx + 1], 10)
  : parseInt(process.env.GUI_PORT ?? String(GUI_DEFAULT_PORT), 10);

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startGuiServer>> | null = null;
  const candidates = guiPortCandidates(BASE_PORT);
  for (const [i, tryPort] of candidates.entries()) {
    try {
      server = await startGuiServer(tryPort);
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        const next = candidates[i + 1];
        if (next === undefined) {
          console.error(`  [pindex-gui] No free port found (tried ${candidates.join(', ')}). Set GUI_PORT=<port> to override.`);
          process.exit(1);
        }
        console.error(`  [pindex-gui] Port ${tryPort} in use, trying ${next}…`);
        continue;
      }
      throw err;
    }
  }

  const port = server!.port;
  console.log(`\n  PindeX Dashboard  →  http://localhost:${port}\n`);

  if (!NO_OPEN) try {
    const { default: open } = await import('open');
    await open(`http://localhost:${port}`);
  } catch {
    // open is optional – ignore if it fails
  }

  // Keep the process alive
  process.on('SIGINT', () => {
    console.log('\n  Dashboard stopped.');
    process.exit(0);
  });
}

process.on('uncaughtException', (err) => {
  console.error('[pindex-gui] Uncaught exception (keeping process alive):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[pindex-gui] Unhandled rejection (keeping process alive):', reason);
});

main().catch((err: unknown) => {
  console.error('pindex-gui error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
