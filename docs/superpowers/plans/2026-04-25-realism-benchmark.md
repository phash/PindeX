# PindeX Realism Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a benchmark runner that measures real Claude token consumption with PindeX on vs off across the PindeX codebase and `microsoft/typescript-eslint`, then run it and produce a publishable markdown report.

**Architecture:** A single Node ESM script (`scripts/realism-benchmark.mjs`) that drives the existing Claude Code CLI in `--print --output-format=json` mode against pre-curated task lists. BASELINE_MODE is toggled via two sibling `.mcp.json` files passed through `claude --mcp-config` (or in-place swap as fallback). All measurement comes from the JSON usage object the CLI emits. No `src/` changes.

**Tech Stack:** Node 18+ ESM, plain JavaScript (no TypeScript compile), Claude Code CLI, the existing PindeX 1.5.0 release.

**Spec:** `docs/superpowers/specs/2026-04-25-realism-benchmark-design.md`

---

## Context For The Implementer

Before starting, read:
- `docs/superpowers/specs/2026-04-25-realism-benchmark-design.md` — the approved design.
- `CLAUDE.md` (project root) — commit/workflow rules.
- `src/monitoring/estimator.ts` — to understand how PindeX's existing internal estimator differs from this external benchmark.

### Worktree

Work from `/home/manuel/claude/PindeX-realism` on branch `bench/realism`.
**Every shell command starts with `cd /home/manuel/claude/PindeX-realism`** and `git rev-parse --abbrev-ref HEAD` MUST return `bench/realism` before any `git commit`. Subagent prior sessions have committed to wrong worktrees; do not repeat.

The worktree starts WITHOUT `node_modules/`. Task 1 includes `npm install`.

### Conventions
- Plain JS, ESM (`.mjs`), no TS compile step needed.
- No silent catches — `process.stderr.write` for errors with `[realism]` tag.
- Commit messages: `feat(bench):`, `chore:`, `docs:`, with the standard Co-Authored-By footer.

### Commands you'll use
- `npm install` — needed once at start of Task 1.
- `node scripts/realism-benchmark.mjs --dry-run` — preview without spending tokens.
- `node scripts/realism-benchmark.mjs --tasks-limit 1` — single-task smoke test.
- `node scripts/realism-benchmark.mjs` — full run.
- `which claude && claude --version` — verify Claude CLI before running.

### Cost awareness

Real Claude API tokens get spent. Hard-cap the total via `--budget` (default $5). A single Q&A run is typically 10-50K input tokens (~$0.03-0.15 with Sonnet 4.6). Twelve tasks × two conditions × ~$0.10 = ~$2.40 expected. Budget overrun aborts the loop and writes a partial report.

---

## File Structure

### New files
- `scripts/realism-benchmark.mjs` — the runner (~300 LOC).
- `benchmarks/tasks/pindex.json` — 6 tasks for the PindeX codebase.
- `benchmarks/tasks/typescript-eslint.json` — 6 tasks for typescript-eslint.
- `benchmarks/results/.gitkeep` — keep the directory under version control even when empty.
- `benchmarks/results/<YYYY-MM-DD>-realism.md` — the produced report (committed only when satisfactory).

### Modified files
- `package.json` — `bench:realism` npm script alias.
- `.gitignore` — `.benchmark-mcp-pindex.json`, `.benchmark-mcp-baseline.json`, raw run logs.

### Unchanged
- Everything in `src/` and `tests/`.

---

## Task 1: Skeleton + task fixtures

Create the directory layout, the two task JSON files, the npm script alias, and a stub `realism-benchmark.mjs` that prints help and exits.

**Files:**
- Create: `scripts/realism-benchmark.mjs`
- Create: `benchmarks/tasks/pindex.json`
- Create: `benchmarks/tasks/typescript-eslint.json`
- Create: `benchmarks/results/.gitkeep`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install deps + verify Claude CLI**

```bash
cd /home/manuel/claude/PindeX-realism
npm install 2>&1 | tail -3
which claude && claude --version
```
Expected: `npm install` clean. `claude` resolved on PATH with a sensible version string. If `claude` is missing, STOP and report — the benchmark cannot run.

