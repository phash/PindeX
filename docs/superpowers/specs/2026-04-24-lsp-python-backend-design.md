# LSP Python Backend — Design Spec

**Date:** 2026-04-24
**Status:** Approved for implementation planning
**Target area:** `src/indexer/`, new `src/indexer/lsp-python.ts`, `src/indexer/lsp-mapper.ts`

## Problem

PindeX extracts Python symbols via regex (`src/indexer/parser.ts:365–382`). Regex extractors are structurally fragile: they miss nested functions, get confused by string literals containing keywords, ignore decorators beyond `@staticmethod`/`@property`, and cannot surface type information. Projects with non-trivial Python code get lower-quality indexes than equivalent TypeScript projects, where tree-sitter provides a real AST.

Serena MCP, the closest competitor in the MCP-code-indexer category, uses Language Server Protocol servers (Pyright for Python, rust-analyzer for Rust, gopls for Go, etc.) and produces accurate symbol trees for every language it supports. PindeX's regex approach is a permanent quality gap against that baseline.

## Goals

- Replace the regex-based Python parser with output from Pyright's `textDocument/documentSymbol`.
- Ship out-of-the-box: `pyright` installs alongside `pindex` via `optionalDependencies` so end users do not have to configure anything.
- LSP is on by default when Pyright is present; `PINDEX_LSP=false` opts out.
- Never lose a Python file: any LSP failure falls back to the existing regex result instead of producing an empty index entry.
- Stay compatible with the worker-thread `ParsePool`: workers keep doing regex parsing; LSP runs on the main thread as an enhancement pass.
- Prove the architecture on one language (Python) before adding Go / Rust / Java in future specs.

## Non-Goals

- Go, Rust, Java, Kotlin, C# LSP backends (separate specs once Python is stable).
- `textDocument/references` to replace `find_usages` (future USP-upgrade subfeature).
- Hover / type-info in search results.
- `textDocument/didChange` delta updates for interactive editing workflows.
- LSP diagnostics (errors / warnings) surfaced anywhere.
- Workspace-wide symbols (`workspace/symbol`).
- Pyright config detection (`pyproject.toml`, `pyrightconfig.json`) — Pyright reads those itself when given a valid `rootUri`.

## Architecture

```
Main thread (owns DB, summariser, LSP client)
  Indexer.indexAll() / indexFile()
    ├─ ParsePool  ─────────────  (unchanged)
    │   workers: read + regex parse + hash
    │   (Python regex extractor kept as fallback)
    │
    ├─ processParsedFile(relPath, parsed, content, hash, force)
    │   ├─ if parsed.language === 'python' && this.lsp.ready:
    │   │     upgraded = await this.lsp.getDocumentSymbols(relPath, content)
    │   │     if upgraded:
    │   │         parsed.symbols = upgraded.symbols
    │   │         parsed.imports = upgraded.imports
    │   │   # LSP timeout / error / not installed: parsed remains the regex
    │   │   # result, one-time stderr warning on first miss
    │   │
    │   └─ Summariser → AST diff → DB transaction (unchanged)
    │
    └─ LspPythonClient (lazy init, persistent per Indexer)
        ├─ resolve pyright-langserver:
        │     1. node_modules/.bin/pyright-langserver   (optionalDependency)
        │     2. PATH
        │     3. not found → log once, stay not-ready, return null on queries
        ├─ JSON-RPC over stdio (vscode-jsonrpc)
        ├─ lifecycle: lazy start on first Python file → persistent
        │   → terminate on Indexer.closePool()
        └─ crash recovery: 1 restart; then ready=false for lifetime
```

**Key principle:** LSP is an **enhancement pass**, not a replacement. Every Python file is first regex-parsed (fast, never broken). The main thread overrides the regex result with LSP output when it is available and successful. Fallback is automatic: if LSP returns nothing, the regex result is already in `parsed` and flows straight into the DB transaction.

### Why enhancement-pass over replacement

