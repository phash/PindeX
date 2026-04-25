#!/usr/bin/env node
// scripts/realism-benchmark.mjs
// PindeX realism benchmark: A/B Claude Code runs with PindeX on vs off.
// Spec: docs/superpowers/specs/2026-04-25-realism-benchmark-design.md

import { argv, exit } from 'node:process';

function printHelp() {
  console.log(`
realism-benchmark — measures Claude Code token usage with PindeX on vs off

Usage:
  node scripts/realism-benchmark.mjs [options]

Options:
  --codebases <list>   Comma-separated, default: pindex,typescript-eslint
  --tasks-limit <n>    Run only the first N tasks per codebase (smoke test)
  --budget <usd>       Hard cost cap; abort when exceeded (default 5.0)
  --model <id>         Claude model id (default claude-sonnet-4-6)
  --dry-run            Print the planned invocations without running
  --help               This help text
`);
}

const args = argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  exit(0);
}

console.error('[realism] not implemented yet — see Task 2');
exit(1);
