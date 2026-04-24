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