- [ ] **Step 2: Create the directory layout**

```bash
cd /home/manuel/claude/PindeX-realism
mkdir -p scripts benchmarks/tasks benchmarks/results benchmarks/results/raw
touch benchmarks/results/.gitkeep
```

- [ ] **Step 3: Create `benchmarks/tasks/pindex.json`**

```json
{
  "tasks": [
    {
      "id": "pindex-1",
      "prompt": "Where is the RepoSet class defined? List its public methods.",
      "expected_answer_hint": "src/federation/repo-set.ts; methods: filter, primary, all"
    },
    {
      "id": "pindex-2",
      "prompt": "Which MCP tools accept the repos parameter? List them.",
      "expected_answer_hint": "search_symbols, get_symbol, get_context, get_file_summary, find_usages, get_dependencies, get_project_overview, search_docs, get_doc_chunk"
    },
    {
      "id": "pindex-3",
      "prompt": "How does crash recovery work in LspPythonClient? Describe the state transitions.",
      "expected_answer_hint": "src/indexer/lsp-python.ts; states idle/starting/ready/failed/closed; one restart attempt; 3 consecutive timeouts treated as crash"
    },
    {
      "id": "pindex-4",
      "prompt": "Where is the assignName function called from? List all call sites.",
      "expected_answer_hint": "src/cli/project-detector.ts (read + upsert), src/cli/federate.ts, src/index.ts"
    },
    {
      "id": "pindex-5",
      "prompt": "What does src/indexer/index.ts import from other PindeX modules? Give the dependency list.",
      "expected_answer_hint": "parser, queries, ast-diff, summarizer, parse-pool, lsp-python"
    },
    {
      "id": "pindex-6",
      "prompt": "Explain how processParsedFile interacts with the AST diff engine.",
      "expected_answer_hint": "Inside the DB transaction, computeAstDiff is called before deleteSymbolsByFileId; the resulting diff is returned alongside the IndexFileResult and used by the SessionObserver."
    }
  ]
}
```

- [ ] **Step 4: Create `benchmarks/tasks/typescript-eslint.json`**

```json
{
  "tasks": [
    {
      "id": "tseslint-1",
      "prompt": "Where is the rule-creator helper (the function used to define an ESLint rule, like RuleCreator or createRule) defined?",
      "expected_answer_hint": "packages/utils/src/eslint-utils/RuleCreator.ts (in @typescript-eslint/utils)"
    },
    {
      "id": "tseslint-2",
      "prompt": "How many plugin packages does this monorepo contain? Where do they live?",
      "expected_answer_hint": "Under packages/, look for eslint-plugin, eslint-plugin-tslint (deprecated), eslint-plugin-internal — count exact under packages/."
    },
    {
      "id": "tseslint-3",
      "prompt": "What test helpers exist under packages/eslint-plugin/tests? List the top-level classes and exported functions.",
      "expected_answer_hint": "Look at packages/eslint-plugin/tests/util/* — RuleTester, getFixturesRootDir, etc."
    },
    {
      "id": "tseslint-4",
      "prompt": "Explain the type-resolver strategy: where is program.getTypeChecker() invoked?",
      "expected_answer_hint": "Look in packages/typescript-estree/src/parser.ts and create-program/*. Calls to getTypeChecker() trace back to parseAndGenerateServices."
    },
    {
      "id": "tseslint-5",
      "prompt": "How is the TSConfig consumed by parseAndGenerateServices? Show the relevant call graph.",
      "expected_answer_hint": "packages/typescript-estree/src/parser.ts → createProjectProgram / createIsolatedProgram / etc., depending on options.project / options.programs."
    },
    {
      "id": "tseslint-6",
      "prompt": "Where is the AST converted to TSESTree format?",
      "expected_answer_hint": "packages/typescript-estree/src/ts-estree/* and packages/typescript-estree/src/convert.ts"
    }
  ]
}
```

- [ ] **Step 5: Stub `scripts/realism-benchmark.mjs`**

```js
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
```

`chmod +x scripts/realism-benchmark.mjs` to make it executable.

- [ ] **Step 6: Add npm script alias and ignore-files**

