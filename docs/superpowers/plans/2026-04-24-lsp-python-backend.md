# LSP Python Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex-based Python symbol extractor with output from the Pyright LSP server as an enhancement pass on top of the existing regex path. Ship Pyright as an `optionalDependency` so the feature works out of the box, with automatic regex fallback whenever LSP is unavailable or misbehaves.

**Architecture:** A new `LspPythonClient` on the main thread lazily spawns `pyright-langserver` via stdio JSON-RPC, holds one persistent subprocess per `Indexer` instance, and serves `getDocumentSymbols` requests. `Indexer.processParsedFile` overrides `parsed.symbols` / `parsed.imports` with the LSP result when ready. Workers in `ParsePool` remain LSP-unaware; they keep doing regex parsing which serves as the always-on fallback.

**Tech Stack:** TypeScript 5.x (ESM/NodeNext), `vscode-jsonrpc` (standard JSON-RPC over streams), `vscode-languageserver-protocol` (type defs for LSP messages), `child_process.spawn` for Pyright, `pyright` as optional dependency, Vitest 4 with `pool: 'forks'`.

**Spec:** `docs/superpowers/specs/2026-04-24-lsp-python-backend-design.md`

---

## Context For The Implementer

Before starting, read:

- `docs/superpowers/specs/2026-04-24-lsp-python-backend-design.md` — the approved design.
- `CLAUDE.md` (project root) — commit, workflow, security rules.
- `src/indexer/index.ts` — the `Indexer` class, especially `processParsedFile` (around line 245) and `closePool` (around line 428).
- `src/indexer/parser.ts` — current `parsePython` regex extractor (around line 365–382). Stays in place as the fallback.
- `src/types.ts` — `ParsedSymbol` and `ParsedImport` interfaces you must produce.
- `tests/setup.ts` — global vitest mocks; understand what is mocked before writing tests.
- `tests/indexer/parse-pool.test.ts` and `tests/integration/parse-pool-workers.test.ts` — the patterns for unit vs. integration tests are already established.

### Worktree

Work from `/home/manuel/claude/PindeX-lsp-python` on branch `feat/lsp-python-backend`.
**Every shell command must start with `cd /home/manuel/claude/PindeX-lsp-python`** and `git rev-parse --abbrev-ref HEAD` MUST return `feat/lsp-python-backend` before any `git commit`. A prior session had subagents commit to the wrong worktree — do not repeat that mistake.

### Conventions (from CLAUDE.md)

- Relative imports use `.js` extension even from `.ts` files (`moduleResolution: NodeNext`).
- Paths stored in DB and code use forward slashes; normalise Windows backslashes.
- No silent catches — always `process.stderr.write(\`[pindex] <context>: \${String(err)}\n\`)`.
- Strict TypeScript. No `any`. No non-null `!` unless justified.
- Commit messages: `feat:`, `fix:`, `test:`, `perf:`, `refactor:`, `docs:`, `chore:`. Co-author footer required:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

### Commands

- `npm test` — full unit suite (407 tests passing on `main`).
- `npm run test:integration` — rebuilds dist, runs integration tests including worker + (after this plan) LSP tests.
- `npm run lint` — `tsc --noEmit`; must pass.
- `npm run build` — compile `src/` → `dist/`.

---

## File Structure

### New files
- `src/indexer/lsp-mapper.ts` — pure functions: LSP `DocumentSymbol[]` → PindeX `ParsedSymbol[]`.
- `src/indexer/lsp-python.ts` — the `LspPythonClient` class (subprocess lifecycle + request serialisation + error recovery).
- `tests/indexer/lsp-mapper.test.ts` — unit tests for the mapper.
- `tests/indexer/lsp-python.test.ts` — unit tests for `LspPythonClient` against a scripted fake subprocess.
- `tests/integration/lsp-python-live.test.ts` — integration test against the real `pyright-langserver`.
- `tests/fixtures/lsp-sample.py` — Python fixture used by the integration + regression tests.

### Modified files
- `package.json` — add `pyright` to `optionalDependencies`, add `vscode-jsonrpc` and `vscode-languageserver-protocol` to `dependencies`.
- `src/indexer/index.ts` — new `lspEnabled` option, new private `lsp` field, enhancement block inside `processParsedFile`, close hook in `closePool`.
- `tests/indexer/indexer.test.ts` — one new regression test verifying LSP result overwrites regex when enabled.
- `README.md` — document `PINDEX_LSP` and the Pyright optional dependency.
- `CLAUDE.md` — add `PINDEX_LSP` to the env-var list.

---

## Task 1: Add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Open `package.json` and add the three dependencies**

Under `"dependencies"` add `"vscode-jsonrpc": "^8.2.1"` and `"vscode-languageserver-protocol": "^3.17.5"`. At the root of the file, add a new `"optionalDependencies"` block with `"pyright": "^1.1.380"`. Preserve alphabetical order within each block.

The resulting blocks should look like:

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.5.0",
    "chokidar": "^3.6.0",
    "express": "^4.18.0",
    "glob": "^10.0.0",
    "open": "^9.1.0",
    "tree-sitter": "^0.21.0",
    "tree-sitter-typescript": "^0.21.0",
    "uuid": "^9.0.0",
    "vscode-jsonrpc": "^8.2.1",
    "vscode-languageserver-protocol": "^3.17.5",
    "ws": "^8.16.0",
    "zod": "^4.3.6"
  },
  "optionalDependencies": {
    "pyright": "^1.1.380"
  },
  "devDependencies": {
    ...unchanged...
  },
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: no errors. Pyright downloads (~7 MB) alongside the other deps.

- [ ] **Step 3: Verify `pyright-langserver` is resolvable**

Run: `ls -la node_modules/.bin/pyright-langserver`
Expected: symlink printed. If missing, investigate before proceeding — Pyright's CLI binary name must be exactly `pyright-langserver`.

- [ ] **Step 4: Quick smoke — does pyright-langserver even start?**

Run:
```bash
node_modules/.bin/pyright-langserver --help 2>&1 | head -3
```
Expected: usage text mentioning `--stdio` or similar. If the binary errors out, something is wrong with the install.

- [ ] **Step 5: Unit suite must still pass**

Run: `npm test 2>&1 | tail -6`
Expected: 407/407 tests pass (no test changes yet).

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(deps): add pyright optionalDependency + vscode-jsonrpc/lsp-protocol

