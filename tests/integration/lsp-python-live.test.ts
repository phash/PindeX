import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