1. **Pyright cold start is 2–5 s.** During warm-up, files still produce usable (regex) indexes instead of stalling.
2. **Crash recovery is trivial.** The fallback is not "no data"; it is the regex result which is already computed.
3. **Workers stay LSP-unaware.** `ParsePool` does not spawn Pyright subprocesses; only the main thread manages LSP lifecycle.
4. **Small-project fast path.** With `PINDEX_LSP=false` or only a handful of Python files, users who do not benefit from LSP pay nothing.

## Components

### New: `src/indexer/lsp-python.ts`

```ts
export interface LspPythonClientOptions {
  projectRoot: string;
  enabled: boolean;         // default true, false when PINDEX_LSP=false
  timeoutMs?: number;       // per-request timeout, default 5000
}

export type LspReadyState = 'idle' | 'starting' | 'ready' | 'failed' | 'closed';

export class LspPythonClient {
  constructor(options: LspPythonClientOptions);
  get ready(): boolean;                         // state === 'ready'
  get state(): LspReadyState;
  start(): Promise<void>;                       // idempotent; no-op once ready/failed/closed
  getDocumentSymbols(
    relPath: string,
    content: string,
  ): Promise<{ symbols: ParsedSymbol[]; imports: ParsedImport[] } | null>;
  close(): Promise<void>;                       // idempotent
}
```

Responsibilities:
- Resolve pyright-langserver path: `node_modules/.bin/pyright-langserver` first, then `PATH`, else log warning once and stay not-ready.
- Spawn subprocess with `child_process.spawn`; wire stdin/stdout to `vscode-jsonrpc` StreamMessageReader / StreamMessageWriter.
- Perform LSP `initialize` + `initialized` handshake with `rootUri` pointing at `projectRoot`.
- `getDocumentSymbols`: send `textDocument/didOpen` with file content, then `textDocument/documentSymbol`, then `textDocument/didClose`. One request at a time; in-flight requests serialised.
- Single restart policy: first unexpected subprocess exit while `ready` → mark not-ready, attempt one `start()` retry; if that also exits with non-zero, stay failed for the Indexer lifetime.
- Clean shutdown on `close()`: send `shutdown` → `exit`, then `kill('SIGTERM')` after a 2-second grace.

### New: `src/indexer/lsp-mapper.ts`

Pure mapping functions, no I/O. Easy to unit-test with hand-written fixtures.

```ts
export function mapDocumentSymbols(lspSymbols: DocumentSymbol[]): ParsedSymbol[];
```

Maps Pyright's `DocumentSymbol` tree to the flat `ParsedSymbol[]` shape PindeX already uses. Nested `Class.method` symbols are emitted as individual `kind: 'method'` entries with startLine / endLine from LSP ranges. Signature strings are derived from the symbol name + kind (pyright does not expose full signatures via `documentSymbol`; richer signatures are a future upgrade via hover).

```ts
export function extractImports(content: string): ParsedImport[];
```

Thin wrapper that calls the existing `parsePython` import-extraction path. Pyright's `documentSymbol` response does not contain import info; we keep the regex import extractor for now. Acceptable because imports are syntactically simple in Python (`import X` / `from Y import Z`) and regex is reliable enough; accuracy improvement would require a separate LSP call (`workspace/symbol` or parsing the AST ourselves).

### Modified: `src/indexer/index.ts`

- `IndexerOptions` gets:
  ```ts
  lspEnabled?: boolean;   // default: process.env.PINDEX_LSP !== 'false'
  ```
- New private field: `private lsp: LspPythonClient | null;`
- Constructor initialises `this.lsp` (not-yet-started) when `lspEnabled` is true.
- `processParsedFile` inserts an LSP enhancement step between the hash check and the summariser call. `start()` is fired-and-forgotten on the first Python file so the worker-returned regex result still flows into the DB within milliseconds; files processed before pyright finishes warming up keep their regex symbols, later files get upgraded:
  ```ts
  if (parsed.language === 'python' && this.lsp) {
    if (this.lsp.state === 'idle') {
      // Kick off startup lazily. Do NOT await — first Python file proceeds
      // with the regex result while pyright warms up in the background.
      this.lsp.start().catch((err) => {
        process.stderr.write(`[pindex] LSP start failed: ${String(err)}\n`);
      });
    }
    if (this.lsp.ready) {
      const upgraded = await this.lsp.getDocumentSymbols(relativePath, content);
      if (upgraded) {
        parsed.symbols = upgraded.symbols;
        parsed.imports = upgraded.imports;
      }
    }
  }
  ```