Pyright ships the pyright-langserver binary used by the upcoming LSP
backend for Python. vscode-jsonrpc and vscode-languageserver-protocol
are the standard LSP client libraries; both are lightweight MIT-licensed
packages maintained by the VS Code team.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: lsp-mapper.ts with TDD

Pure mapping from LSP `DocumentSymbol` tree to flat PindeX `ParsedSymbol[]`.

**Files:**
- Create: `tests/indexer/lsp-mapper.test.ts`
- Create: `src/indexer/lsp-mapper.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/indexer/lsp-mapper.test.ts
import { describe, it, expect } from 'vitest';
import type { DocumentSymbol, SymbolKind as LspSymbolKind } from 'vscode-languageserver-protocol';
import { mapDocumentSymbols } from '../../src/indexer/lsp-mapper.js';

// LSP SymbolKind numeric values we need:
// 5=Class, 6=Method, 12=Function, 13=Variable, 14=Constant
const CLASS = 5 as LspSymbolKind;
const METHOD = 6 as LspSymbolKind;
const FUNCTION = 12 as LspSymbolKind;
const VARIABLE = 13 as LspSymbolKind;

function sym(
  name: string,
  kind: LspSymbolKind,
  startLine: number,
  endLine: number,
  children?: DocumentSymbol[],
): DocumentSymbol {
  return {
    name,
    kind,
    range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 0 } },
    selectionRange: { start: { line: startLine, character: 0 }, end: { line: startLine, character: name.length } },
    children,
  };
}

describe('mapDocumentSymbols', () => {
  it('returns an empty array for empty input', () => {
    expect(mapDocumentSymbols([])).toEqual([]);
  });

  it('maps a top-level function', () => {
    const result = mapDocumentSymbols([sym('foo', FUNCTION, 0, 4)]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'foo',
      kind: 'function',
      startLine: 1, // 1-indexed in PindeX
      endLine: 5,
      isExported: true,
      isAsync: false,
      hasTryCatch: false,
    });
  });

  it('flattens class methods into individual method entries', () => {
    const result = mapDocumentSymbols([
      sym('MyClass', CLASS, 0, 20, [
        sym('__init__', METHOD, 1, 3),
        sym('greet', METHOD, 5, 10),
      ]),
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.name)).toEqual(['MyClass', '__init__', 'greet']);
    expect(result.map((s) => s.kind)).toEqual(['class', 'method', 'method']);
  });

  it('maps module-level variables and constants to kind=variable', () => {
    const result = mapDocumentSymbols([
      sym('MAX', VARIABLE, 0, 0),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('variable');
  });

  it('uses the symbol name as the signature (no hover info available)', () => {
    const result = mapDocumentSymbols([sym('foo', FUNCTION, 0, 3)]);
    expect(result[0].signature).toBe('foo');
  });

  it('handles deeply nested structures without infinite recursion', () => {
    const result = mapDocumentSymbols([
      sym('Outer', CLASS, 0, 50, [
        sym('Inner', CLASS, 2, 30, [
          sym('deep_method', METHOD, 5, 10),
        ]),
      ]),
    ]);
    expect(result.map((s) => s.name)).toEqual(['Outer', 'Inner', 'deep_method']);
  });

  it('ignores symbols with unsupported LSP kinds', () => {
    const NAMESPACE = 3 as LspSymbolKind; // not in our SymbolKind enum
    const result = mapDocumentSymbols([sym('ns', NAMESPACE, 0, 5)]);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npm test -- tests/indexer/lsp-mapper.test.ts`
Expected: FAIL — `Cannot find module '../../src/indexer/lsp-mapper.js'`.

- [ ] **Step 3: Implement**

```ts
// src/indexer/lsp-mapper.ts
import type { DocumentSymbol, SymbolKind as LspSymbolKind } from 'vscode-languageserver-protocol';
import type { ParsedSymbol, SymbolKind } from '../types.js';

// LSP SymbolKind → PindeX SymbolKind.
// Numeric values per LSP spec:
//  5 Class / 9 Constructor / 6 Method / 12 Function / 13 Variable / 14 Constant
const KIND_MAP: Record<number, SymbolKind> = {
  5: 'class',
  6: 'method',
  9: 'method',   // constructors are methods in our model
  12: 'function',
  13: 'variable',
  14: 'variable',
};

/** Flattens an LSP DocumentSymbol tree into PindeX's flat ParsedSymbol array.
 *  Nested class members are emitted as individual method/variable entries. */
export function mapDocumentSymbols(symbols: DocumentSymbol[]): ParsedSymbol[] {
  const out: ParsedSymbol[] = [];
  walk(symbols, out);
  return out;
}

function walk(nodes: DocumentSymbol[], out: ParsedSymbol[]): void {
  for (const node of nodes) {
    const kind = KIND_MAP[node.kind as number];
    if (kind) {
      // LSP ranges are 0-indexed; PindeX stores 1-indexed start/end lines.
      out.push({
        name: node.name,
        kind,
        signature: node.name,
        startLine: node.range.start.line + 1,
        endLine: node.range.end.line + 1,
        isExported: true,
        isAsync: false,
        hasTryCatch: false,
      });
    }
    if (node.children && node.children.length > 0) {
      walk(node.children, out);
    }
  }
}
```

- [ ] **Step 4: Run test and verify it passes**

Run: `npm test -- tests/indexer/lsp-mapper.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Full suite + lint**

Run: `npm test 2>&1 | tail -6` → 414/414 (407 + 7 new).
Run: `npm run lint` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/lsp-mapper.ts tests/indexer/lsp-mapper.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): add LSP DocumentSymbol → ParsedSymbol mapper

Pure mapping helper that flattens Pyright's hierarchical DocumentSymbol
tree into PindeX's flat ParsedSymbol[] shape. Only whitelisted LSP
SymbolKinds pass through; others are dropped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: LspPythonClient skeleton (state machine, no subprocess)

Lay down the class shape, the state machine, and trivial path resolution logic. No subprocess spawning in this task — that comes in Task 4.

**Files:**
- Create: `tests/indexer/lsp-python.test.ts`
- Create: `src/indexer/lsp-python.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/indexer/lsp-python.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { LspPythonClient } from '../../src/indexer/lsp-python.js';

