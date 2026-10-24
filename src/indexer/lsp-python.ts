import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import nodePath, { type PlatformPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import type { DocumentSymbol } from 'vscode-languageserver-protocol';
import type { ParsedSymbol, ParsedImport } from '../types.js';
import { mapDocumentSymbols } from './lsp-mapper.js';
import { parseFile } from './parser.js';

/**
 * LSP parsing is opt-in: only the exact value 'true' enables it. Pyright reads the project's
 * pyrightconfig.json and may run the configured Python interpreter, so it must not start
 * by default on untrusted repositories.
 */
export function isLspEnabledByEnv(value: string | undefined = process.env.PINDEX_LSP): boolean {
  return value === 'true';
}

/** Spawn options for pyright-langserver: cwd outside the project so nothing is resolved relative to it. */
export function pyrightSpawnOptions(): SpawnOptions {
  return { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpdir() };
}

export type LspReadyState = 'idle' | 'starting' | 'ready' | 'failed' | 'closed';

/** Fire-and-forget notification. A write to a dead pipe rejects (EPIPE); the exit/error
 *  handlers own the state transition, so that rejection must not go unhandled. */
function notify(conn: MessageConnection, method: string, params: unknown): void {
  conn.sendNotification(method, params).catch(() => { /* see above */ });
}

/** How to start pyright-langserver without a shell: `command args… --stdio`. */
export interface PyrightLaunch {
  command: string;
  args: string[];
}

export interface LspPythonClientOptions {
  projectRoot: string;
  enabled: boolean;
  timeoutMs?: number;
  /** Test seam: inject a fake subprocess factory. Not for production use. */
  _spawn?: (launch: PyrightLaunch) => ChildProcessWithoutNullStreams;
  /** Test seam: inject a fake resolver. Not for production use. */
  _resolveServerPath?: () => PyrightLaunch | null;
}

export class LspPythonClient {
  private _state: LspReadyState = 'idle';
  private readonly enabled: boolean;
  private readonly projectRoot: string;
  private readonly timeoutMs: number;
  private readonly spawnImpl: (launch: PyrightLaunch) => ChildProcessWithoutNullStreams;
  private readonly resolveImpl: () => PyrightLaunch | null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private static warnedMissing = false;
  private pendingQueue: Promise<unknown> = Promise.resolve();
  private restartAttempted = false;
  private consecutiveTimeouts = 0;

  constructor(options: LspPythonClientOptions) {
    this.enabled = options.enabled;
    this.projectRoot = options.projectRoot;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.spawnImpl =
      options._spawn ??
      ((launch) =>
        nodeSpawn(launch.command, [...launch.args, '--stdio'], pyrightSpawnOptions()) as ChildProcessWithoutNullStreams);
    this.resolveImpl = options._resolveServerPath ?? (() => resolvePyrightLangserver(this.projectRoot));
  }

  /** Test-only: resets module-level warning guard so tests can observe
   *  stderr output repeatedly. NOT for production use. */
  static _resetWarnedMissingForTest(): void {
    LspPythonClient.warnedMissing = false;
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

    const launch = this.resolveImpl();
    if (!launch) {
      if (!LspPythonClient.warnedMissing) {
        process.stderr.write(
          `[pindex] LSP: pyright-langserver not found on PATH or in node_modules; ` +
          `falling back to regex parsing. Install with "npm install pyright" or ` +
          `unset PINDEX_LSP to silence this.\n`,
        );
        LspPythonClient.warnedMissing = true;
      }
      this._state = 'failed';
      return;
    }

    this._state = 'starting';
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = this.spawnImpl(launch);
      this.proc = proc;
    } catch (err) {
      process.stderr.write(`[pindex] LSP: spawn failed: ${String(err)}\n`);
      this._state = 'failed';
      return;
    }

    // exitReject lets us abort the initialize handshake when the process exits early.
    let exitReject!: (err: Error) => void;
    const exitPromise = new Promise<never>((_, reject) => { exitReject = reject; });

    proc.on('exit', (code) => {
      // A replaced/killed process may report its exit late; it must not
      // affect the state of its successor.
      if (this.proc !== proc) return;
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
      exitReject(new Error(`pyright-langserver exited with code ${String(code)}`));
    });

    // Async spawn failures (ENOENT, EACCES) arrive as 'error', often without 'exit'.
    // Unhandled, the event would crash the host process.
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      if (this._state === 'closed') return;
      process.stderr.write(`[pindex] LSP: spawn failed: ${String(err)}\n`);
      this._state = 'failed';
      this.proc = null;
      this.connection?.dispose();
      this.connection = null;
      exitReject(err);
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    this.connection.listen();

    try {
      await Promise.race([
        this.connection.sendRequest('initialize', {
          processId: process.pid,
          rootUri: pathToFileURL(nodePath.resolve(this.projectRoot)).href,
          capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
        }),
        exitPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('initialize timeout')), this.timeoutMs)),
      ]);
      notify(this.connection, 'initialized', {});
      this._state = 'ready';
    } catch (err) {
      // The exit handler may have already set _state to 'failed' via the event loop.
      const currentState = this._state as LspReadyState;
      if (currentState !== 'failed' && currentState !== 'closed') {
        process.stderr.write(`[pindex] LSP: initialize failed: ${String(err)}\n`);
        this._state = 'failed';
      }
    }
  }

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

    const uri = pathToFileURL(nodePath.resolve(this.projectRoot, relPath)).href;

    const connection = this.connection;
    try {
      notify(connection, 'textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version: 1, text: content },
      });

      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let response: DocumentSymbol[] | null;
      try {
        response = (await Promise.race([
          connection.sendRequest('textDocument/documentSymbol', {
            textDocument: { uri },
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error('request timeout'));
            }, this.timeoutMs);
          }),
        ])) as DocumentSymbol[] | null;
      } catch (err) {
        if (timedOut) {
          this.consecutiveTimeouts++;
          if (this.consecutiveTimeouts >= 3) {
            process.stderr.write(`[pindex] LSP: 3 consecutive timeouts, treating as crash\n`);
            this.simulateCrash();
          }
          return null;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        // Always close the document, including on timeout/error, so the
        // server does not accumulate open documents.
        try {
          notify(connection, 'textDocument/didClose', { textDocument: { uri } });
        } catch { /* connection may be disposed by simulateCrash */ }
      }

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
  }

  /** Manually triggers the same restart-or-fail path the exit handler uses.
   *  Used when the subprocess is unresponsive (repeated request timeouts). */
  private simulateCrash(): void {
    if (this._state !== 'ready') return;
    this._state = 'idle';
    try { this.proc?.kill('SIGKILL'); } catch { /* process already dead */ }
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

  async close(): Promise<void> {
    this._state = 'closed';
    if (this.connection) {
      const conn = this.connection;
      this.connection = null;
      try {
        await Promise.race([
          conn.sendRequest('shutdown', null),
          new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 1000)),
        ]);
        // Awaited: the SIGTERM below must not race the pending write (EPIPE).
        await conn.sendNotification('exit', null);
      } catch { /* subprocess may already be dead */ }
      conn.dispose();
    }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.proc = null;
    }
  }
}