- `closePool()` also awaits `this.lsp?.close()`.

### Modified: `package.json`

```json
"optionalDependencies": {
  "pyright": "^1.1.380"
}
```

Pyright ships its own `pyright-langserver` bin, which ends up in `node_modules/.bin/pyright-langserver`. `LspPythonClient.start` looks there first, then on `PATH`, then logs once and gives up.

### Unchanged (explicitly)

- `src/indexer/parser.ts` — stays synchronous. Python regex path remains as the fallback that always runs in workers.
- `src/indexer/parse-pool.ts` — workers never know about LSP. All Python files get regex-parsed inside the worker; the LSP upgrade happens on the main thread afterwards.
- Summariser, AST diff, DB queries — untouched. LSP replaces `parsed.symbols` and `parsed.imports` before they reach any of these.

## Data Flow

### Happy path (pyright installed and healthy)

1. User starts `pindex-server`. `Indexer` constructs; `lsp = new LspPythonClient({ enabled: true, projectRoot: … })`. No subprocess yet.
2. `indexAll` dispatches `main.py` to `ParsePool`. Worker regex-parses into `parsed = { language: 'python', symbols: [regex], imports: [regex] }`. Result arrives on main thread.
3. `processParsedFile` sees `language === 'python'`. `this.lsp.state === 'idle'` → fires `this.lsp.start()` **without awaiting**. Pyright spawns in the background; `initialize` handshake takes ~2–5 s. State transitions `idle → starting`.
4. Because `this.lsp.ready === false` (still starting), the main thread does NOT call `getDocumentSymbols`. `parsed` keeps its regex symbols, DB transaction runs with them. Elapsed per-file time: milliseconds, not seconds.
5. `indexAll` continues with subsequent files. After ~2–5 s, pyright signals ready; `state = 'ready'`. From that point on, every new Python file in this `indexAll` call hits `getDocumentSymbols`.
6. For each subsequent Python file: `didOpen` + `documentSymbol` + `didClose` round-trips in ~20–100 ms. `lsp-mapper` converts LSP `DocumentSymbol[]` into PindeX `ParsedSymbol[]`. Imports come from `parsePython` regex (Pyright's `documentSymbol` doesn't expose import structure). `parsed.symbols` + `parsed.imports` are overwritten before the DB transaction.
7. Net effect on a 100-file Python project: the first ~3–5 files land in the DB with regex symbols; the remaining ~95 files land with LSP symbols. On the watcher path, a single-file reindex right after startup uses regex; any subsequent reindex uses LSP.

### Fallback A — pyright not installed

1. `lsp.start()` searches `node_modules/.bin/pyright-langserver` → missing; searches `PATH` → missing.
2. One-time stderr warning:
   `[pindex] LSP: pyright-langserver not found on PATH or in node_modules; falling back to regex parsing. Install with "npm install pyright" or set PINDEX_LSP=false to silence this.`
3. `state = 'failed'`. `ready === false`. `getDocumentSymbols` returns `null`.
4. `processParsedFile` sees `null`, leaves `parsed` untouched. Regex result flows into the DB. No error, no retry per file.

### Fallback B — pyright crashes mid-run

1. Subprocess exits with a non-zero code while `ready === true`.
2. `LspPythonClient` sees the `exit` event, sets `state = 'failed'`, logs on stderr.
3. Single restart attempt: `start()` again. If that subprocess also exits non-zero, `state = 'failed'` sticks for the Indexer's lifetime.
4. All remaining Python files fall back to regex via the same null-return path.
5. At end of `indexAll`, summary log: `[pindex] LSP: N files parsed via regex fallback after pyright crash`.

### Fallback C — LSP request timeout

1. `getDocumentSymbols` awaits with a per-request timeout (5 s default). If no response arrives, the promise resolves with `null`.
2. The file that timed out gets the regex result.
3. After 3 consecutive timeouts, `state = 'failed'` is set and the restart policy in Fallback B kicks in. Intent: stop wasting 5 s per file on a wedged server.

