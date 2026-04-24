import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
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
  beforeEach(() => {
    LspPythonClient._resetWarnedMissingForTest();
  });

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

  it('transitions to failed when spawn throws synchronously', async () => {
    const client = new LspPythonClient({
      projectRoot: '/tmp/fake',
      enabled: true,
      _spawn: (() => {
        throw new Error('spawn ENOENT');
      }) as never,
      _resolveServerPath: () => '/fake/pyright-langserver',
    } as never);

    await client.start();
    expect(client.state).toBe('failed');
  });

  it('transitions to failed when initialize response never arrives (timeout)', async () => {
    const fake = createFakeSubprocess();
    const client = new LspPythonClient({
      projectRoot: '/tmp/fake',
      enabled: true,
      timeoutMs: 50,
      _spawn: (() => fake) as never,
      _resolveServerPath: () => '/fake/pyright-langserver',
    } as never);

    await client.start();
    // No stdout push → initialize never resolves → timeout fires.
    expect(client.state).toBe('failed');
  });
});

describe('LspPythonClient — getDocumentSymbols', () => {
  beforeEach(() => {
    LspPythonClient._resetWarnedMissingForTest();
  });

  /** Drives a fake subprocess through initialize then makes it ready. */
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

    // Consume pending stdin writes (didOpen notification + documentSymbol request).
    await new Promise((r) => setImmediate(r));

    // Reply with a DocumentSymbol response.
    // initialize used id 0; the next request (documentSymbol) uses id 1.
    // didOpen and didClose are notifications with no id.
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

  it('returns null when request times out', async () => {
    const fake = createFakeSubprocess();
    const client = new LspPythonClient({
      projectRoot: '/tmp/fake',
      enabled: true,
      timeoutMs: 50,
      _spawn: (() => fake) as never,
      _resolveServerPath: () => '/fake/pyright-langserver',
    } as never);
    const startPromise = client.start();
    await new Promise((r) => setImmediate(r));
    fake.stdout.push(encodeLspMessage({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } }));
    await startPromise;

    // Do not push a response for the documentSymbol request — let it time out.
    const result = await client.getDocumentSymbols('slow.py', 'x = 1');
    expect(result).toBeNull();

    await client.close();
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