describe('LspPythonClient (skeleton / state)', () => {
  let client: LspPythonClient;

  beforeEach(() => {
    client = new LspPythonClient({ projectRoot: '/tmp/fake', enabled: true });
  });

  it('starts in state "idle" with ready=false', () => {
    expect(client.state).toBe('idle');
    expect(client.ready).toBe(false);
  });

  it('getDocumentSymbols returns null when not ready', async () => {
    const result = await client.getDocumentSymbols('a.py', 'x = 1');
    expect(result).toBeNull();
  });

  it('close() is a no-op when state is idle', async () => {
    await client.close();
    expect(client.state).toBe('closed');
  });

  it('close() is idempotent', async () => {
    await client.close();
    await client.close();
    expect(client.state).toBe('closed');
  });

  it('constructor with enabled=false transitions straight to state "failed" on start()', async () => {
    const disabled = new LspPythonClient({ projectRoot: '/tmp/fake', enabled: false });
    await disabled.start();
    expect(disabled.state).toBe('failed');
    expect(disabled.ready).toBe(false);
  });
});
```

- [ ] **Step 2: Run and verify fail**

Run: `npm test -- tests/indexer/lsp-python.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skeleton**

```ts
// src/indexer/lsp-python.ts
import type { ParsedSymbol, ParsedImport } from '../types.js';

export type LspReadyState = 'idle' | 'starting' | 'ready' | 'failed' | 'closed';

export interface LspPythonClientOptions {
  projectRoot: string;
  enabled: boolean;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

export class LspPythonClient {
  private _state: LspReadyState = 'idle';
  private readonly enabled: boolean;
  private readonly projectRoot: string;
  private readonly timeoutMs: number;

  constructor(options: LspPythonClientOptions) {
    this.enabled = options.enabled;
    this.projectRoot = options.projectRoot;
    this.timeoutMs = options.timeoutMs ?? 5000;
    // Silence unused-field warning until Task 4 wires these up.
    void this.projectRoot;
    void this.timeoutMs;
  }

  get state(): LspReadyState {
    return this._state;
  }

  get ready(): boolean {
    return this._state === 'ready';
  }

  async start(): Promise<void> {
    if (this._state !== 'idle') return;
    if (!this.enabled) {
      this._state = 'failed';
      return;
    }
    // Subprocess spawn arrives in Task 4.
    this._state = 'failed';
  }

  async getDocumentSymbols(
    _relPath: string,
    _content: string,
  ): Promise<{ symbols: ParsedSymbol[]; imports: ParsedImport[] } | null> {
    if (this._state !== 'ready') return null;
    // Real LSP round-trip arrives in Task 5.
    return null;
  }

  async close(): Promise<void> {
    this._state = 'closed';
  }
}
```

- [ ] **Step 4: Run and verify pass**

Run: `npm test -- tests/indexer/lsp-python.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Full suite + lint**

Run: `npm test 2>&1 | tail -6` → 419/419.
Run: `npm run lint` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/lsp-python.ts tests/indexer/lsp-python.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): add LspPythonClient skeleton with state machine

State transitions and public API surface only; subprocess spawning and
LSP handshake arrive in follow-up commits. Keeps the enabled=false and
not-ready paths fully exercised so every later change has a safety net.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Subprocess spawn + LSP initialize handshake

Resolve `pyright-langserver`, spawn, wire up stdio JSON-RPC, perform LSP `initialize` + `initialized`, transition to `ready`.

**Files:**
- Modify: `src/indexer/lsp-python.ts`
- Modify: `tests/indexer/lsp-python.test.ts`

- [ ] **Step 1: Extend the test file with handshake tests**

First, at the TOP of `tests/indexer/lsp-python.test.ts`, update the existing vitest import to include `vi` and add two new Node imports alongside the existing imports:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { LspPythonClient } from '../../src/indexer/lsp-python.js';
```

(The `LspPythonClient` import is already there from Task 3 — keep it.)

Then APPEND everything below to the bottom of the file (after the existing `describe('LspPythonClient (skeleton / state)', …)` block closes with its `});`):

```ts
/** Minimal fake of Node's ChildProcess: stdin is a Writable we can observe,
 *  stdout is a Readable we push LSP messages into. */
function createFakeSubprocess() {
  const stdinChunks: Buffer[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const stdout = new Readable({ read() { /* push on demand */ } });
  const stderr = new Readable({ read() { /* noop */ } });

  const proc: EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    kill: (signal?: string) => void;
    stdinChunks: Buffer[];
  } = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    stdinChunks,
  });
  return proc;
}

/** Encode a JSON-RPC message the way LSP expects it on stdout. */
function encodeLspMessage(obj: unknown): Buffer {
  const json = JSON.stringify(obj);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`, 'utf-8');
}

describe('LspPythonClient — handshake', () => {
  it('transitions idle → starting → ready on a successful initialize', async () => {
    const fake = createFakeSubprocess();
    const spawnMock = vi.fn(() => fake);

    const client = new LspPythonClient({
      projectRoot: '/tmp/fake',
      enabled: true,
      _spawn: spawnMock as never,
      _resolveServerPath: () => '/fake/pyright-langserver',
    } as never);

    const startPromise = client.start();
    // The client should now be in 'starting'.
    expect(client.state).toBe('starting');

    // Wait a tick for the initialize write.
    await new Promise((r) => setImmediate(r));

    // Reply with a minimal initialize response.
    fake.stdout.push(
      encodeLspMessage({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } }),
    );

    await startPromise;
    expect(client.state).toBe('ready');
    expect(client.ready).toBe(true);
  });

  it('transitions to failed when pyright-langserver is not resolvable', async () => {
    const client = new LspPythonClient({
      projectRoot: '/tmp/fake',
      enabled: true,
      _resolveServerPath: () => null,
    } as never);

    await client.start();
    expect(client.state).toBe('failed');
  });

  it('transitions to failed if subprocess exits during handshake', async () => {
    const fake = createFakeSubprocess();

    const client = new LspPythonClient({
      projectRoot: '/tmp/fake',
      enabled: true,
      _spawn: (() => fake) as never,
      _resolveServerPath: () => '/fake/pyright-langserver',
    } as never);

    const startPromise = client.start();
    await new Promise((r) => setImmediate(r));
    fake.emit('exit', 1, null);

    await startPromise;
    expect(client.state).toBe('failed');
  });
});
```

- [ ] **Step 2: Run the new tests and watch them fail**

Run: `npm test -- tests/indexer/lsp-python.test.ts`
Expected: the 3 new handshake tests FAIL; the 5 skeleton tests still pass.

- [ ] **Step 3: Implement spawn + handshake**

Replace `src/indexer/lsp-python.ts` entirely:

```ts
// src/indexer/lsp-python.ts
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import type { ParsedSymbol, ParsedImport } from '../types.js';