In `package.json`, under `"scripts"`, add (preserve existing scripts):

```json
"bench:realism": "node scripts/realism-benchmark.mjs"
```

In `.gitignore`, append:

```
.benchmark-mcp-pindex.json
.benchmark-mcp-baseline.json
benchmarks/results/raw/
```

(`benchmarks/results/raw/` holds the per-run JSON dumps; only the final markdown report goes into git.)

- [ ] **Step 7: Smoke**

```bash
cd /home/manuel/claude/PindeX-realism
node scripts/realism-benchmark.mjs --help
```
Expected: prints the help text with exit code 0.

```bash
node scripts/realism-benchmark.mjs
```
Expected: stderr "[realism] not implemented yet — see Task 2"; exit code 1.

- [ ] **Step 8: Commit**

```bash
cd /home/manuel/claude/PindeX-realism
git rev-parse --abbrev-ref HEAD  # MUST say bench/realism
git add scripts/realism-benchmark.mjs benchmarks/tasks benchmarks/results/.gitkeep package.json .gitignore
git commit -m "$(cat <<'EOF'
chore(bench): scaffold realism benchmark runner + task fixtures

Adds the scripts/realism-benchmark.mjs entry point (stub for now), the
two curated 6-task JSON fixtures for PindeX-self and typescript-eslint,
and the npm run bench:realism alias. Subsequent tasks fill in the
runner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Claude CLI capability probe + invocation primitive

Implement detecting Claude's flags, building MCP config files, and a single `runClaudeOnce()` function that returns the parsed JSON output for one prompt.

**Files:**
- Modify: `scripts/realism-benchmark.mjs`

- [ ] **Step 1: Implement capability probe + arg parsing + MCP config writers**

Replace the stub `scripts/realism-benchmark.mjs` with:

```js
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
```

- [ ] **Step 2: Smoke**

```bash
cd /home/manuel/claude/PindeX-realism
node scripts/realism-benchmark.mjs --dry-run
```
Expected: prints capabilities object (`hasMcpConfig: true/false`, etc.), options, and a sample `claude -p "..." --model claude-sonnet-4-6 --output-format json [--mcp-config ...] [--system-prompt-append "..."]` command. No tokens spent.

```bash
node scripts/realism-benchmark.mjs
```
Expected: stderr "full execution arrives in Task 3"; exit 1.

- [ ] **Step 3: Lint with `node --check`**

```bash
node --check scripts/realism-benchmark.mjs
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd /home/manuel/claude/PindeX-realism
git rev-parse --abbrev-ref HEAD
git add scripts/realism-benchmark.mjs
git commit -m "$(cat <<'EOF'
feat(bench): claude CLI capability probe + invocation primitive

Detects --mcp-config and --system-prompt-append support at startup.
runClaudeOnce() builds the right argument list and parses --output-format=json.
writeBenchmarkMcpConfigs() generates the two .benchmark-mcp-*.json files
that toggle BASELINE_MODE between runs. Cost arithmetic uses the
published Sonnet 4.6 rates ($3/$15 per M; $0.30/M for cache reads).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Codebase preparation + measurement loop

Add the per-codebase prep (typescript-eslint clone, indexing) and the actual A/B measurement loop with order alternation, warm-up discard, and budget-cap.

**Files:**
- Modify: `scripts/realism-benchmark.mjs`

- [ ] **Step 1: Add prep + loop logic**

First, add `import { tmpdir } from 'node:os';` to the existing top-of-file imports (alongside `argv, exit, cwd, env` etc.). Then append the following sections to `scripts/realism-benchmark.mjs` BEFORE the `main()` function (after the existing helpers):

