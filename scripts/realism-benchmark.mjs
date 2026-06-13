#!/usr/bin/env node
// scripts/realism-benchmark.mjs
// PindeX realism benchmark: A/B Claude Code runs with PindeX on vs off.
// Spec: docs/superpowers/specs/2026-04-25-realism-benchmark-design.md

import { argv, exit, cwd, env } from 'node:process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';

// ─── Resolve npm global bin (needed when ~/.npm-global/bin is not in PATH) ───

function resolveEnvWithNpmBin() {
  let npmPrefix = '';
  try {
    npmPrefix = execFileSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf-8' }).trim();
  } catch (_) { /* npm unavailable; fall through */ }
  const npmBin = npmPrefix ? join(npmPrefix, 'bin') : '';
  const PATH = [npmBin, env.PATH ?? ''].filter(Boolean).join(':');
  return { ...env, PATH };
}

const BENCH_ENV = resolveEnvWithNpmBin();

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
  // BASELINE = vanilla Claude Code, NO PindeX MCP server registered.
  //   The model has only the built-in tools (Read, Grep, Glob, Edit, Bash, etc.).
  // PINDEX   = Claude Code with the PindeX MCP server, full 14-tool surface.
  //
  // This is the contrast that matters for the realism benchmark: does PindeX
  // save tokens versus a user who has not installed it? PindeX's own
  // BASELINE_MODE env var is only a session label, so it cannot serve as the
  // disable mechanism — we use an empty mcpServers block instead.
  let cfg;
  if (baselineMode) {
    cfg = { mcpServers: {} };
  } else {
    cfg = {
      mcpServers: {
        pindex: {
          command: PINDEX_SERVER_BIN,
          args: [],
          env: {
            INDEX_PATH: mcpDbPath,
            PROJECT_ROOT: targetProjectRoot,
            LANGUAGES: 'typescript,javascript',
            AUTO_REINDEX: 'false',
            BASELINE_MODE: 'false',
            MONITORING_PORT: '0',
            MONITORING_AUTO_OPEN: 'false',
          },
        },
      },
    };
  }
  const filename = baselineMode ? '.benchmark-mcp-baseline.json' : '.benchmark-mcp-pindex.json';
  const path = join(targetProjectRoot, filename);
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

// ─── Single Claude invocation ─────────────────────────────────────────────────

const SYSTEM_PROMPT_APPEND =
  'Use mcp__pindex__* tools whenever possible for codebase exploration. ' +
  'Prefer search_symbols, find_usages, get_dependencies, and get_file_summary over Read/Grep.';

function runClaudeOnce({ prompt, model, mcpConfigPath, capabilities, dryRun, cwd: targetCwd }) {
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
    cwd: targetCwd,
    env: BENCH_ENV,
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

// ─── Codebase preparation ─────────────────────────────────────────────────────

function ensurePindexCodebase() {
  const root = resolve(cwd());
  const dbPath = join(root, '.pindex', 'index.db');
  if (!existsSync(dbPath)) {
    process.stderr.write(`[realism] Indexing PindeX self (this may take a minute)...\n`);
    const init = spawnSync('npx', ['--no-install', 'pindex', 'init'], {
      cwd: root,
      stdio: 'inherit',
      env: BENCH_ENV,
    });
    if (init.status !== 0) {
      throw new Error('pindex init failed for the PindeX-self codebase');
    }
    const reindex = spawnSync('npx', ['--no-install', 'pindex', 'reindex'], {
      cwd: root,
      stdio: 'inherit',
      env: BENCH_ENV,
    });
    if (reindex.status !== 0) {
      throw new Error('pindex reindex failed for the PindeX-self codebase');
    }
  }
  return { root, dbPath };
}

function ensureTypescriptEslintCodebase() {
  const root = join(tmpdir(), 'pindex-bench-typescript-eslint');
  if (!existsSync(root)) {
    process.stderr.write(`[realism] Cloning typescript-eslint into ${root}...\n`);
    const clone = spawnSync(
      'git',
      ['clone', '--depth', '1', 'https://github.com/typescript-eslint/typescript-eslint.git', root],
      { stdio: 'inherit' },
    );
    if (clone.status !== 0) {
      throw new Error('git clone of typescript-eslint failed');
    }
  }
  const dbPath = join(root, '.pindex', 'index.db');
  if (!existsSync(dbPath)) {
    process.stderr.write(`[realism] Indexing typescript-eslint (may take 1-3 min)...\n`);
    const init = spawnSync('pindex', ['init'], { cwd: root, stdio: 'inherit', env: BENCH_ENV });
    if (init.status !== 0) throw new Error('pindex init failed for typescript-eslint');
    const reindex = spawnSync('pindex', ['reindex'], { cwd: root, stdio: 'inherit', env: BENCH_ENV });
    if (reindex.status !== 0) throw new Error('pindex reindex failed for typescript-eslint');
  }
  return { root, dbPath };
}

const PREPS = {
  pindex: ensurePindexCodebase,
  'typescript-eslint': ensureTypescriptEslintCodebase,
};

// ─── Task loading ─────────────────────────────────────────────────────────────

function loadTasks(codebase) {
  const path = join(cwd(), 'benchmarks', 'tasks', `${codebase}.json`);
  const json = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(json.tasks)) throw new Error(`Bad task file: ${path}`);
  return json.tasks;
}

