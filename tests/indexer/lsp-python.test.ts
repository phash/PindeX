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
