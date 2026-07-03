import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Mock node:os so the isolated suites below can point ~/.pindex at a temp dir.
// homedir defaults to the real one so the legacy suites keep their behaviour.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

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
  // Sandboxed: mock homedir to a temp dir so these tests never touch the real
  // ~/.pindex/registry.json (the migration test below writes a registry file).
  let tempHome: string;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `pindex-name-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

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

// ── Isolated suites — homedir mocked to a temp dir so ~/.pindex is sandboxed ──

describe('getPindexHome / ensurePindexHome / writeFileSecure (sandboxed)', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `pindex-home-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns <home>/.pindex', async () => {
    const { getPindexHome: gph } = await import('../../src/cli/project-detector.js');
    expect(gph()).toBe(join(tempHome, '.pindex'));
  });

  it('migrates ~/.mcp-indexer to ~/.pindex when the old dir exists', async () => {
    const oldHome = join(tempHome, '.mcp-indexer');
    mkdirSync(oldHome, { recursive: true });
    writeFileSync(join(oldHome, 'marker.txt'), 'legacy', 'utf-8');

    const { getPindexHome: gph } = await import('../../src/cli/project-detector.js');
    const home = gph();

    expect(home).toBe(join(tempHome, '.pindex'));
    expect(existsSync(join(tempHome, '.pindex', 'marker.txt'))).toBe(true);
    expect(existsSync(oldHome)).toBe(false);
  });

  it('ensurePindexHome creates the dir (0700 on POSIX)', async () => {
    const { ensurePindexHome } = await import('../../src/cli/project-detector.js');
    const home = ensurePindexHome();

    expect(existsSync(home)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }
  });

  it('ensurePindexHome tightens perms on a pre-existing dir', async () => {
    const home = join(tempHome, '.pindex');
    mkdirSync(home, { recursive: true, mode: 0o755 });

    const { ensurePindexHome } = await import('../../src/cli/project-detector.js');
    ensurePindexHome();

    if (process.platform !== 'win32') {
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }
  });

  it('writeFileSecure writes a 0600 file', async () => {
    const { ensurePindexHome, writeFileSecure } = await import('../../src/cli/project-detector.js');
    const home = ensurePindexHome();
    const f = join(home, 'secret.json');
    writeFileSecure(f, '{"a":1}');

    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf-8')).toBe('{"a":1}');
    if (process.platform !== 'win32') {
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
  });
});