// ─── Per-task A/B run with order alternation ──────────────────────────────────

function runOnePair({ codebase, task, taskIndex, root, dbPath, model, capabilities, opts, costSoFar }) {
  // Even-indexed tasks: BASELINE first, then PINDEX.
  // Odd-indexed tasks:  PINDEX first, then BASELINE.
  const baselineFirst = taskIndex % 2 === 0;
  const pindexCfg = writeBenchmarkMcpConfigs(root, false, dbPath);
  const baselineCfg = writeBenchmarkMcpConfigs(root, true, dbPath);

  const order = baselineFirst ? ['baseline', 'pindex'] : ['pindex', 'baseline'];
  const out = { id: task.id, prompt: task.prompt };

  for (const which of order) {
    const cfg = which === 'pindex' ? pindexCfg : baselineCfg;
    process.stderr.write(`[realism] ${codebase}/${task.id} (${which})...\n`);

    if (costSoFar.usd > opts.budget) {
      process.stderr.write(`[realism] BUDGET EXCEEDED ($${costSoFar.usd.toFixed(2)} > $${opts.budget}); aborting\n`);
      out[which] = { error: 'budget_exceeded' };
      out.aborted = true;
      return out;
    }

    let result;
    try {
      result = runClaudeOnce({
        prompt: task.prompt,
        model,
        mcpConfigPath: cfg,
        capabilities,
        dryRun: opts.dryRun,
        cwd: root,
      });
    } catch (err) {
      process.stderr.write(`[realism] retry: ${String(err).slice(0, 200)}\n`);
      try {
        result = runClaudeOnce({
          prompt: task.prompt,
          model,
          mcpConfigPath: cfg,
          capabilities,
          dryRun: opts.dryRun,
          cwd: root,
        });
      } catch (err2) {
        out[which] = { error: String(err2).slice(0, 500) };
        continue;
      }
    }

    if (opts.dryRun) {
      out[which] = result;
      continue;
    }

    const usage = result.usage ?? {};
    const usd = costUsd(usage);
    costSoFar.usd += usd;

    const rawDir = join(cwd(), 'benchmarks', 'results', 'raw');
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(
      join(rawDir, `${codebase}-${task.id}-${which}.json`),
      JSON.stringify(result, null, 2),
    );

    out[which] = {
      input_tokens: usage.input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      duration_ms: result.duration_ms ?? 0,
      num_turns: result.num_turns ?? 0,
      cost_usd: usd,
      result_excerpt: (result.result ?? '').slice(0, 280),
    };
  }

  return out;
}

// ─── Warm-up + measurement ────────────────────────────────────────────────────