export interface PyrightResolveDeps {
  /** Resolves pyright's package.json relative to this module. Throws if absent. */
  resolvePackageJson: () => string;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
  pathEnv: string;
  /** Node binary used to run pyright's JS entry point. */
  execPath: string;
  /** Path flavour (posix/win32); defaults to the host's. Injectable so both are testable anywhere. */
  path?: PlatformPath;
}

const defaultResolveDeps = (): PyrightResolveDeps => ({
  resolvePackageJson: () => createRequire(import.meta.url).resolve('pyright/package.json'),
  readFile: (p) => readFileSync(p, 'utf-8'),
  exists: existsSync,
  realpath: realpathSync,
  pathEnv: process.env.PATH ?? '',
  execPath: process.execPath,
});

/** Resolves how to launch pyright-langserver. Order: PindeX's own pyright
 *  install (independent of cwd) -> absolute PATH entries outside the project.
 *
 *  The bundled package is started as `node <bin entry>` rather than through
 *  node_modules/.bin: on Windows that shim is a shell script (plus a .cmd), and
 *  neither is spawnable without `shell: true`. For the same reason the PATH
 *  lookup on Windows only accepts a real executable (pip's pyright-langserver.exe).
 *
 *  SECURITY: binaries living inside the indexed project (node_modules/.bin,
 *  relative PATH entries such as "." or symlinks into the repo) are never
 *  used. Indexing an untrusted repository must not execute code from it. */
export function resolvePyrightLangserver(
  projectRoot: string,
  deps: PyrightResolveDeps = defaultResolveDeps(),
): PyrightLaunch | null {
  const { resolve, join, dirname, delimiter, isAbsolute, sep } = deps.path ?? nodePath;
  const bin = 'pyright-langserver';
  try {
    const pkgJson = deps.resolvePackageJson();
    const pkgDir = dirname(pkgJson);
    const entry = (JSON.parse(deps.readFile(pkgJson)) as { bin?: Record<string, unknown> }).bin?.[bin];
    if (typeof entry === 'string') {
      const script = resolve(pkgDir, entry);
      // The bin entry must stay inside the pyright package.
      if (script.startsWith(pkgDir + sep) && deps.exists(script)) {
        return { command: deps.execPath, args: [script] };
      }
    }
  } catch { /* package not installed or unreadable */ }

  let rootReal: string;
  try {
    rootReal = deps.realpath(projectRoot);
  } catch {
    rootReal = resolve(projectRoot);
  }
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;

  for (const dir of deps.pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, sep === '\\' ? `${bin}.exe` : bin);
    if (!deps.exists(candidate)) continue;
    let real: string;
    try {
      real = deps.realpath(candidate);
    } catch {
      continue;
    }
    if (real === rootReal || real.startsWith(rootPrefix)) continue;
    return { command: candidate, args: [] };
  }
  return null;
}

/** Reuses the existing Python regex import extractor from parseFile(). Pyright's
 *  documentSymbol does not expose import statements; the regex is reliable
 *  enough for `import X` / `from Y import Z`. */
function extractImportsFromContent(content: string): ParsedImport[] {
  return parseFile('pseudo.py', content).imports;
}
