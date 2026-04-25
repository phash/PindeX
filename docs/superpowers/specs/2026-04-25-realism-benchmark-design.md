# PindeX Realism Benchmark — Design Spec

**Date:** 2026-04-25
**Status:** Approved for implementation planning
**Target area:** `scripts/`, `benchmarks/` (new directories)

## Problem

PindeX ships with claims that need verification under realistic conditions: "structural codebase indexing for token-efficient AI coding assistants on medium-to-large projects". The README's existing benchmark (5 tasks on a 25-file synthetic project) deliberately picked a project below break-even and showed PindeX *costing* +47 % more tokens than baseline. That is honest about small-project pessimism but does nothing to validate the medium-to-large pitch.

After v1.3.0 (parallel indexing), v1.4.0 (Pyright LSP), and v1.5.0 (federation MVP), the project needs a credible, reproducible measurement of token consumption with PindeX on vs off across two real codebases of different sizes. The result either supports the marketing claim or refutes it; both outcomes are useful.

## Goals

- Measure input + output + cache-read tokens per task with PindeX on vs PindeX off (`BASELINE_MODE=true`) under identical prompts.
- Two target codebases: PindeX itself (~50 files, ~7 300 LOC — at the README's break-even line) and `microsoft/typescript-eslint` (~600 files, ~80 000 LOC — well above break-even).
- 6 deterministic Q&A tasks per codebase, hand-curated, each with a verifiable expected answer.
- Single Claude model: Sonnet 4.6 (matches the existing README benchmark for cross-comparability).
- Use the **real Claude Code CLI in `--print --output-format=json` mode** so the measurement reflects the same code path users hit.
- Generate a markdown report with per-task, per-codebase, and total input-token ratios.
- Cost-bounded: hard-cap per run, expected total budget ≤ $5.

## Non-Goals

- Multi-model comparisons (Haiku vs Sonnet vs Opus). One model, one result.
- Code-generation tasks ("implement feature X"). Output-token variance would dominate; Q&A is the cleanest A/B surface.
- PindeX vs Serena head-to-head. Separate spec.
- Multi-run statistics (t-test, confidence intervals). N=1 for the size-of-effect; only escalate to N=3 for a single task if its ratio looks like an outlier.
- Federation cross-repo queries. The 1.5.0 federation feature is in scope for the test setup (`pindex federate` configures targets) but there are no benchmark tasks that scope across repos.
- Re-indexing time measurement. That is already covered by `npm run bench:index`.
- Anthropic Agent SDK or direct API path. We deliberately use the CLI to measure what real users experience.

## Architecture

```
scripts/realism-benchmark.mjs (the runner)
  │
  ├─ for each codebase ∈ { pindex (this repo), typescript-eslint (cloned to /tmp) }:
  │     ├─ ensure indexed: pindex init && wait for the index to be complete
  │     ├─ for each task ∈ benchmarks/tasks/<codebase>.json (6 tasks):
  │     │     ├─ Run "PINDEX": claude -p "$task" --output-format=json
  │     │     │    .mcp.json env contains BASELINE_MODE=false
  │     │     │    Capture: usage.{input_tokens, cache_read_input_tokens,
  │     │     │             cache_creation_input_tokens, output_tokens},
  │     │     │             duration_ms, num_turns, result text
  │     │     │
  │     │     └─ Run "BASELINE": claude -p "$task" --output-format=json
  │     │          .mcp.json env contains BASELINE_MODE=true
  │     │          (same exact prompt, same model, same flags)
  │     │
  │     └─ aggregate per-codebase totals, ratios
  │
  └─ write benchmarks/results/<YYYY-MM-DD>-realism.md
```

### Switching `BASELINE_MODE` between runs

The runner generates two sibling files at the project root (or in a temp scratch dir) and points `claude` at the correct one per run via the `--mcp-config <path>` flag (Claude CLI supports overriding `.mcp.json` location):

- `.benchmark-mcp-pindex.json` → `mcpServers.pindex.env.BASELINE_MODE = "false"`
- `.benchmark-mcp-baseline.json` → `mcpServers.pindex.env.BASELINE_MODE = "true"`

Both files use identical paths to the indexed DB, the project root, and the same MCP server binary. The only diff is the env flag.

If the Claude CLI version installed does not accept `--mcp-config`, the runner falls back to swapping `.mcp.json` in place between runs and restoring it afterwards. Detection is done up-front by `claude --help | grep -q mcp-config`.

### Measurement contract

A successful run produces JSON of the shape:

```json
{
  "type": "result",
  "subtype": "success",
  "result": "<Claude's final answer text>",
  "usage": {
    "input_tokens": 12345,
    "output_tokens": 234,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  },
  "duration_ms": 8123,
  "num_turns": 4
}
```

The runner extracts and persists all fields. Reported metrics:
- **Effective input tokens** = `input_tokens + cache_read_input_tokens` (cache reads ARE charged, just at a discount; the pitch is total input consumption).
- **Cache read share** = `cache_read_input_tokens / (input_tokens + cache_read_input_tokens)` (informational; tells us how much Anthropic auto-caching mattered).
- **Output tokens** (informational; the pitch is input tokens).
- **Duration / turns** (informational; helps explain outliers).

### Confound control

- **Identical prompt strings.** Each task is loaded once and passed verbatim to both runs.
- **Bounded Q&A tasks** (Section: Tasks). No code generation → low output-token variance, low semantic-correctness variance.
- **One model.** Sonnet 4.6 across the board, matching the README baseline.
- **Pre-warmed index.** PindeX is indexed once before the benchmark loop starts; tasks read only.
- **Throw-away warmup run.** Before the timed runs, fire one warm-up task per condition that we discard. Reduces MCP-server cold-start bias.
- **Same Anthropic auto-cache state.** No `cache_control` overrides; the auto-cache is what real users experience. **Order alternation:** for even-indexed tasks the order is BASELINE→PINDEX, for odd-indexed it is PINDEX→BASELINE. This averages out any 5-minute auto-cache warm-up advantage that would otherwise systematically favour the second run within each pair.
- **N=1 per (task, condition).** If a per-task ratio is a clear outlier (>3× away from the codebase mean), the runner re-runs that task 2 more times and uses the median. Documented in the report.

## Components

### New files

**`scripts/realism-benchmark.mjs`** — The runner. ~150 LOC, plain Node ESM, no extra deps. Responsibilities:
- CLI: `node scripts/realism-benchmark.mjs [--codebases pindex,typescript-eslint] [--budget 5.0]`.
- Detect `claude` binary (`which claude`, fail fast if missing).
- Detect `--mcp-config` support; pick the swap strategy.
- For target `typescript-eslint`: `git clone --depth 1` into `/tmp` if not already there; `pindex init`; wait for index completion (`pindex status` polling until `index_recommendation` is populated, or 5 min timeout).
- For target `pindex`: assert `.pindex/index.db` exists; if not, run `pindex init` in the project root.
- Generate the two `.benchmark-mcp-*.json` files.
- Per task: run two `claude -p` invocations sequentially; parse JSON output; collect usage; track running cost (input × $3/M + output × $15/M, Sonnet 4.6 published rates) and abort when total cost > `--budget`.
- Discard the first warm-up run per condition.
- Build the markdown report.

**`benchmarks/tasks/pindex.json`** — 6 Q&A tasks for the PindeX codebase. Schema:

```json
{
  "tasks": [
    {
      "id": "pindex-1",
      "prompt": "Where is the RepoSet class defined? List its public methods.",
      "expected_answer_hint": "src/federation/repo-set.ts; methods: filter, primary, all"
    },
    ...
  ]
}
```

**`benchmarks/tasks/typescript-eslint.json`** — 6 Q&A tasks for the typescript-eslint codebase. Same schema.

**`benchmarks/results/<YYYY-MM-DD>-realism.md`** — Auto-generated report. Pre-existing files are not overwritten on re-run; the runner appends a date+time suffix if the file already exists.

### Modified files

**`package.json`** — add a script alias:
```json
"bench:realism": "node scripts/realism-benchmark.mjs"
```

**`.gitignore`** — add the two transient MCP files:
```
.benchmark-mcp-pindex.json
.benchmark-mcp-baseline.json
```

### Unchanged

- No code in `src/`. The benchmark uses PindeX entirely from outside.
- No tests added to the unit suite. Benchmarks are not unit-test material; they are scripts run on demand and produce reports.

## Tasks

### PindeX codebase (6 tasks)

1. *Where is the `RepoSet` class defined? What public methods does it have?* — exercises FTS class lookup + method listing.
2. *Which MCP tools accept the `repos` parameter? List them.* — exercises cross-file pattern (Zod schemas).
3. *How does crash recovery work in `LspPythonClient`? Describe the state transitions.* — exercises multi-file reasoning.
4. *Where is `assignName` called from? List all call sites.* — exercises usage lookup.
5. *What does `src/indexer/index.ts` import? Give the dependency list.* — exercises `get_dependencies` if PindeX is on; native file read otherwise.
6. *Explain how `processParsedFile` interacts with the AST diff engine.* — exercises symbol→file→symbol traversal.

### typescript-eslint codebase (6 tasks)

1. *Where is the rule-creator helper (the function used to define an ESLint rule, like `RuleCreator` or `createRule`) defined?*
2. *How many plugin packages does this monorepo contain? Where do they live?*
3. *What test helpers exist under `packages/eslint-plugin/tests`? List the top-level classes and exported functions.*
4. *Explain the type-resolver strategy: where is `program.getTypeChecker()` invoked?*
5. *How is the TSConfig consumed by `parseAndGenerateServices`? Show the relevant call graph.*
6. *Where is the AST converted to TSESTree format?*

### Common properties

- Every task has a verifiable answer that can be sanity-checked manually before the benchmark runs.
- Mix of: "where is X" (FTS hit), "how many / which" (aggregation), "how does Y work" (multi-file reasoning).
- Zero code generation. Zero "implement feature Y".

## Data Flow

1. User runs `npm run bench:realism`.
2. Runner verifies the `claude` binary, the model availability (sends a 1-token health check), and the test-codebase indexes.
3. Runner generates the two `.benchmark-mcp-*.json` files.
4. **Warm-up phase**: one task per condition is run and discarded.
5. **Measurement loop**: for each codebase × task × condition, run `claude -p "$prompt" --model claude-sonnet-4-6 --output-format=json --mcp-config <path>`. Capture and persist the JSON output to `benchmarks/results/raw/<codebase>-<task-id>-<condition>.json`.
6. After each run, increment `total_cost_usd` and abort with a clear message if it exceeds the budget.
7. Once all runs settle, the runner aggregates per-task ratios (`pindex_input / baseline_input`), per-codebase totals, and writes the markdown report.

## Report Format

```markdown
# PindeX Realism Benchmark — pindex 1.5.0 — 2026-04-25 14:00

- Model: claude-sonnet-4-6
- N runs per (task, condition): 1 (warm-up discarded)
- Cost rates: input $3/M, output $15/M (Sonnet 4.6 published)
- Total measured spend: $X.XX

## Codebase: PindeX (50 files, 7 300 LOC)

| Task                                            | Baseline input | PindeX input | Ratio  | Cache-read share (PindeX) | Output Δ |
| ----------------------------------------------- | -------------: | -----------: | -----: | ------------------------: | -------: |
| 1. Where is RepoSet defined?                    |        24 138  |        8 420 |  0.349 |                     12 %  |     +12  |
| 2. Which tools take repos param?                |        31 201  |       12 003 |  0.385 |                      9 %  |      -3  |
| ...                                             |          ...   |        ...   |  ...   |                    ...    |    ...   |
| **Total**                                       |       165 432  |       73 221 |  **0.443**  |              **11 %** | **+47**  |

## Codebase: typescript-eslint (600 files, 80 000 LOC)

(same shape)

## Conclusion

PindeX 1.5.0 reduces total input tokens by **NN %** on PindeX-self
(cache-read share **MM %**) and **NN %** on typescript-eslint
(cache-read share **MM %**), under a 6-task Q&A workload using Sonnet 4.6.

[Plain-language interpretation: 1–3 sentences on what this means for a real user.]

## Appendix: Per-task answers

For each task, the result text from both conditions is included verbatim
so a reader can sanity-check that Claude actually answered the question
(rather than e.g. hitting a tool error and producing an empty response).
```

The Conclusion text is filled in by hand (or by a second prompt to Claude post-run if the user wants); it is not numerically computed beyond the percentages.

## Error Handling

| Failure | Behaviour |
|---|---|
| `claude` binary missing | Fail fast with install instructions. |
| `claude --mcp-config` not supported by installed version | Fall back to in-place `.mcp.json` swap; restore on exit (and on signal — `SIGINT` cleanup). |
| `typescript-eslint` clone fails | Report a setup failure, run only the PindeX-codebase half. Document in the report. |
| PindeX indexing of typescript-eslint fails (timeout, bug) | Same as above. |
| One run produces malformed JSON | Retry once. If second run also fails, mark that task ERROR in the report and exclude from totals. |
| Per-run input tokens > 200 000 | Abort entire run, report the offending task and its prompt. (Sanity bound; a Q&A task should be well under this.) |
| Total cost > `--budget` | Abort the loop, write a partial report with the runs completed so far. |
| Claude in PindeX-mode chooses to use `Read`/`Grep` instead of `mcp__pindex__*` | The benchmark prompts already inherit the project `CLAUDE.md` rules ("immer mcp__pindex__* nutzen"). If the installed `claude` CLI accepts `--system-prompt-append` (or `--append-system-prompt`), the runner adds: "Use mcp__pindex__* tools whenever possible for codebase exploration." Detection at startup via `claude --help`; if the flag is absent, the runner relies on the project CLAUDE.md alone and notes this in the report header so the reader can interpret. The appendix per-task answers reveal whether Claude actually used PindeX tools or not. |

## Testing

- The runner script itself is exercised by running it once on the PindeX codebase only with a 1-task subset (`--tasks-limit 1`) before the full run, as a smoke test.
- No unit tests added. The script's correctness is observed via the report it produces.
- A dry-run mode (`--dry-run`) prints the planned invocations without calling `claude`, for verifying the run plan without spending tokens.

## Risks

1. **Claude non-determinism.** N=1 is a deliberate cost trade-off; if a per-task ratio looks anomalous, the runner re-runs that single task 2× more for a 3-sample median. Documented in the report header.
2. **Workflow asymmetry.** Claude in PindeX-mode might still fall back to `Read`/`Grep`. The `--system-prompt-append` plus project `CLAUDE.md` directs it; if the appendix shows it ignored the directive, the result is reported and not silently retried.
3. **Cache-read interference.** Two consecutive runs of the same prompt may benefit one mode more than the other from Anthropic's auto-cache. Cache-read tokens are reported separately so a reader can interpret the gross vs net savings.
4. **Cost overrun.** Hard cap via `--budget` and a per-run 200k-token sanity check.
5. **typescript-eslint indexing failure.** Out of our control if a parser regression bites; the report degrades gracefully to PindeX-only data.
6. **Q&A task suite is biased toward FTS lookup.** That is acknowledged: this benchmark measures the lookup USP, not whole-task coding workflows. A future spec can add coding tasks once we have multi-run averaging in place.

## Rollback Plan

The benchmark is purely additive — new scripts and a new directory under `benchmarks/`. There is no `src/` change, no DB migration, no published artifact to revert. If the report turns out to be misleading, we delete the report file and re-run with adjusted task selection or methodology; the script remains usable.