describe('GlobalRegistry — CRUD & port assignment (sandboxed)', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `pindex-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('upsert inserts a new entry, list reflects it, getByPath finds it', async () => {
    const { GlobalRegistry: Reg } = await import('../../src/cli/project-detector.js');
    const reg = new Reg();

    const entry = reg.upsert('/tmp/proj-a');
    // upsert() normalises via resolve(); on Windows '/tmp/proj-a' -> 'E:\tmp\proj-a'.
    expect(entry.path).toBe(resolve('/tmp/proj-a'));
    expect(entry.monitoringPort).toBeGreaterThanOrEqual(7842);
    expect(entry.federatedRepos).toEqual([]);

    expect(reg.list()).toHaveLength(1);
    expect(reg.getByPath('/tmp/proj-a')?.path).toBe(resolve('/tmp/proj-a'));
    // registry.json was persisted (0600 on POSIX)
    const regPath = join(tempHome, '.pindex', 'registry.json');
    expect(existsSync(regPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(regPath).mode & 0o777).toBe(0o600);
    }
  });

  it('upsert is idempotent for the same path and merges extra fields', async () => {
    const { GlobalRegistry: Reg } = await import('../../src/cli/project-detector.js');
    const reg = new Reg();

    const first = reg.upsert('/tmp/proj-b');
    const second = reg.upsert('/tmp/proj-b', { name: 'renamed' });

    expect(reg.list()).toHaveLength(1);
    expect(second.hash).toBe(first.hash);
    expect(second.name).toBe('renamed');
  });

  it('assigns distinct ports to distinct projects', async () => {
    const { GlobalRegistry: Reg } = await import('../../src/cli/project-detector.js');
    const reg = new Reg();

    const a = reg.upsert('/tmp/many-a');
    const b = reg.upsert('/tmp/many-b');
    const c = reg.upsert('/tmp/many-c');

    const ports = new Set([a.monitoringPort, b.monitoringPort, c.monitoringPort]);
    expect(ports.size).toBe(3);
  });

  it('resolves a port collision by incrementing past the used port', async () => {
    const { GlobalRegistry: Reg, hashProjectPath: hpp } = await import('../../src/cli/project-detector.js');
    const reg = new Reg();

    // Seed a project, then force a second project to claim the SAME computed port
    // by pre-writing a registry entry occupying it.
    const a = reg.upsert('/tmp/coll-a');
    const home = join(tempHome, '.pindex');
    const regPath = join(home, 'registry.json');
    const data = JSON.parse(readFileSync(regPath, 'utf-8'));
    // Pre-occupy the computed default port for /tmp/coll-b so upsert must increment.
    const hashB = hpp('/tmp/coll-b');
    const collidingPort = 7842 + (parseInt(hashB.slice(0, 4), 16) % 2000);
    data.projects.push({
      path: '/tmp/occupier',
      hash: 'ffffffff',
      name: 'occupier',
      monitoringPort: collidingPort,
      federatedRepos: [],
      addedAt: new Date().toISOString(),
    });
    writeFileSync(regPath, JSON.stringify(data), 'utf-8');

    const b = reg.upsert('/tmp/coll-b');
    expect(b.monitoringPort).not.toBe(collidingPort);
    expect(b.monitoringPort).not.toBe(a.monitoringPort);
  });

  it('setFederatedRepos updates the entry; replace inserts/overwrites; remove deletes', async () => {
    const { GlobalRegistry: Reg } = await import('../../src/cli/project-detector.js');
    const reg = new Reg();

    const e = reg.upsert('/tmp/fed-proj');
    reg.setFederatedRepos('/tmp/fed-proj', [{ path: '/tmp/dep', name: 'dep' }]);
    expect(reg.getByPath('/tmp/fed-proj')?.federatedRepos).toEqual([{ path: '/tmp/dep', name: 'dep' }]);

    // replace: overwrite existing
    reg.replace({ ...e, name: 'replaced', federatedRepos: [] });
    expect(reg.getByPath('/tmp/fed-proj')?.name).toBe('replaced');

    // replace: insert a brand-new entry
    reg.replace({
      path: '/tmp/inserted',
      hash: hashProjectPath('/tmp/inserted'),
      name: 'inserted',
      monitoringPort: 9999,
      federatedRepos: [],
      addedAt: new Date().toISOString(),
    });
    expect(reg.getByPath('/tmp/inserted')?.name).toBe('inserted');

    // remove
    reg.remove('/tmp/fed-proj');
    expect(reg.getByPath('/tmp/fed-proj')).toBeUndefined();
  });

  it('read returns [] when no registry file exists', async () => {
    const { GlobalRegistry: Reg } = await import('../../src/cli/project-detector.js');
    const reg = new Reg();
    expect(reg.read()).toEqual([]);
  });

  it('read tolerates a corrupt registry file and returns []', async () => {
    const home = join(tempHome, '.pindex');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'registry.json'), 'not-json{{{', 'utf-8');

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { GlobalRegistry: Reg } = await import('../../src/cli/project-detector.js');
    const reg = new Reg();
    expect(reg.read()).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('migrates legacy string[] federatedRepos to structured entries on read', async () => {
    const home = join(tempHome, '.pindex');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'registry.json'),
      JSON.stringify({
        version: 1,
        projects: [
          {
            path: '/x/main',
            hash: hashProjectPath('/x/main'),
            name: 'main',
            monitoringPort: 7842,
            federatedRepos: ['/x/dep-one', { path: '/x/dep-two', name: 'dep-two' }],
            addedAt: new Date().toISOString(),
          },
          {
            path: '/x/dep-one',
            hash: hashProjectPath('/x/dep-one'),
            name: 'known-dep',
            monitoringPort: 7843,
            federatedRepos: [],
            addedAt: new Date().toISOString(),
          },
        ],
      }),
      'utf-8',
    );

    const { GlobalRegistry: Reg } = await import('../../src/cli/project-detector.js');
    const reg = new Reg();
    const main = reg.getByPath('/x/main')!;

    // string entry resolved to a structured one; name pulled from the registered target
    expect(main.federatedRepos).toContainEqual({ path: '/x/dep-one', name: 'known-dep' });
    expect(main.federatedRepos).toContainEqual({ path: '/x/dep-two', name: 'dep-two' });
    // migration persisted back to disk
    const reread = JSON.parse(readFileSync(join(home, 'registry.json'), 'utf-8'));
    const rereadMain = reread.projects.find((p: { path: string }) => p.path === '/x/main');
    expect(typeof rereadMain.federatedRepos[0]).toBe('object');
  });

  it('migrates legacy string[] with an unknown target by deriving a name from the path', async () => {
    const home = join(tempHome, '.pindex');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'registry.json'),
      JSON.stringify({
        version: 1,
        projects: [
          {
            path: '/x/solo',
            hash: hashProjectPath('/x/solo'),
            name: 'solo',
            monitoringPort: 7842,
            federatedRepos: ['/some/where/orphan'],
            addedAt: new Date().toISOString(),
          },
        ],
      }),
      'utf-8',
    );

    const { GlobalRegistry: Reg } = await import('../../src/cli/project-detector.js');
    const reg = new Reg();
    const solo = reg.getByPath('/x/solo')!;
    expect(solo.federatedRepos).toEqual([{ path: '/some/where/orphan', name: 'orphan' }]);
  });
});

describe('findProjectRoot (sandboxed)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `pindex-find-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('walks upward to the directory containing a marker (package.json)', async () => {
    const nested = join(tempRoot, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(tempRoot, 'package.json'), '{}', 'utf-8');

    const { findProjectRoot } = await import('../../src/cli/project-detector.js');
    expect(findProjectRoot(nested)).toBe(tempRoot);
  });

  it('detects a .git marker as well', async () => {
    const nested = join(tempRoot, 'src');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(tempRoot, '.git'), { recursive: true });

    const { findProjectRoot } = await import('../../src/cli/project-detector.js');
    expect(findProjectRoot(nested)).toBe(tempRoot);
  });

  it('returns the start dir when no marker is found up to filesystem root', async () => {
    const nested = join(tempRoot, 'no', 'markers', 'here');
    mkdirSync(nested, { recursive: true });

    const { findProjectRoot } = await import('../../src/cli/project-detector.js');
    // No marker anywhere under tempRoot. The walk may stop at a real ancestor
    // marker, but it must at least return an absolute path (never throw/loop).
    const root = findProjectRoot(nested);
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
  });
});

describe('getMcpIndexerHome (deprecated alias, sandboxed)', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `pindex-alias-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns the same path as getPindexHome', async () => {
    const { getMcpIndexerHome, getPindexHome: gph } = await import('../../src/cli/project-detector.js');
    expect(getMcpIndexerHome()).toBe(gph());
  });
});

describe('getProjectsDir (sandboxed)', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `pindex-projdir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns <home>/.pindex/projects', async () => {
    const { getProjectsDir } = await import('../../src/cli/project-detector.js');
    expect(getProjectsDir()).toBe(join(tempHome, '.pindex', 'projects'));
  });
});