function runBenchmark(opts) {
  const capabilities = detectClaudeCapabilities();
  process.stderr.write(`[realism] capabilities: ${JSON.stringify(capabilities)}\n`);
  process.stderr.write(`[realism] options: ${JSON.stringify(opts)}\n`);

  const collected = [];
  const costSoFar = { usd: 0 };

  for (const codebase of opts.codebases) {
    const prep = PREPS[codebase];
    if (!prep) {
      process.stderr.write(`[realism] unknown codebase: ${codebase}\n`);
      continue;
    }
    const { root, dbPath } = prep();
    const tasks = loadTasks(codebase).slice(0, opts.tasksLimit);

    // Warm-up: one throwaway run per condition with the first task.
    if (!opts.dryRun && tasks.length > 0) {
      const warm = tasks[0];
      process.stderr.write(`[realism] WARM-UP for ${codebase}: ${warm.id}\n`);
      const dummy = { usd: 0 };
      runOnePair({
        codebase,
        task: warm,
        taskIndex: 0,
        root,
        dbPath,
        model: opts.model,
        capabilities,
        opts: { ...opts, budget: opts.budget },
        costSoFar: dummy,
      });
      costSoFar.usd += dummy.usd;
      process.stderr.write(`[realism] warm-up cost: $${dummy.usd.toFixed(3)}\n`);
    }

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const pair = runOnePair({
        codebase,
        task: t,
        taskIndex: i,
        root,
        dbPath,
        model: opts.model,
        capabilities,
        opts,
        costSoFar,
      });
      collected.push({ codebase, ...pair });
      if (pair.aborted) break;
    }
  }

  return { collected, totalCost: costSoFar.usd };
}

// ─── Report generator ────────────────────────────────────────────────────────

function aggregateCodebase(rows) {
  let baseTotal = 0, pindexTotal = 0, baseCacheRead = 0, pindexCacheRead = 0, outputDelta = 0;
  for (const r of rows) {
    const b = r.baseline ?? {};
    const p = r.pindex ?? {};
    baseTotal += (b.input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0);
    pindexTotal += (p.input_tokens ?? 0) + (p.cache_read_input_tokens ?? 0);
    baseCacheRead += b.cache_read_input_tokens ?? 0;
    pindexCacheRead += p.cache_read_input_tokens ?? 0;
    outputDelta += (p.output_tokens ?? 0) - (b.output_tokens ?? 0);
  }
  return {
    baseTotal,
    pindexTotal,
    ratio: baseTotal > 0 ? pindexTotal / baseTotal : null,
    baseCacheReadShare: baseTotal > 0 ? baseCacheRead / baseTotal : 0,
    pindexCacheReadShare: pindexTotal > 0 ? pindexCacheRead / pindexTotal : 0,
    outputDelta,
  };
}