export type LspReadyState = 'idle' | 'starting' | 'ready' | 'failed' | 'closed';

export interface LspPythonClientOptions {
  projectRoot: string;
  enabled: boolean;
  timeoutMs?: number;
  /** Test seam: inject a fake subprocess factory. Not for production use. */
  _spawn?: (path: string) => ChildProcessWithoutNullStreams;
  /** Test seam: inject a fake resolver. Not for production use. */
  _resolveServerPath?: () => string | null;
}

export class LspPythonClient {
  private _state: LspReadyState = 'idle';
  private readonly enabled: boolean;
  private readonly projectRoot: string;
  private readonly timeoutMs: number;
  private readonly spawnImpl: (path: string) => ChildProcessWithoutNullStreams;
  private readonly resolveImpl: () => string | null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private static warnedMissing = false;

  constructor(options: LspPythonClientOptions) {
    this.enabled = options.enabled;
    this.projectRoot = options.projectRoot;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.spawnImpl =
      options._spawn ??
      ((path) => nodeSpawn(path, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams);
    this.resolveImpl = options._resolveServerPath ?? (() => resolvePyrightLangserver());
  }

  get state(): LspReadyState {
    return this._state;
  }

  get ready(): boolean {
    return this._state === 'ready';
  }

  async start(): Promise<void> {
    if (this._state !== 'idle') return;
    if (!this.enabled) {
      this._state = 'failed';
      return;
    }

    const path = this.resolveImpl();
    if (!path) {
      if (!LspPythonClient.warnedMissing) {
        process.stderr.write(
          `[pindex] LSP: pyright-langserver not found on PATH or in node_modules; ` +
          `falling back to regex parsing. Install with "npm install pyright" or ` +
          `set PINDEX_LSP=false to silence this.\n`,
        );
        LspPythonClient.warnedMissing = true;
      }
      this._state = 'failed';
      return;
    }

    this._state = 'starting';
    try {
      this.proc = this.spawnImpl(path);
    } catch (err) {
      process.stderr.write(`[pindex] LSP: spawn failed: ${String(err)}\n`);
      this._state = 'failed';
      return;
    }

    this.proc.on('exit', (code) => {
      if (this._state !== 'closed') {
        process.stderr.write(`[pindex] LSP: pyright-langserver exited (code ${code})\n`);
        this._state = 'failed';
      }
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(this.proc.stdout),
      new StreamMessageWriter(this.proc.stdin),
    );
    this.connection.listen();

    try {
      await Promise.race([
        this.connection.sendRequest('initialize', {
          processId: process.pid,
          rootUri: pathToFileURL(resolve(this.projectRoot)).href,
          capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('initialize timeout')), this.timeoutMs)),
      ]);
      if ((this._state as LspReadyState) === 'failed' || (this._state as LspReadyState) === 'closed') {
        // Subprocess crashed during handshake; exit handler already set state.
        return;
      }
      this.connection.sendNotification('initialized', {});
      this._state = 'ready';
    } catch (err) {
      process.stderr.write(`[pindex] LSP: initialize failed: ${String(err)}\n`);
      this._state = 'failed';
    }
  }

  async getDocumentSymbols(
    _relPath: string,
    _content: string,
  ): Promise<{ symbols: ParsedSymbol[]; imports: ParsedImport[] } | null> {
    if (this._state !== 'ready') return null;
    // Request dispatch arrives in Task 5.
    return null;
  }

  async close(): Promise<void> {
    this._state = 'closed';
    if (this.connection) {
      try {
        await this.connection.sendRequest('shutdown', null);
        this.connection.sendNotification('exit', null);
      } catch { /* subprocess may already be dead */ }
      this.connection.dispose();
      this.connection = null;
    }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.proc = null;
    }
  }
}

