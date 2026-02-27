import { describe, it, expect } from 'vitest';
import { Summarizer } from '../../src/indexer/summarizer.js';

describe('Summarizer', () => {
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
});
