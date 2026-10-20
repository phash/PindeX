import { describe, it, expect } from 'vitest';
import { rankHubs, detectCommunities, summarizeCommunities } from '../../src/graph/communities.js';
import type { CallEdge, SymbolNode } from '../../src/graph/call-graph.js';

const node = (id: number, name: string, file: string): SymbolNode => ({ id, name, kind: 'function', file, line: 1 });
const edge = (fromFile: string, to: SymbolNode, line = 1): CallEdge => ({
  from: null, fromFile, to, line, confidence: 'EXTRACTED',
});

describe('rankHubs', () => {
  it('ranks by distinct caller files, not call count', () => {
    const wide = node(1, 'wide', 'src/w.ts');
    const deep = node(2, 'deep', 'src/d.ts');
    const edges = [
      edge('a.ts', wide), edge('b.ts', wide), edge('c.ts', wide),
      ...[1, 2, 3, 4, 5].map((l) => edge('a.ts', deep, l)),
    ];
    const hubs = rankHubs(edges, 10);
    expect(hubs.map((h) => h.symbol)).toEqual(['wide', 'deep']);
    expect(hubs[0]).toEqual({ symbol: 'wide', file: 'src/w.ts', callerFiles: 3 });
  });

  it('breaks ties by symbol name asc and honours the limit', () => {
    const edges = [edge('a.ts', node(1, 'zeta', 'z.ts')), edge('a.ts', node(2, 'alpha', 'y.ts'))];
    expect(rankHubs(edges, 10).map((h) => h.symbol)).toEqual(['alpha', 'zeta']);
    expect(rankHubs(edges, 1)).toHaveLength(1);
  });
});

describe('detectCommunities', () => {
  const files = ['a', 'b', 'c', 'x', 'y', 'z'];
  const edges: Array<[string, string, number]> = [
    ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
    ['x', 'y', 1], ['y', 'z', 1], ['x', 'z', 1],
    ['c', 'x', 1],
  ];

  it('finds two communities for two triangles joined by a weak edge', () => {
    const m = detectCommunities(files, edges);
    expect(new Set(m.values()).size).toBe(2);
    expect(m.get('a')).toBe(m.get('b'));
    expect(m.get('b')).toBe(m.get('c'));
    expect(m.get('x')).toBe(m.get('y'));
    expect(m.get('y')).toBe(m.get('z'));
    expect(m.get('a')).not.toBe(m.get('x'));
  });

  it('is deterministic regardless of input order', () => {
    const a = detectCommunities(files, edges);
    const b = detectCommunities([...files].reverse(), [...edges].reverse());
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect([...detectCommunities(files, edges).entries()]).toEqual([...a.entries()]);
  });

  it('drops isolated files', () => {
    const m = detectCommunities(['a', 'b', 'lonely'], [['a', 'b', 1]]);
    expect(m.has('lonely')).toBe(false);
    expect(m.size).toBe(2);
  });
});

describe('summarizeCommunities', () => {
  it('labels by longest common directory prefix', () => {
    const assignment = new Map([['src/db/a.ts', 0], ['src/db/b.ts', 0]]);
    const degree = new Map([['src/db/a.ts', 2], ['src/db/b.ts', 1]]);
    expect(summarizeCommunities(assignment, degree, 8)).toEqual([
      { id: 0, label: 'src/db', size: 2, topFiles: ['src/db/a.ts', 'src/db/b.ts'] },
    ]);
  });

  it('falls back to top file basename when there is no common directory', () => {
    const assignment = new Map([['src/a.ts', 0], ['lib/b.ts', 0]]);
    const degree = new Map([['src/a.ts', 1], ['lib/b.ts', 5]]);
    expect(summarizeCommunities(assignment, degree, 8)[0].label).toBe('b.ts');
  });

  it('caps communities, sorts by size desc, and caps topFiles at 3', () => {
    const assignment = new Map<string, number>();
    const degree = new Map<string, number>();
    for (let i = 0; i < 5; i++) { assignment.set(`d/big${i}.ts`, 0); degree.set(`d/big${i}.ts`, i); }
    assignment.set('e/s1.ts', 1); assignment.set('e/s2.ts', 1);
    const out = summarizeCommunities(assignment, degree, 1);
    expect(out).toHaveLength(1);
    expect(out[0].size).toBe(5);
    expect(out[0].topFiles).toEqual(['d/big4.ts', 'd/big3.ts', 'd/big2.ts']);
  });
});
