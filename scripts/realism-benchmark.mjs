#!/usr/bin/env node
// scripts/realism-benchmark.mjs
// PindeX realism benchmark: A/B Claude Code runs with PindeX on vs off.
// Spec: docs/superpowers/specs/2026-04-25-realism-benchmark-design.md

import { argv, exit, cwd, env } from 'node:process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = {
    codebases: ['pindex', 'typescript-eslint'],
    tasksLimit: Infinity,
    budget: 5.0,
    model: 'claude-sonnet-4-6',
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--codebases':
        opts.codebases = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--tasks-limit':
        opts.tasksLimit = parseInt(args[++i], 10);
        break;
      case '--budget':
        opts.budget = parseFloat(args[++i]);
        break;
      case '--model':
        opts.model = args[++i];
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        exit(0);
      default:
        process.stderr.write(`[realism] unknown arg: ${a}\n`);
        exit(2);
    }
  }
  return opts;
}

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

// ─── Claude CLI capability probe ──────────────────────────────────────────────

function detectClaudeCapabilities() {
  const help = spawnSync('claude', ['--help'], { encoding: 'utf-8' });
  if (help.status !== 0) {
    throw new Error(`'claude --help' exited ${help.status}: ${help.stderr}`);
  }
  const text = help.stdout + (help.stderr ?? '');
  return {
    hasMcpConfig: /\-\-mcp-config\b/.test(text),
    hasAppendSystemPrompt:
      /\-\-system-prompt-append\b/.test(text) || /\-\-append-system-prompt\b/.test(text),
    appendSystemPromptFlag:
      (/\-\-system-prompt-append\b/.test(text) && '--system-prompt-append') ||
      (/\-\-append-system-prompt\b/.test(text) && '--append-system-prompt') ||
      null,
  };
}

// ─── MCP config writers ───────────────────────────────────────────────────────

const PINDEX_SERVER_BIN = 'pindex-server';

function writeBenchmarkMcpConfigs(targetProjectRoot, baselineMode, mcpDbPath) {
  // Builds a minimal .mcp.json that points at the indexed DB for the target
  // codebase and toggles BASELINE_MODE. Returns the path written to.
  const cfg = {
    mcpServers: {
      pindex: {
        command: PINDEX_SERVER_BIN,
        args: [],
        env: {
          INDEX_PATH: mcpDbPath,
          PROJECT_ROOT: targetProjectRoot,
          LANGUAGES: 'typescript,javascript',
          AUTO_REINDEX: 'false',
          BASELINE_MODE: baselineMode ? 'true' : 'false',
          MONITORING_PORT: '0',
          MONITORING_AUTO_OPEN: 'false',
        },
      },
    },
  };
  const filename = baselineMode ? '.benchmark-mcp-baseline.json' : '.benchmark-mcp-pindex.json';
  const path = join(cwd(), filename);
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

// ─── Single Claude invocation ─────────────────────────────────────────────────

const SYSTEM_PROMPT_APPEND =
  'Use mcp__pindex__* tools whenever possible for codebase exploration. ' +
  'Prefer search_symbols, find_usages, get_dependencies, and get_file_summary over Read/Grep.';

function runClaudeOnce({ prompt, model, mcpConfigPath, capabilities, dryRun }) {
  const args = [
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'json',
  ];
  if (capabilities.hasMcpConfig && mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
  if (capabilities.appendSystemPromptFlag) {
    args.push(capabilities.appendSystemPromptFlag, SYSTEM_PROMPT_APPEND);
  }

  if (dryRun) {
    return { dryRun: true, command: ['claude', ...args].map((s) => JSON.stringify(s)).join(' ') };
  }

  const result = spawnSync('claude', args, {
    encoding: 'utf-8',
    timeout: 5 * 60_000, // 5 minutes per call
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `'claude' exited ${result.status}: ${result.stderr?.slice(0, 500) ?? '<no stderr>'}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`Could not parse Claude JSON output: ${String(err)}\nstdout: ${result.stdout.slice(0, 500)}`);
  }
  return parsed;
}

// ─── Cost arithmetic ──────────────────────────────────────────────────────────

// Sonnet 4.6 published rates (USD per 1M tokens). Update if the model changes.
const SONNET46_INPUT_PER_M = 3.0;
const SONNET46_OUTPUT_PER_M = 15.0;
const SONNET46_CACHE_READ_PER_M = 0.3;

function costUsd(usage) {
  const input = usage?.input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  return (
    (input * SONNET46_INPUT_PER_M +
      cacheRead * SONNET46_CACHE_READ_PER_M +
      output * SONNET46_OUTPUT_PER_M) /
    1_000_000
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(argv.slice(2));
  const capabilities = detectClaudeCapabilities();

  console.log('[realism] capabilities:', capabilities);
  console.log('[realism] options:', opts);

  if (opts.dryRun) {
    // Print one example invocation per condition.
    const exampleMcp = writeBenchmarkMcpConfigs(cwd(), false, '/tmp/example.db');
    const cmd = runClaudeOnce({
      prompt: 'example task',
      model: opts.model,
      mcpConfigPath: exampleMcp,
      capabilities,
      dryRun: true,
    });
    console.log('[realism] sample command:', cmd.command);
    exit(0);
  }

  console.error('[realism] full execution arrives in Task 3');
  exit(1);
}

main();
