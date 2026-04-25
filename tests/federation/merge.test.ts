import { describe, it, expect } from 'vitest';
import { dedupByKey } from '../../src/federation/merge.js';

describe('dedupByKey', () => {
  it('returns the input unchanged when no duplicates', () => {
    const input = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = dedupByKey(input, (x) => String(x.id));
    expect(result).toEqual(input);
  });

  it('keeps the first occurrence of each key', () => {
    const input = [
      { id: 1, project: 'a' },
      { id: 2, project: 'b' },
      { id: 1, project: 'c' },
    ];
    const result = dedupByKey(input, (x) => String(x.id));
    expect(result).toEqual([
      { id: 1, project: 'a' },
      { id: 2, project: 'b' },
    ]);
  });

  it('handles an empty array', () => {
    expect(dedupByKey<{ id: number }>([], (x) => String(x.id))).toEqual([]);
  });

  it('preserves input order', () => {
    const input = [{ k: 'b' }, { k: 'a' }, { k: 'c' }, { k: 'a' }];
    const result = dedupByKey(input, (x) => x.k);
    expect(result.map((x) => x.k)).toEqual(['b', 'a', 'c']);
  });

  it('uses the keyFn output as the dedup identity, not deep equality', () => {
    const input = [
      { name: 'A', kind: 'class' },
      { name: 'A', kind: 'function' }, // same name, different kind — should NOT dedup
    ];
    const result = dedupByKey(input, (x) => `${x.name}::${x.kind}`);
    expect(result).toHaveLength(2);
  });
});