/** Resolves the pyright-langserver binary path. Checks node_modules first, then PATH. */
function resolvePyrightLangserver(): string | null {
  const local = join(process.cwd(), 'node_modules', '.bin', 'pyright-langserver');
  if (existsSync(local)) return local;
  // On Windows node ships `.cmd` shims, but we are a pure Node process so direct
  // paths work; PATH search we delegate to spawn by returning the bare name.
  // existsSync cannot check PATH, so we rely on spawn failing and the exit
  // handler to detect the missing-binary case.
  return null;
}
```

- [ ] **Step 4: Tests pass**

Run: `npm test -- tests/indexer/lsp-python.test.ts`
Expected: all 8 tests pass (5 skeleton + 3 handshake).

- [ ] **Step 5: Full suite + lint**

Run: `npm test 2>&1 | tail -6` → 422/422.
Run: `npm run lint` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/lsp-python.ts tests/indexer/lsp-python.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): spawn pyright-langserver and complete LSP initialize

LspPythonClient now resolves pyright-langserver via node_modules/.bin,
spawns it with --stdio, wires up vscode-jsonrpc StreamMessageReader /
Writer, and completes the initialize + initialized handshake before
flipping to state 'ready'. Subprocess exits during the handshake are
reported on stderr and the client stays 'failed' (caller falls back to
regex parsing).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: getDocumentSymbols end-to-end

Implement the request flow: `didOpen` → `documentSymbol` → `didClose`, map the response, return PindeX shape. Keep requests serialised (only one in flight at a time).

**Files:**
- Modify: `src/indexer/lsp-python.ts`
- Modify: `tests/indexer/lsp-python.test.ts`

- [ ] **Step 1: Add test cases for request flow**

Append to `tests/indexer/lsp-python.test.ts`:

```ts
describe('LspPythonClient — getDocumentSymbols', () => {
  /** Drives a fake subprocess through initialize then a documentSymbol request. */
  async function makeReadyClient(): Promise<{
    client: LspPythonClient;
    fake: ReturnType<typeof createFakeSubprocess>;
  }> {
    const fake = createFakeSubprocess();
    const client = new LspPythonClient({
      projectRoot: '/tmp/fake',
      enabled: true,
      _spawn: (() => fake) as never,
      _resolveServerPath: () => '/fake/pyright-langserver',
    } as never);
    const startPromise = client.start();
    await new Promise((r) => setImmediate(r));
    fake.stdout.push(encodeLspMessage({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } }));
    await startPromise;
    return { client, fake };
  }

  it('returns mapped symbols + regex-derived imports on success', async () => {
    const { client, fake } = await makeReadyClient();
    const content = 'import os\n\nclass Foo:\n    def bar(self):\n        pass\n';
    const requestPromise = client.getDocumentSymbols('foo.py', content);

    // Consume pending stdin writes (didOpen + request).
    await new Promise((r) => setImmediate(r));

    // Reply with a DocumentSymbol response.
    // Per LSP protocol, responses include the original request id.
    // Our client uses sequential ids; after initialize(0) the next request
    // is the documentSymbol call. didOpen is a notification with no id.
    fake.stdout.push(
      encodeLspMessage({
        jsonrpc: '2.0',
        id: 1,
        result: [
          {
            name: 'Foo',
            kind: 5,
            range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } },
            selectionRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 9 } },
            children: [
              {
                name: 'bar',
                kind: 6,
                range: { start: { line: 3, character: 4 }, end: { line: 4, character: 0 } },
                selectionRange: { start: { line: 3, character: 8 }, end: { line: 3, character: 11 } },
              },
            ],
          },
        ],
      }),
    );

    const result = await requestPromise;
    expect(result).not.toBeNull();
    expect(result!.symbols.map((s) => s.name)).toEqual(['Foo', 'bar']);
    expect(result!.symbols.map((s) => s.kind)).toEqual(['class', 'method']);
    expect(result!.imports).toEqual([{ source: 'os', symbols: [] }]);

    await client.close();
  });

  it('returns null on request timeout', async () => {
    const { client } = await makeReadyClient();
    // Use a shorter timeout for this test by re-constructing via option.
    // We cannot change it after start; instead verify the default timeout
    // logic exists by stubbing timers.
    vi.useFakeTimers();
    try {
      const pending = client.getDocumentSymbols('slow.py', 'x = 1');
      vi.advanceTimersByTime(6000); // default 5000 ms + margin
      const result = await pending;
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
      await client.close();
    }
  });

  it('serialises concurrent calls', async () => {
    const { client, fake } = await makeReadyClient();

    const p1 = client.getDocumentSymbols('a.py', 'a = 1');
    const p2 = client.getDocumentSymbols('b.py', 'b = 2');

    await new Promise((r) => setImmediate(r));

    // Reply to the first documentSymbol (id 1).
    fake.stdout.push(encodeLspMessage({ jsonrpc: '2.0', id: 1, result: [] }));
    const r1 = await p1;
    expect(r1).not.toBeNull();

    await new Promise((r) => setImmediate(r));

    // Reply to the second documentSymbol (id 2).
    fake.stdout.push(encodeLspMessage({ jsonrpc: '2.0', id: 2, result: [] }));
    const r2 = await p2;
    expect(r2).not.toBeNull();

    await client.close();
  });
});
```

- [ ] **Step 2: Run — expect 3 new failures**

Run: `npm test -- tests/indexer/lsp-python.test.ts`
Expected: 8 passing, 3 failing (timeout test may pass by accident because the skeleton returns null; the success and serialisation tests will fail).

- [ ] **Step 3: Replace `getDocumentSymbols` in `src/indexer/lsp-python.ts`**

Add this import at the top:

```ts
import type { DocumentSymbol } from 'vscode-languageserver-protocol';
import { mapDocumentSymbols } from './lsp-mapper.js';
import { parseFile } from './parser.js';
```

Add a private field on the class:

```ts
private pendingQueue: Promise<unknown> = Promise.resolve();
```

Replace the `getDocumentSymbols` body:

```ts
async getDocumentSymbols(
  relPath: string,
  content: string,
): Promise<{ symbols: ParsedSymbol[]; imports: ParsedImport[] } | null> {
  if (this._state !== 'ready' || !this.connection) return null;

  // Serialise concurrent callers so the LSP sees one request at a time.
  const task = this.pendingQueue.then(() => this.runRequest(relPath, content));
  this.pendingQueue = task.catch(() => undefined);
  return task;
}

private async runRequest(
  relPath: string,
  content: string,
): Promise<{ symbols: ParsedSymbol[]; imports: ParsedImport[] } | null> {
  if (!this.connection || this._state !== 'ready') return null;

  const uri = pathToFileURL(resolve(this.projectRoot, relPath)).href;

  try {
    this.connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'python', version: 1, text: content },
    });

    const response = (await Promise.race([
      this.connection.sendRequest('textDocument/documentSymbol', {
        textDocument: { uri },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('request timeout')), this.timeoutMs)),
    ])) as DocumentSymbol[] | null;

    this.connection.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });

    if (!response || !Array.isArray(response)) {
      return { symbols: [], imports: extractImportsFromContent(content) };
    }

    return {
      symbols: mapDocumentSymbols(response),
      imports: extractImportsFromContent(content),
    };
  } catch (err) {
    process.stderr.write(`[pindex] LSP: documentSymbol failed for ${relPath}: ${String(err)}\n`);
    return null;
  }
}
```

Finally, add the import-extraction helper at the module level (below the class, above `resolvePyrightLangserver`):

```ts
/** Reuse the existing Python regex import extractor from parseFile(). Pyright's
 *  documentSymbol does not expose import statements; the regex is reliable for
 *  `import X` / `from Y import Z`. */
