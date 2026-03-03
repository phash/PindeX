import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Summarizer } from '../../src/indexer/summarizer.js';

describe('Summarizer', () => {
  // ─── Original tests (disabled mode) ───────────────────────────────────────

  it('returns null when disabled', async () => {
    const summarizer = new Summarizer({ enabled: false });
    const result = await summarizer.summarizeSymbol('function foo(): void', 'function foo() {}');
    expect(result).toBeNull();
  });

  it('returns null for file when disabled', async () => {
    const summarizer = new Summarizer({ enabled: false });
    const result = await summarizer.summarizeFile('src/app.ts', 'export function main() {}');
    expect(result).toBeNull();
  });

  it('defaults to disabled', async () => {
    const summarizer = new Summarizer();
    const result = await summarizer.summarizeSymbol('foo(): void', 'function foo() {}');
    expect(result).toBeNull();
  });

  // ─── Enabled but no API key ─────────────────────────────────────────────

  it('returns null when enabled but no API key is set', async () => {
    const summarizer = new Summarizer({ enabled: true });
    const result = await summarizer.summarizeSymbol('function foo(): void', 'function foo() {}');
    expect(result).toBeNull();
  });

  it('returns null for file when enabled but no API key is set', async () => {
    const summarizer = new Summarizer({ enabled: true, apiKey: '' });
    const result = await summarizer.summarizeFile('src/app.ts', 'export function main() {}');
    expect(result).toBeNull();
  });

  // ─── Enabled with API key (mocked fetch) ────────────────────────────────

  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function mockFetchSuccess(content: string) {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
      }),
    } as Response);
  }

  function mockFetchError(status: number, statusText: string) {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status,
      statusText,
    } as Response);
  }

  function mockFetchNetworkError() {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
  }

  it('calls API with correct URL, headers, and body for symbol summary', async () => {
    mockFetchSuccess('A utility function that greets users.');

    const summarizer = new Summarizer({
      enabled: true,
      apiKey: 'test-key-123',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
    });

    const result = await summarizer.summarizeSymbol(
      'function greet(name: string): string',
      'function greet(name: string): string { return `Hello, ${name}`; }',
    );

    expect(result).toBe('A utility function that greets users.');
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key-123',
    });

    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('test-model');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('function greet(name: string): string');
    expect(body.max_tokens).toBe(150);
    expect(body.temperature).toBe(0.3);
  });

  it('calls API with correct body for file summary', async () => {
    mockFetchSuccess('Entry point that initializes the application.');

    const summarizer = new Summarizer({
      enabled: true,
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });

    const result = await summarizer.summarizeFile(
      'src/index.ts',
      'import express from "express";\nexport function main() { app.listen(3000); }',
    );

    expect(result).toBe('Entry point that initializes the application.');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.messages[1].content).toContain('src/index.ts');
    expect(body.messages[1].content).toContain('import express');
  });

  it('returns summary string on successful response', async () => {
    mockFetchSuccess('  Parses TypeScript AST and extracts symbols.  ');

    const summarizer = new Summarizer({
      enabled: true,
      apiKey: 'key',
    });

    const result = await summarizer.summarizeSymbol('parseFile()', 'function parseFile() {}');
    // The result should be trimmed
    expect(result).toBe('Parses TypeScript AST and extracts symbols.');
  });

  it('returns null and logs warning on API error (non-200)', async () => {
    mockFetchError(429, 'Too Many Requests');

    const summarizer = new Summarizer({
      enabled: true,
      apiKey: 'key',
    });

    const result = await summarizer.summarizeSymbol('foo()', 'function foo() {}');

    expect(result).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Summarizer API error: 429 Too Many Requests'),
    );
  });

  it('returns null and logs warning on network error', async () => {
    mockFetchNetworkError();

    const summarizer = new Summarizer({
      enabled: true,
      apiKey: 'key',
    });

    const result = await summarizer.summarizeFile('src/app.ts', 'code');

    expect(result).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Summarizer request failed: Error: Network error'),
    );
  });

  it('returns null when response has no choices', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    } as unknown as Response);

    const summarizer = new Summarizer({ enabled: true, apiKey: 'key' });
    const result = await summarizer.summarizeSymbol('foo()', 'function foo() {}');
    expect(result).toBeNull();
  });

  it('strips trailing slash from baseUrl', async () => {
    mockFetchSuccess('summary');

    const summarizer = new Summarizer({
      enabled: true,
      apiKey: 'key',
      baseUrl: 'https://localhost:11434/v1/',
    });

    await summarizer.summarizeSymbol('fn()', 'function fn() {}');

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://localhost:11434/v1/chat/completions');
  });

  it('uses default baseUrl and model when not specified', async () => {
    mockFetchSuccess('summary');

    const summarizer = new Summarizer({
      enabled: true,
      apiKey: 'key',
    });

    await summarizer.summarizeSymbol('fn()', 'function fn() {}');

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('gpt-4o-mini');
  });

  // ─── Concurrency limiter ────────────────────────────────────────────────

  it('limits concurrent requests via semaphore', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      concurrentCount++;
      if (concurrentCount > maxConcurrent) maxConcurrent = concurrentCount;
      // Simulate some async work
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrentCount--;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'summary' } }],
        }),
      } as Response;
    });

    const summarizer = new Summarizer({
      enabled: true,
      apiKey: 'key',
      maxConcurrency: 2,
    });

    // Fire 5 requests in parallel
    const promises = Array.from({ length: 5 }, (_, i) =>
      summarizer.summarizeSymbol(`fn${i}()`, `function fn${i}() {}`),
    );

    const results = await Promise.all(promises);

    // All should succeed
    expect(results).toEqual(Array(5).fill('summary'));
    // Max concurrent should be limited to 2
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    // All 5 calls should have been made
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('truncates large file content to ~4000 chars', async () => {
    mockFetchSuccess('A very large file summary.');

    const summarizer = new Summarizer({
      enabled: true,
      apiKey: 'key',
    });

    const largeContent = 'x'.repeat(5000);
    await summarizer.summarizeFile('big.ts', largeContent);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const userContent = body.messages[1].content as string;
    // Should contain truncation marker
    expect(userContent).toContain('... (truncated)');
    // Should not contain the full 5000 chars
    expect(userContent.length).toBeLessThan(5000);
  });
});