```js
// ─── Codebase preparation ─────────────────────────────────────────────────────

function ensurePindexCodebase() {
  const root = resolve(cwd());
  const dbPath = join(root, '.pindex', 'index.db');
  if (!existsSync(dbPath)) {
    process.stderr.write(`[realism] Indexing PindeX self (this may take a minute)...\n`);
    const init = spawnSync('npx', ['--no-install', 'pindex', 'init'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...env },
    });
    if (init.status !== 0) {
      throw new Error('pindex init failed for the PindeX-self codebase');
    }
    // Trigger an explicit reindex to ensure the DB is populated synchronously.
    const reindex = spawnSync('npx', ['--no-install', 'pindex', 'reindex'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...env },
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
    const init = spawnSync('pindex', ['init'], { cwd: root, stdio: 'inherit', env: { ...env } });
    if (init.status !== 0) throw new Error('pindex init failed for typescript-eslint');
    const reindex = spawnSync('pindex', ['reindex'], { cwd: root, stdio: 'inherit', env: { ...env } });
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
    process.stderr.write(
      `[realism] ${codebase}/${task.id} (${which})...\n`,
    );

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
      });
    } catch (err) {
      // Retry once.
      process.stderr.write(`[realism] retry: ${String(err).slice(0, 200)}\n`);
      try {
        result = runClaudeOnce({
          prompt: task.prompt,
          model,
          mcpConfigPath: cfg,
          capabilities,
          dryRun: opts.dryRun,
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

    // Persist raw run for audit.
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
      // Add warm-up cost to the running total but exclude from results.
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
```

Now replace the `main()` function with:

```js
function main() {
  const opts = parseArgs(argv.slice(2));
  const { collected, totalCost } = runBenchmark(opts);

  if (opts.dryRun) {
    console.log('[realism] dry-run plan:');
    for (const r of collected) console.log(JSON.stringify(r, null, 2));
    exit(0);
  }

  // Persist raw aggregate for the report task.
  const aggPath = join(cwd(), 'benchmarks', 'results', 'raw', 'aggregate.json');
  mkdirSync(join(cwd(), 'benchmarks', 'results', 'raw'), { recursive: true });
  writeFileSync(aggPath, JSON.stringify({ collected, totalCost, opts }, null, 2));

  console.log(`[realism] done. total spend: $${totalCost.toFixed(3)}. raw: ${aggPath}`);
  console.log('[realism] report generation lands in Task 4.');
}

main();
```

- [ ] **Step 2: Dry-run smoke**

```bash
cd /home/manuel/claude/PindeX-realism
node scripts/realism-benchmark.mjs --dry-run --codebases pindex --tasks-limit 2
```
Expected: prints two pair plans without spending tokens. Each pair shows the alternated order (task 0 = baseline first, task 1 = pindex first).

- [ ] **Step 3: Single-task real run smoke (uses Claude API tokens)**

```bash
cd /home/manuel/claude/PindeX-realism
node scripts/realism-benchmark.mjs --codebases pindex --tasks-limit 1 --budget 1.0
```
Expected: indexes PindeX (if not already), one warm-up + one measured pair, prints the total spend (likely $0.05–$0.25), writes JSON files under `benchmarks/results/raw/`. No markdown report yet (Task 4).

If this smoke fails with "claude exited <code>" or the JSON parse fails, capture stdout/stderr and report. Likely cause: model name mismatch (Sonnet 4.6 was current at v1.4.0/v1.5.0 release — confirm via `claude --help` or Anthropic console). If the model is unrecognized, retry with `--model claude-sonnet-4-7` or whatever is current.

- [ ] **Step 4: Commit**

```bash
cd /home/manuel/claude/PindeX-realism
git rev-parse --abbrev-ref HEAD
git add scripts/realism-benchmark.mjs
git commit -m "$(cat <<'EOF'
feat(bench): codebase prep + A/B measurement loop with order alternation

ensurePindexCodebase / ensureTypescriptEslintCodebase prepare each test
target (clone, pindex init, reindex) and return the indexed DB path.
runOnePair drives one Claude pair (baseline + pindex) with order
alternation per task index, budget enforcement, single retry on Claude
errors, and per-run JSON dumps under benchmarks/results/raw/.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Markdown report generator

Read the aggregate JSON, produce the human-readable report.

**Files:**
- Modify: `scripts/realism-benchmark.mjs`

- [ ] **Step 1: Add the report generator**

Append BEFORE `main()`:

```js
// ─── Report generator ────────────────────────────────────────────────────────

