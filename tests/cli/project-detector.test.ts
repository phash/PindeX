import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashProjectPath, getProjectIndexPath, getProjectMetaPath, getPindexHome, GlobalRegistry } from '../../src/cli/project-detector.js';

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

  it('stores the index inside the project .pindex/ directory', () => {
    const path = getProjectIndexPath('/home/user/myproject');
    expect(path).toContain('.pindex');
    expect(path).toContain('myproject');
  });
});

describe('getProjectMetaPath', () => {
  it('returns a path ending with meta.json', () => {
    const path = getProjectMetaPath('/home/user/myproject');
    expect(path.endsWith('meta.json')).toBe(true);
  });
});

describe('GlobalRegistry — name field', () => {
  it('assigns a name on upsert when missing', () => {
    const reg = new GlobalRegistry();
    const entry = reg.upsert('/tmp/some-test-project-' + Date.now());
    expect(entry.name).toBeDefined();
    expect(typeof entry.name).toBe('string');
    expect(entry.name.length).toBeGreaterThan(0);
  });

  it('auto-names entries on read when name is missing (migration)', () => {
    // Write a registry file by hand without name fields.
    const home = getPindexHome();
    mkdirSync(home, { recursive: true });
    const path = join(home, 'registry.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        projects: [
          { hash: 'aaa', path: '/x/foo', port: 7842 },
          { hash: 'bbb', path: '/x/bar', port: 7843 },
        ],
      }),
    );

    const reg = new GlobalRegistry();
    const entries = reg.list();
    expect(entries.every((e) => typeof e.name === 'string' && e.name.length > 0)).toBe(true);

    // The migration should have written back to disk.
    const reread = JSON.parse(readFileSync(path, 'utf-8')) as { projects: Array<{ name?: string }> };
    expect(reread.projects.every((p) => typeof p.name === 'string')).toBe(true);
  });
});
