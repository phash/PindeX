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
import type { DocumentSymbol } from 'vscode-languageserver-protocol';
import type { ParsedSymbol, ParsedImport } from '../types.js';
import { mapDocumentSymbols } from './lsp-mapper.js';
import { parseFile } from './parser.js';

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
  private pendingQueue: Promise<unknown> = Promise.resolve();
  private restartAttempted = false;
  private consecutiveTimeouts = 0;

  constructor(options: LspPythonClientOptions) {
    this.enabled = options.enabled;
    this.projectRoot = options.projectRoot;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.spawnImpl =
      options._spawn ??
      ((path) => nodeSpawn(path, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams);
    this.resolveImpl = options._resolveServerPath ?? (() => resolvePyrightLangserver());
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
      this.connection.sendNotification('initialized', {});
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

    const uri = pathToFileURL(resolve(this.projectRoot, relPath)).href;

    try {
      this.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version: 1, text: content },
      });

      let timedOut = false;
      let response: DocumentSymbol[] | null;
      try {
        response = (await Promise.race([
          this.connection.sendRequest('textDocument/documentSymbol', {
            textDocument: { uri },
          }),
          new Promise((_, reject) =>
            setTimeout(() => {
              timedOut = true;
              reject(new Error('request timeout'));
            }, this.timeoutMs),
          ),
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
      }

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
        conn.sendNotification('exit', null);
      } catch { /* subprocess may already be dead */ }
      conn.dispose();
    }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.proc = null;
    }
  }
}

/** Resolves the pyright-langserver binary path by checking node_modules/.bin.
 *  Returns null if not found; PATH-based discovery is intentionally not
 *  implemented (would require spawn + stderr capture to detect failure, which
 *  is a larger change and not worth the complexity for the optionalDependency
 *  install path where node_modules is the canonical location). */
function resolvePyrightLangserver(): string | null {
  const local = join(process.cwd(), 'node_modules', '.bin', 'pyright-langserver');
  if (existsSync(local)) return local;
  return null;
}

/** Reuses the existing Python regex import extractor from parseFile(). Pyright's
 *  documentSymbol does not expose import statements; the regex is reliable
 *  enough for `import X` / `from Y import Z`. */
function extractImportsFromContent(content: string): ParsedImport[] {
  return parseFile('pseudo.py', content).imports;
}