function pad(n, width) {
  return String(n).padStart(width);
}

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
  lines.push(`- Cost rates: input $${SONNET46_INPUT_PER_M}/M, cache-read $${SONNET46_CACHE_READ_PER_M}/M, output $${SONNET46_OUTPUT_PER_M}/M`);
  lines.push(`- Total measured spend: $${totalCost.toFixed(3)}`);
  lines.push(`- Claude CLI capabilities: ${JSON.stringify(capabilities ?? {})}`);
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
    const pct = ((1 - agg.ratio) * 100).toFixed(0);
    const direction = agg.ratio < 1 ? 'reduces' : 'increases';
    const sign = agg.ratio < 1 ? '' : '+';
    lines.push(`- **${codebase}**: PindeX ${direction} total input tokens by ${sign}${pct}% (ratio ${agg.ratio.toFixed(3)}; cache-read share ${(agg.pindexCacheReadShare * 100).toFixed(0)}%).`);
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
```

Update `main()` to call it after persisting the aggregate:

```js
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

  console.log(`[realism] done. total spend: $${totalCost.toFixed(3)}.`);
  console.log(`[realism] report: ${finalPath}`);
}
```

Note: `runBenchmark` already calls `detectClaudeCapabilities()` internally; the duplicate call in `main()` for the report is fine (it's idempotent and cheap).

- [ ] **Step 2: Re-run the same single-task smoke from Task 3**

```bash
cd /home/manuel/claude/PindeX-realism
node scripts/realism-benchmark.mjs --codebases pindex --tasks-limit 1 --budget 1.0
```
Expected: same as before, plus a `benchmarks/results/<YYYY-MM-DD>-realism.md` file with one row per codebase. Open the file and sanity-check the format.

- [ ] **Step 3: `node --check` syntax verification**

```bash
cd /home/manuel/claude/PindeX-realism
node --check scripts/realism-benchmark.mjs
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd /home/manuel/claude/PindeX-realism
git rev-parse --abbrev-ref HEAD
git add scripts/realism-benchmark.mjs
git commit -m "$(cat <<'EOF'
feat(bench): markdown report generator

Reads the aggregate JSON and produces a per-codebase table plus a
conclusion section with the percentage delta. Per-task answer excerpts
land in the appendix so a reader can sanity-check that Claude actually
answered the question rather than failing silently. Output goes to
benchmarks/results/<date>-realism.md with auto-suffix on collision.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Real benchmark run

Run the full benchmark on both codebases, validate the output, commit the report.

**Files:**
- Create: `benchmarks/results/<YYYY-MM-DD>-realism.md` (committed)

- [ ] **Step 1: Verify the model name**

The plan defaults to `claude-sonnet-4-6`. Sonnet 4.7 may also be available. Pick the model that:
- Was current as of v1.5.0 release (matches the README baseline).
- Is supported by your Claude CLI (`claude --help` may list models, or the wrong-model error is informative).

If Sonnet 4.6 is no longer accessible, switch to whatever Sonnet 4.x model the CLI accepts and document the change in the report header. Re-run with `--model claude-sonnet-4-X`.

- [ ] **Step 2: Full run on PindeX-self only first (cheaper, faster)**

```bash
cd /home/manuel/claude/PindeX-realism
node scripts/realism-benchmark.mjs --codebases pindex --budget 3.0
```
Expected: ~$0.50–$1.50 spend, 6 tasks × 2 conditions + 1 warm-up pair = 14 Claude calls. Total wall-time: 5-10 minutes.

Inspect the produced markdown report. Verify:
- All 6 tasks have rows.
- Both conditions have non-zero token counts.
- Result excerpts in the appendix are non-empty (Claude actually answered).
- Ratios look plausible (between 0.3 and 1.5 typically).

If anything looks weird (zero tokens for one condition, missing rows, identical results between conditions), STOP and investigate. Likely causes:
- BASELINE_MODE didn't take effect → check that the MCP server respects the env var (look at `src/index.ts:27`).
- Claude ignored MCP tools entirely → check appendix; if both conditions look identical, the system prompt append might not have made it through.
- One run hit a timeout → check raw JSON dumps.

Document any unusual findings in a "Notes" appendix section of the report.

