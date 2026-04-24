import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { resolveWithinRoot } from '../../src/util/paths.js';

describe('resolveWithinRoot', () => {
  const root = resolve('/tmp/pindex-test-root');

  it('returns the absolute path for a normal relative file', () => {
    const result = resolveWithinRoot(root, 'src/file.ts');
    expect(result).toBe(resolve(root, 'src/file.ts'));
  });

  it('returns the root itself when input is empty string', () => {
    const result = resolveWithinRoot(root, '');
    expect(result).toBe(root);
  });

  it('returns the root when input is "."', () => {
    const result = resolveWithinRoot(root, '.');
    expect(result).toBe(root);
  });

  it('rejects simple parent-directory escape', () => {
    expect(resolveWithinRoot(root, '../outside.txt')).toBeNull();
  });

  it('rejects nested parent-directory escape', () => {
    expect(resolveWithinRoot(root, 'src/../../../etc/passwd')).toBeNull();
  });

  it('rejects absolute paths outside the root', () => {
    expect(resolveWithinRoot(root, '/etc/passwd')).toBeNull();
  });

  it('accepts absolute paths that are inside the root', () => {
    const inside = resolve(root, 'sub/file.ts');
    expect(resolveWithinRoot(root, inside)).toBe(inside);
  });

  it('does not treat a sibling directory sharing the prefix as inside', () => {
    // e.g. /tmp/pindex-test-root-evil/ should NOT be treated as inside /tmp/pindex-test-root
    expect(resolveWithinRoot(root, '../pindex-test-root-evil/file.ts')).toBeNull();
  });
});