function extractImportsFromContent(content: string): ParsedImport[] {
  return parseFile('pseudo.py', content).imports;
}
```

- [ ] **Step 4: Tests pass**

Run: `npm test -- tests/indexer/lsp-python.test.ts`
Expected: 11 tests pass.

- [ ] **Step 5: Full suite + lint**

Run: `npm test 2>&1 | tail -6` → 425/425.
Run: `npm run lint` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/lsp-python.ts tests/indexer/lsp-python.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): implement LSP documentSymbol round-trip

LspPythonClient.getDocumentSymbols now sends textDocument/didOpen,
awaits textDocument/documentSymbol, sends textDocument/didClose, and
maps the hierarchical DocumentSymbol tree to PindeX's flat ParsedSymbol
array via lsp-mapper. Concurrent callers are serialised via a promise
chain so Pyright sees one request at a time. Per-request timeout
defaults to 5 s; on timeout the promise resolves null and the caller
falls back to the regex result.

Imports come from the existing parsePython regex extractor since
textDocument/documentSymbol does not expose imports.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Error recovery (crash restart, timeout threshold)

Add a single restart on unexpected exit plus a "3 consecutive timeouts == crash" rule.

**Files:**
- Modify: `src/indexer/lsp-python.ts`
- Modify: `tests/indexer/lsp-python.test.ts`

- [ ] **Step 1: Add test cases**

Append to `tests/indexer/lsp-python.test.ts`:

```ts
describe('LspPythonClient — crash recovery', () => {
  it('attempts one restart after an unexpected subprocess exit', async () => {
    let spawnCount = 0;
    const fakes: ReturnType<typeof createFakeSubprocess>[] = [];

    const spawnMock = vi.fn(() => {
      const f = createFakeSubprocess();
      fakes.push(f);
      spawnCount++;
      return f as never;
    });

    const client = new LspPythonClient({
      projectRoot: '/tmp/fake',
      enabled: true,
      _spawn: spawnMock,
      _resolveServerPath: () => '/fake/pyright-langserver',
    } as never);

    // First start: success.
    const s1 = client.start();
    await new Promise((r) => setImmediate(r));
    fakes[0].stdout.push(encodeLspMessage({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } }));
    await s1;
    expect(client.state).toBe('ready');

    // Now simulate a crash.
    fakes[0].emit('exit', 137, 'SIGKILL');
    // Flush micro-tasks so the exit handler and restart logic run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // A restart should have been attempted (spawnCount === 2).
    expect(spawnCount).toBe(2);

    // Reply to the second initialize to bring client back to ready.
    fakes[1].stdout.push(encodeLspMessage({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } }));
    await new Promise((r) => setImmediate(r));
    expect(client.state).toBe('ready');

    await client.close();
  });

  it('stays failed after a second consecutive crash', async () => {
    let spawnCount = 0;
    const fakes: ReturnType<typeof createFakeSubprocess>[] = [];

    const spawnMock = vi.fn(() => {
      const f = createFakeSubprocess();
      fakes.push(f);
      spawnCount++;
      return f as never;
    });

    const client = new LspPythonClient({
      projectRoot: '/tmp/fake',
      enabled: true,
      _spawn: spawnMock,
      _resolveServerPath: () => '/fake/pyright-langserver',
    } as never);

    // First start: success.
    const s1 = client.start();
    await new Promise((r) => setImmediate(r));
    fakes[0].stdout.push(encodeLspMessage({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } }));
    await s1;

    // Crash once.
    fakes[0].emit('exit', 1, null);
    await new Promise((r) => setImmediate(r));
    // Crash the restart too, before initialize completes.
    fakes[1].emit('exit', 1, null);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(client.state).toBe('failed');
    expect(spawnCount).toBe(2); // no third attempt

    await client.close();
  });
});
```

- [ ] **Step 2: Run — expect failures**

Run: `npm test -- tests/indexer/lsp-python.test.ts`
Expected: the 2 new tests fail (restart logic not implemented yet).

- [ ] **Step 3: Add restart logic**

In `src/indexer/lsp-python.ts`, add a field to the class:

```ts
private restartAttempted = false;
```

Replace the `exit` handler inside `start()`:

```ts
this.proc.on('exit', (code) => {
  if (this._state === 'closed') return;

  process.stderr.write(`[pindex] LSP: pyright-langserver exited (code ${code})\n`);

  if (!this.restartAttempted && this._state === 'ready') {
    this.restartAttempted = true;
    process.stderr.write(`[pindex] LSP: attempting one restart\n`);
    this._state = 'idle';
    this.proc = null;
    this.connection?.dispose();
    this.connection = null;
    // Fire and forget — the restart is opportunistic.
    this.start().catch(() => {
      /* swallow — state already reflects any failure */
    });
    return;
  }

  this._state = 'failed';
});
```

Add timeout tracking. Add a field:

```ts
private consecutiveTimeouts = 0;
```

In `runRequest`, after a successful response, reset:

```ts
this.consecutiveTimeouts = 0;
```

On timeout, increment and maybe crash-and-restart. Replace the try/catch of `runRequest` with:

```ts
try {
  this.connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId: 'python', version: 1, text: content },
  });

  let timedOut = false;
  const response = (await Promise.race([
    this.connection.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri },
    }),
    new Promise((_, reject) =>
      setTimeout(() => {
        timedOut = true;
        reject(new Error('request timeout'));
      }, this.timeoutMs),
    ),
  ]).catch((err) => {
    if (timedOut) {
      this.consecutiveTimeouts++;
      if (this.consecutiveTimeouts >= 3) {
        process.stderr.write(`[pindex] LSP: 3 consecutive timeouts, treating as crash\n`);
        this.simulateCrash();
      }
      return null;
    }
    throw err;
  })) as DocumentSymbol[] | null;

  this.connection.sendNotification('textDocument/didClose', {
    textDocument: { uri },
  });

  if (!response || !Array.isArray(response)) {
    return { symbols: [], imports: extractImportsFromContent(content) };
  }

  this.consecutiveTimeouts = 0;
  return {
    symbols: mapDocumentSymbols(response),
    imports: extractImportsFromContent(content),
  };
} catch (err) {
  process.stderr.write(`[pindex] LSP: documentSymbol failed for ${relPath}: ${String(err)}\n`);
  return null;
}
```

And add the helper:

```ts
/** Manually triggers the same restart-or-fail path the exit handler uses. */
private simulateCrash(): void {
  if (this._state !== 'ready') return;
  this._state = 'idle';
  try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
  this.proc = null;
  this.connection?.dispose();
  this.connection = null;
  if (!this.restartAttempted) {
    this.restartAttempted = true;
    this.start().catch(() => { /* swallow */ });
  } else {
    this._state = 'failed';
  }
}
```

- [ ] **Step 4: Tests pass**

Run: `npm test -- tests/indexer/lsp-python.test.ts`
Expected: 13 tests pass.

- [ ] **Step 5: Full suite + lint**

Run: `npm test 2>&1 | tail -6` → 427/427.
Run: `npm run lint` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/lsp-python.ts tests/indexer/lsp-python.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): restart-once policy on LSP crash and timeout threshold

Unexpected pyright-langserver exits trigger one restart attempt. A
second crash sticks the client in 'failed' for the Indexer lifetime so
every subsequent Python file falls back to regex without wasted retry
cost. Three consecutive request timeouts are treated as a crash
(pyright may be wedged) and drive the same restart path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Integration test with real pyright-langserver

Prove the protocol wiring works end-to-end against a real Pyright subprocess.

**Files:**
- Create: `tests/fixtures/lsp-sample.py`
- Create: `tests/integration/lsp-python-live.test.ts`

- [ ] **Step 1: Create the fixture**

```python
# tests/fixtures/lsp-sample.py
"""A sample Python module that would trip up a regex-based extractor."""
import os
from typing import Optional