function buildReport({ collected, totalCost, opts, capabilities }) {
  const byCodebase = new Map();
  for (const r of collected) {
    if (!byCodebase.has(r.codebase)) byCodebase.set(r.codebase, []);
    byCodebase.get(r.codebase).push(r);
  }

  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# PindeX Realism Benchmark — ${date}`);
  lines.push('');
  lines.push(`- Model: \`${opts.model}\``);
  lines.push(`- N runs per (task, condition): 1 (warm-up discarded)`);
  lines.push(`- Order alternation: even-indexed tasks BASELINE→PINDEX, odd-indexed PINDEX→BASELINE`);
  lines.push(`- Cost rates: input \\$${SONNET46_INPUT_PER_M}/M, cache-read \\$${SONNET46_CACHE_READ_PER_M}/M, output \\$${SONNET46_OUTPUT_PER_M}/M`);
  lines.push(`- Total measured spend: \\$${totalCost.toFixed(3)}`);
  lines.push(`- Claude CLI capabilities: ${JSON.stringify(capabilities ?? {})}`);
  lines.push('');
  lines.push('**Conditions:** BASELINE = vanilla Claude Code (no PindeX MCP server, only native Read/Grep/Glob/Bash). PINDEX = same Claude Code with the PindeX MCP server registered (14 mcp__pindex__* tools available).');
  lines.push('');

  for (const [codebase, rows] of byCodebase) {
    lines.push(`## Codebase: ${codebase}`);
    lines.push('');
    lines.push('| Task | Baseline input | PindeX input | Ratio | Cache-read share (PindeX) | Output Δ |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const r of rows) {
      const b = r.baseline ?? {};
      const p = r.pindex ?? {};
      const baseTot = (b.input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0);
      const pinTot = (p.input_tokens ?? 0) + (p.cache_read_input_tokens ?? 0);
      const ratio = baseTot > 0 ? (pinTot / baseTot).toFixed(3) : 'n/a';
      const pCacheShare = pinTot > 0 ? `${((p.cache_read_input_tokens ?? 0) / pinTot * 100).toFixed(0)}%` : 'n/a';
      const outDelta = (p.output_tokens ?? 0) - (b.output_tokens ?? 0);
      const promptShort = r.prompt.slice(0, 64).replace(/\|/g, '\\|');
      lines.push(`| **${r.id}** ${promptShort}… | ${baseTot.toLocaleString()} | ${pinTot.toLocaleString()} | ${ratio} | ${pCacheShare} | ${outDelta >= 0 ? '+' : ''}${outDelta} |`);
    }
    const agg = aggregateCodebase(rows);
    const aggRatio = agg.ratio !== null ? agg.ratio.toFixed(3) : 'n/a';
    lines.push(`| **TOTAL** | ${agg.baseTotal.toLocaleString()} | ${agg.pindexTotal.toLocaleString()} | **${aggRatio}** | ${(agg.pindexCacheReadShare * 100).toFixed(0)}% | ${agg.outputDelta >= 0 ? '+' : ''}${agg.outputDelta} |`);
    lines.push('');
  }

  lines.push('## Conclusion');
  lines.push('');
  for (const [codebase, rows] of byCodebase) {
    const agg = aggregateCodebase(rows);
    if (agg.ratio === null) continue;
    const pct = (Math.abs(1 - agg.ratio) * 100).toFixed(0);
    const direction = agg.ratio < 1 ? 'reduces' : 'increases';
    lines.push(`- **${codebase}**: PindeX ${direction} total input tokens by ${pct}% (ratio ${agg.ratio.toFixed(3)}; cache-read share ${(agg.pindexCacheReadShare * 100).toFixed(0)}%).`);
  }
  lines.push('');
  lines.push('## Appendix: per-task answers (excerpts)');
  lines.push('');
  for (const [codebase, rows] of byCodebase) {
    lines.push(`### ${codebase}`);
    lines.push('');
    for (const r of rows) {
      lines.push(`#### ${r.id}: ${r.prompt}`);
      lines.push('');
      lines.push(`**Baseline answer:** ${r.baseline?.result_excerpt ?? '<error>'}`);
      lines.push('');
      lines.push(`**PindeX answer:** ${r.pindex?.result_excerpt ?? '<error>'}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(argv.slice(2));
  const capabilities = detectClaudeCapabilities();
  const { collected, totalCost } = runBenchmark(opts);

  if (opts.dryRun) {
    console.log('[realism] dry-run plan:');
    for (const r of collected) console.log(JSON.stringify(r, null, 2));
    exit(0);
  }

  const rawDir = join(cwd(), 'benchmarks', 'results', 'raw');
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(
    join(rawDir, 'aggregate.json'),
    JSON.stringify({ collected, totalCost, opts, capabilities }, null, 2),
  );

  const md = buildReport({ collected, totalCost, opts, capabilities });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = join(cwd(), 'benchmarks', 'results', `${date}-realism.md`);
  let finalPath = outPath;
  let suffix = 0;
  while (existsSync(finalPath)) {
    suffix++;
    finalPath = outPath.replace(/\.md$/, `-${suffix}.md`);
  }
  writeFileSync(finalPath, md);

  console.log(`[realism] done. total spend: \$${totalCost.toFixed(3)}.`);
  console.log(`[realism] report: ${finalPath}`);
}

main();