- [ ] **Step 3: Full run including typescript-eslint**

```bash
cd /home/manuel/claude/PindeX-realism
node scripts/realism-benchmark.mjs --budget 5.0
```
Expected: ~$2-4 total. typescript-eslint clone + index takes 2-5 minutes the first time; cached afterwards. Then 12 tasks × 2 conditions = 24 measured runs + 2 warm-ups = 26 total Claude calls.

Inspect again. The full report should now have two codebase sections.

- [ ] **Step 4: Commit the final report**

```bash
cd /home/manuel/claude/PindeX-realism
git rev-parse --abbrev-ref HEAD
git add benchmarks/results/2026-04-25-realism.md  # adjust filename if different date
git commit -m "$(cat <<'EOF'
bench: realism benchmark results — pindex 1.5.0

A/B run: PindeX vs BASELINE_MODE on the PindeX self-codebase and on
microsoft/typescript-eslint. 6 Q&A tasks per codebase, Sonnet 4.6 (or
4.7), N=1 with order alternation, warm-up discarded.

Headline ratios in the report.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If results are surprising or one of the codebases failed, the commit still happens — partial data + diagnostic notes are more valuable than no data.

---

## Task 6: Final verification + summary

No code. Walk through the produced artifacts and confirm shippability.

- [ ] **Step 1: Read the report yourself**

```bash
cd /home/manuel/claude/PindeX-realism
cat benchmarks/results/$(ls -t benchmarks/results/*-realism.md | head -1 | xargs basename)
```

Inspect for:
- Plausible ratios (PindeX should be < 1.0 on the bigger codebase if everything works).
- Non-empty result excerpts.
- The "TOTAL" row makes sense (sum of individual task tokens).

- [ ] **Step 2: Check the per-task answer quality**

Spot-check 3 tasks: did Claude in BASELINE mode actually answer correctly? Did Claude in PindeX mode? An "incorrect" answer in either condition can still produce a valid token-cost data point, but if PindeX-mode answers are noticeably worse than BASELINE-mode answers (e.g. wrong file paths, hallucinated symbol names), that is worth flagging in the report's Conclusion section as a caveat.

- [ ] **Step 3: Final summary report-back**

Capture and post to the user:
- Total cost spent on the benchmark.
- Per-codebase ratios (and what they mean — "PindeX saved X%" or "PindeX cost X% more").
- Any tasks that errored or had to be retried.
- Any quality issues with Claude's PindeX-mode answers.
- Whether the result supports the README's "medium-to-large project" pitch.

This is the moment of truth — the realism test either validates or refutes the marketing claim. Both outcomes are publishable.

---

## Risks during implementation

1. **Claude CLI doesn't accept `--mcp-config`.** The capability probe falls back to in-place `.mcp.json` swapping. If neither works, the benchmark cannot run; abort with a clear message.

2. **Wrong model id.** `claude-sonnet-4-6` may be deprecated. The CLI returns an error mentioning the unknown model; switch to whatever is current via `--model` and document the change in the report header.

3. **typescript-eslint indexing fails.** Possible if PindeX hits a parser regression on a large repo. The script logs the failure and proceeds with only the PindeX-self half. The report shows just the one codebase.

4. **Anthropic auto-cache asymmetry.** Order-alternation mitigates the worst case, but a 5-minute window cap means consecutive runs share cache and the second run gets cheaper input tokens. Cache-read share is reported separately so the reader can interpret.

5. **Budget overrun.** Hard cap aborts the loop. Even on overrun, the runner writes a partial markdown report.

6. **Claude in PindeX-mode chooses Read/Grep anyway.** Unavoidable absent forcing. The system-prompt-append nudge plus project CLAUDE.md is the strongest steer the test can apply. If the appendix shows it ignored PindeX, the result still tells the truth about what users would experience without a stronger directive.

## When you finish

Report:
- Final per-codebase ratios.
- Total benchmark cost.
- Whether Claude actually used PindeX tools in the PindeX-mode runs (yes/no, evidence).
- Any caveats or quality issues from the appendix.
- Recommendation: is the result publishable as-is in the README, does it need a re-run with adjustments, or does it falsify the marketing claim?
