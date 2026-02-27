#!/usr/bin/env node
/**
 * pindex-gui entry point.
 * Starts an aggregated dashboard server and opens the browser.
 */
import { startGuiServer } from './server.js';

const port = parseInt(process.env.GUI_PORT ?? '7842', 10);

async function main(): Promise<void> {
  startGuiServer(port);

  console.log(`\n  PindeX Dashboard  →  http://localhost:${port}\n`);

  try {
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

main().catch((err: unknown) => {
  console.error('pindex-gui error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
