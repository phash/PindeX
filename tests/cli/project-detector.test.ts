import { describe, it, expect } from 'vitest';
import { hashProjectPath, getProjectIndexPath, getProjectMetaPath } from '../../src/cli/project-detector.js';

describe('hashProjectPath', () => {
  it('returns an 8-character hex string', () => {
    const hash = hashProjectPath('/home/user/project');
    expect(hash).toMatch(/^[a-f0-9]{8}$/);
  });

  it('returns the same hash for the same path', () => {
    const h1 = hashProjectPath('/home/user/project');
    const h2 = hashProjectPath('/home/user/project');
    expect(h1).toBe(h2);
  });

  it('returns different hashes for different paths', () => {
    const h1 = hashProjectPath('/home/user/project-a');
    const h2 = hashProjectPath('/home/user/project-b');
    expect(h1).not.toBe(h2);
  });

  it('is consistent for relative and resolved paths', () => {
    const h1 = hashProjectPath('/home/user/project');
    const h2 = hashProjectPath('/home/user/project/');
    // Both should resolve to the same absolute path (trailing slash stripped by resolve())
    expect(h1).toBe(h2);
  });
});

describe('getProjectIndexPath', () => {
  it('returns a path ending with index.db', () => {
    const path = getProjectIndexPath('/home/user/myproject');
    expect(path.endsWith('index.db')).toBe(true);
  });

  it('includes the project hash in the path', () => {
    const hash = hashProjectPath('/home/user/myproject');
    const path = getProjectIndexPath('/home/user/myproject');
    expect(path).toContain(hash);
  });
});

describe('getProjectMetaPath', () => {
  it('returns a path ending with meta.json', () => {
    const path = getProjectMetaPath('/home/user/myproject');
    expect(path.endsWith('meta.json')).toBe(true);
  });
});