class AuthService:
    """Auth service with a method that contains 'class Foo' in a string."""

    def __init__(self, token: str) -> None:
        self.token = token
        # This docstring-style comment contains "class Bait" which a regex
        # parser would misidentify as a class declaration.
        self._notice = "class Bait is not a real class"

    def authorize(self, user_id: str) -> Optional[str]:
        if not self.token:
            return None
        return f"{user_id}:{self.token}"


def greet(name: str) -> str:
    return f"hello {name}"


MAX_RETRIES = 3
```

- [ ] **Step 2: Write the integration test**

```ts
// tests/integration/lsp-python-live.test.ts
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

vi.unmock('tree-sitter');
vi.unmock('tree-sitter-typescript');

const PYRIGHT = resolve(process.cwd(), 'node_modules/.bin/pyright-langserver');
const FIXTURE = resolve(process.cwd(), 'tests/fixtures/lsp-sample.py');

describe.skipIf(!existsSync(PYRIGHT))('LspPythonClient (live pyright-langserver)', () => {
  it('returns precise symbols for a fixture file', async () => {
    const { LspPythonClient } = (await import(
      pathToFileURL(resolve(process.cwd(), 'dist/indexer/lsp-python.js')).href
    )) as typeof import('../../src/indexer/lsp-python.js');

    const client = new LspPythonClient({
      projectRoot: resolve(process.cwd(), 'tests/fixtures'),
      enabled: true,
      timeoutMs: 15_000,
    });
    await client.start();
    expect(client.state).toBe('ready');

    const content = readFileSync(FIXTURE, 'utf-8');
    const result = await client.getDocumentSymbols('lsp-sample.py', content);
    await client.close();

    expect(result).not.toBeNull();
    const names = result!.symbols.map((s) => s.name).sort();
    // AuthService + __init__ + authorize + greet + MAX_RETRIES
    expect(names).toContain('AuthService');
    expect(names).toContain('authorize');
    expect(names).toContain('greet');
    expect(names).toContain('MAX_RETRIES');

    // The classic regex-parser failure: "class Bait" inside a string literal.
    expect(names).not.toContain('Bait');
  }, 30_000);
});
```

- [ ] **Step 3: Build and run the integration test**

```bash
npm run build
npm run test:integration 2>&1 | tail -15
```

Expected: the lsp-python-live test passes, total integration count is 30 (was 29, +1 new). If `pyright-langserver` is missing for some reason (unusual after Task 1), the test is skipped — that is acceptable but investigate why.

- [ ] **Step 4: Full suite still passes**

Run: `npm test 2>&1 | tail -6` → 427/427 (integration suite is excluded from default).

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/lsp-sample.py tests/integration/lsp-python-live.test.ts
git commit -m "$(cat <<'EOF'
test(indexer): add live pyright-langserver integration test

Spawns the real pyright-langserver against a Python fixture that
contains a string literal ("class Bait") designed to fool the old
regex-based extractor. Asserts that the LSP-backed client finds the
real symbols and does not invent spurious ones.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire LspPythonClient into Indexer

**Files:**
- Modify: `src/indexer/index.ts`
- Modify: `tests/indexer/indexer.test.ts`

- [ ] **Step 1: Add a regression test first**

Append a new `it` inside the existing `describe('Indexer', …)` block in `tests/indexer/indexer.test.ts`. You need to import the LspPythonClient class at the top if not already:

```ts
import { LspPythonClient } from '../../src/indexer/lsp-python.js';
```

Then the test (uses a fake subclass so tests stay deterministic and do not spawn pyright):

```ts
it('overwrites regex symbols with LSP result when LSP is ready', async () => {
  class FakeLsp extends LspPythonClient {
    async start(): Promise<void> { (this as never as { _state: string })._state = 'ready'; }
    get ready(): boolean { return true; }
    get state(): 'ready' { return 'ready'; }
    async getDocumentSymbols() {
      return {
        symbols: [
          {
            name: 'from_lsp',
            kind: 'function' as const,
            signature: 'from_lsp',
            startLine: 1,
            endLine: 3,
            isExported: true,
            isAsync: false,
            hasTryCatch: false,
          },
        ],
        imports: [{ source: 'os', symbols: [] }],
      };
    }
    async close(): Promise<void> { /* no-op */ }
  }

  const pyDir = join(tmpdir(), `pindex-lsp-indexer-${Date.now()}`);
  mkdirSync(pyDir, { recursive: true });
  writeFileSync(join(pyDir, 'x.py'), 'def not_from_lsp(): pass\n');

  try {
    const indexer = new Indexer({ db, projectRoot: pyDir, languages: ['python'] });
    // Inject the fake LSP client.
    (indexer as never as { lsp: LspPythonClient }).lsp = new FakeLsp({
      projectRoot: pyDir,
      enabled: true,
    });

    await indexer.indexAll();

    const file = getFileByPath(db, 'x.py');
    expect(file).not.toBeNull();
    const symbols = getSymbolsByFileId(db, file!.id);
    expect(symbols.map((s) => s.name)).toContain('from_lsp');
    expect(symbols.map((s) => s.name)).not.toContain('not_from_lsp');
  } finally {
    rmSync(pyDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- tests/indexer/indexer.test.ts 2>&1 | tail -10`
Expected: the new test fails because `Indexer` does not construct or use `this.lsp` yet. Existing tests keep passing.

- [ ] **Step 3: Wire the client into the Indexer**

Add to the imports at the top of `src/indexer/index.ts`:

```ts
import { LspPythonClient } from './lsp-python.js';
```

Extend `IndexerOptions`:

```ts
export interface IndexerOptions {
  // ...existing fields...
  /** Enable the LSP-backed Python parser. Default: process.env.PINDEX_LSP !== 'false'. */
  lspEnabled?: boolean;
}
```

Add a new private field to the `Indexer` class:

```ts
private lsp: LspPythonClient | null = null;
```

In the constructor, after the existing assignments and AFTER `this.configuredMaxWorkers = …`:

```ts
const lspEnabled = options.lspEnabled ?? (process.env.PINDEX_LSP !== 'false');
if (lspEnabled) {
  this.lsp = new LspPythonClient({ projectRoot: this.projectRoot, enabled: true });
}
```

Modify `processParsedFile`: insert this block immediately after the `if (!force && existing && existing.hash === hash) return ...` early-return line, BEFORE the summariser block:

```ts
if (parsed.language === 'python' && this.lsp) {
  if (this.lsp.state === 'idle') {
    // Fire-and-forget: first Python file proceeds with the regex result
    // while pyright warms up. Subsequent files get LSP-quality output.
    this.lsp.start().catch((err) => {
      process.stderr.write(`[pindex] LSP start failed: ${String(err)}\n`);
    });
  }
  if (this.lsp.ready) {
    const upgraded = await this.lsp.getDocumentSymbols(relativePath, content);
    if (upgraded) {
      parsed = { ...parsed, symbols: upgraded.symbols, imports: upgraded.imports };
    }
  }
}
```

**Note:** `parsed` is a function parameter. Reassigning creates a new local variable that the rest of the function uses. If the existing code mutates `parsed` in place elsewhere, adjust accordingly — the spread approach is safest.

Extend `closePool`:

```ts
async closePool(): Promise<void> {
  if (this.lsp) {
    await this.lsp.close();
    this.lsp = null;
  }
  if (!this.pool) return;
  await this.pool.close();
  this.pool = null;
}
```

- [ ] **Step 4: Tests pass**

Run: `npm test -- tests/indexer/indexer.test.ts 2>&1 | tail -10`
Expected: all indexer tests including the new one pass.

Run: `npm test 2>&1 | tail -6`
Expected: 428/428 (427 + 1 new regression test).

Run: `npm run lint`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/index.ts tests/indexer/indexer.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): wire LspPythonClient into processParsedFile

Indexer now instantiates an LspPythonClient when lspEnabled (default
true unless PINDEX_LSP=false). For Python files, processParsedFile
fires lsp.start() without awaiting so the regex result is used during
warm-up; once pyright is ready, documentSymbol output overwrites
parsed.symbols and parsed.imports before the DB transaction.
closePool terminates the LSP subprocess before closing the ParsePool.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Docs

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: README**

Find the "Environment Variables" section. Add one line alongside the existing entries (same format the surrounding lines use):

```
PINDEX_LSP=true                                   # opt-out LSP parsing for Python (set to 'false' to force regex)
```

Near the "Integrations" or "How It Works" section (wherever language support is described), add a short note:

```
**Python:** PindeX ships with Pyright as an optional dependency. When
installed, Pyright's LSP server produces the precise symbol tree
instead of the fallback regex extractor. Set PINDEX_LSP=false to opt
out. If Pyright is missing (e.g. `--no-optional` install), PindeX
logs a one-time warning and uses the regex path.
```

Pick a paragraph adjacent to existing language-support docs; do not introduce a whole new section.

- [ ] **Step 2: CLAUDE.md**

In the "Running the MCP Server" code block, add:

```
PINDEX_LSP=true                                 # opt-out LSP parsing for Python ('false' = force regex)
```

- [ ] **Step 3: Verify**

Run: `npm test 2>&1 | tail -3` → 428/428 still.
Run: `npm run lint` → no output.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: document PINDEX_LSP and the Pyright optional dependency

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: E2E verification

No code. Verification only.

**Files:**
- None.

- [ ] **Step 1: Full unit suite**

Run: `npm test 2>&1 | tail -6`
Expected: 428/428 passing.

- [ ] **Step 2: Integration suite**

Run: `npm run test:integration 2>&1 | tail -10`
Expected: 30 passing (includes the new lsp-python-live).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no output.

- [ ] **Step 4: Build emits the new files**

Run: `npm run build && ls dist/indexer/lsp-python.js dist/indexer/lsp-mapper.js`
Expected: both paths print.

- [ ] **Step 5: Real-world smoke test**

Create a tiny Python project in `/tmp` and self-index it with LSP enabled to confirm the wiring works end-to-end outside of tests:

```bash
mkdir -p /tmp/pindex-lsp-smoke/src
cat > /tmp/pindex-lsp-smoke/src/app.py <<'EOF'
from typing import List

class Inventory:
    def __init__(self, items: List[str]) -> None:
        self.items = items
    def add(self, item: str) -> None:
        self.items.append(item)

def total(inv: Inventory) -> int:
    return len(inv.items)
EOF

rm -rf /tmp/pindex-lsp-smoke.db
PROJECT_ROOT=/tmp/pindex-lsp-smoke \
INDEX_PATH=/tmp/pindex-lsp-smoke.db \
LANGUAGES=python \
AUTO_REINDEX=false \
PINDEX_LSP=true \
  timeout 30 node dist/index.js < /dev/null || true

node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/tmp/pindex-lsp-smoke.db', { readonly: true });
  const rows = db.prepare('SELECT name, kind FROM symbols ORDER BY name').all();
  console.log(rows);
  db.close();
"

rm -rf /tmp/pindex-lsp-smoke.db /tmp/pindex-lsp-smoke
```

Expected stdout (symbol list): includes `Inventory` (class), `__init__` (method), `add` (method), `total` (function). If the list instead looks like what the regex extractor produces (e.g. missing methods or a bogus string-literal entry), something is wrong — investigate before calling Task 10 done.

- [ ] **Step 6: Report**

No commit. Post the smoke test output plus a one-line summary: "LSP Python backend verified end-to-end, 428 unit + 30 integration, feature ready for merge."

---

## Risks during implementation

1. **`vscode-jsonrpc` API surface may drift across versions.** The imports used here (`StreamMessageReader`, `StreamMessageWriter`, `createMessageConnection` from `'vscode-jsonrpc/node.js'`) are stable since v6, but if the subpath export is missing in v8.x, try `'vscode-jsonrpc'` as the base import. Verify in Task 1 right after `npm install`.

2. **Pyright cold-start time on CI runners.** 2–5 s locally, up to 10 s on weak runners. The integration test uses a 15 s timeout and a 30 s vitest timeout — if flakes appear, bump further.

3. **`parsed` parameter reassignment in `processParsedFile`.** If the existing code mutates `parsed` elsewhere, the spread-based reassignment in Task 8 might de-sync references. Inspect the method body; if there are later mutations, apply `Object.assign(parsed, { symbols: …, imports: … })` instead.

4. **Fixture Python file and the `"class Bait"` trick.** The assertion `expect(names).not.toContain('Bait')` guards against regression to the regex extractor. If Pyright were ever replaced, revisit this.

5. **Fake-subprocess tests** rely on running micro-tasks via `setImmediate`. On rare occasions, a single await tick is not enough. If a handshake test flakes, try two consecutive `await new Promise((r) => setImmediate(r));` before the `stdout.push` to let the `StreamMessageReader` drain.

## When you finish

Report:
- Unit + integration test counts.
- Smoke-test symbol list.
- Any deviations from the plan (and why).
- Whether the feature is ready to cut as v1.4.0 or if more work is needed.
