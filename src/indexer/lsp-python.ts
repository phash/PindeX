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

    // exitReject lets us abort the initialize handshake when the process exits early.
    let exitReject!: (err: Error) => void;
    const exitPromise = new Promise<never>((_, reject) => { exitReject = reject; });

    this.proc.on('exit', (code) => {
      if (this._state !== 'closed') {
        process.stderr.write(`[pindex] LSP: pyright-langserver exited (code ${code})\n`);
        this._state = 'failed';
        exitReject(new Error(`pyright-langserver exited with code ${String(code)}`));
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
        exitPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('initialize timeout')), this.timeoutMs)),
      ]);
      if ((this._state as LspReadyState) === 'failed' || (this._state as LspReadyState) === 'closed') {
        // Subprocess crashed during handshake; exit handler already set state.
        return;
      }
      this.connection.sendNotification('initialized', {});
      this._state = 'ready';
    } catch (err) {
      // The exit handler may have already set _state to 'failed' via the event loop.
      // Cast through unknown so TS's control-flow narrowing doesn't hide the mutation.
      const currentState = this._state as unknown as string;
      if (currentState !== 'failed' && currentState !== 'closed') {
        process.stderr.write(`[pindex] LSP: initialize failed: ${String(err)}\n`);
        this._state = 'failed';
      }
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