### Shutdown

- `Indexer.closePool()` awaits `this.lsp?.close()`. Client sends LSP `shutdown`, then `exit`, then `SIGTERM` after a 2 s grace.
- `src/index.ts` `cleanup()` already awaits `indexer.closePool()` for SIGTERM / SIGINT — no change required there.

## Testing

### Unit (`npm test`)

- `tests/indexer/lsp-mapper.test.ts` — hand-written `DocumentSymbol[]` fixtures covering: flat functions, nested Class.method, variables, decorators reflected as separate symbols, empty responses. Pure input→output assertions.
- `tests/indexer/lsp-python.test.ts` — tests `LspPythonClient` against a **fake subprocess**. The fake implements `initialize` / `documentSymbol` / `shutdown` with scripted responses plus a "crash" mode that exits mid-request. Verifies: ready-state transitions, restart-once policy, timeout handling, close idempotency, queue serialisation.

### Integration (`npm run test:integration`)

- `tests/integration/lsp-python-live.test.ts` — spawns the real `pyright-langserver` against a Python fixture (`tests/fixtures/sample.py`) that contains a class with methods, decorators, type annotations, nested functions, and intentional string literals that would fool a regex parser (e.g. `"class Foo"` inside a docstring). Asserts: all true symbols present, no false positives from string literals, precise line ranges.
- Skippable with `test.skipIf` when `pyright-langserver` is not resolvable, so minimal CI environments still pass.

### Regression

- `tests/indexer/indexer.test.ts` — one new test: same `.py` fixture indexed twice — once with `lspEnabled: false` (regex baseline), once with `lspEnabled: true` but a fake `LspPythonClient` injected that returns a known LSP-style result. Asserts the LSP result lands in the DB when enabled, regex result when not.

### Not tested (explicitly)

- Full Python language-feature coverage via pyright — that is pyright's problem; we only verify our LSP wiring.
- Performance comparisons — out of scope for MVP; a benchmark extension can come later when we have Go / Rust and want cross-language numbers.

## Error Handling Summary

| Failure | Behaviour |
|---|---|
| pyright not installed | `state = 'failed'`, one stderr warning, null returns, regex results used for every Python file. |
| pyright crashes once | One restart attempt. On success, continue normally. |
| pyright crashes twice | `state = 'failed'` for Indexer lifetime, regex fallback for all remaining Python files, summary log at end of `indexAll`. |
| Request timeout | Resolve with `null` after 5 s; after 3 consecutive timeouts, treat as crash and apply the restart policy. |
| Invalid LSP response (malformed JSON, schema mismatch) | Log on stderr, return `null`, fall back to regex. |
| `close()` during active request | Active requests settle or reject; subprocess terminated. |
| `getDocumentSymbols` called after `close()` | Returns `null` immediately (state === 'closed'). |
| Python file processed while pyright is still starting | `state !== 'ready'` path skips LSP; regex result is used. Transparent. |

## Open Risks

- **Pyright subprocess memory**: Pyright with a big workspace can use 500 MB+. For very large monorepos this could surprise users. Mitigation: `LspPythonClient` gets an optional `maxMemoryMb` config knob (default unset) in a follow-up if reports come in. Not in MVP.
- **`vscode-jsonrpc` version churn**: The library is stable but Node 25+ compatibility is not advertised. If issues arise, the fallback is a thin hand-written JSON-RPC loop — not trivial but tractable. Verify during Task 2 before committing to the dependency.
- **`pyright-langserver` startup latency**: 2–5 s is typical; on slow machines up to 10 s. If that is unacceptable, a future optimisation is to batch Python files and wait for ready before processing any. Out of MVP scope.
- **Worker / main thread coordination**: processParsedFile is already async on the main thread, so adding an awaited LSP call does not break any existing concurrency invariants. Still worth one review pass during Task 3 integration.

## Rollback Plan

If the LSP pipeline misbehaves in production, setting `PINDEX_LSP=false` disables it entirely and the code runs identically to today's 1.3.0 release. No DB migrations, no feature-gate cleanup, no rebuild required.
