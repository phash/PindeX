import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { federateAdd, federateRemove, federateList } from '../../src/cli/federate.js';

// getPindexHome() resolves the registry via os.homedir(). Mock node:os so the
// suite can point ~/.pindex at a temp dir cross-platform — Windows os.homedir()
// ignores process.env.HOME (it uses USERPROFILE). tmpdir() stays real via the
// actual spread. Mirrors tests/cli/project-detector.test.ts.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

describe('pindex federate CLI', () => {
  let homeDir: string;
  let projectDir: string;
  let targetDir: string;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'pindex-fed-cli-'));
    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(homeDir);

    projectDir = join(homeDir, 'project');
    targetDir = join(homeDir, 'target');
    mkdirSync(join(projectDir, '.pindex'), { recursive: true });
    mkdirSync(join(targetDir, '.pindex'), { recursive: true });
    // findProjectRoot() walks up for a root marker; give projectDir one so it
    // resolves to projectDir deterministically instead of climbing to a marker
    // in a real ancestor dir (e.g. the user's home on Windows).
    writeFileSync(join(projectDir, 'package.json'), '{}');
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { pindex: { env: {} } } }),
    );
    writeFileSync(
      join(targetDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { pindex: { env: {} } } }),
    );
    mkdirSync(join(homeDir, '.pindex'), { recursive: true });
    writeFileSync(
      join(homeDir, '.pindex', 'registry.json'),
      JSON.stringify({
        version: 1,
        projects: [
          { hash: 'a', path: projectDir, monitoringPort: 7842, name: 'project', federatedRepos: [] },
          { hash: 'b', path: targetDir, monitoringPort: 7843, name: 'target', federatedRepos: [] },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('add appends path to FEDERATION_REPOS and updates registry', async () => {
    await federateAdd(projectDir, targetDir, {});
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { pindex: { env: { FEDERATION_REPOS?: string } } };
    };
    expect(mcp.mcpServers.pindex.env.FEDERATION_REPOS).toContain(targetDir);

    const reg = JSON.parse(readFileSync(join(homeDir, '.pindex', 'registry.json'), 'utf-8')) as {
      projects: Array<{ path: string; federatedRepos?: Array<{ path: string; name: string }> }>;
    };
    const me = reg.projects.find((p) => p.path === projectDir)!;
    expect(me.federatedRepos).toHaveLength(1);
    expect(me.federatedRepos![0]!.name).toBe('target');
  });

  it('add throws when target is not registered', async () => {
    await expect(federateAdd(projectDir, '/nowhere', {})).rejects.toThrow();
  });

  it('list returns federated entries', async () => {
    await federateAdd(projectDir, targetDir, {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await federateList(projectDir);
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('target');
    expect(output).toContain(targetDir);
    log.mockRestore();
  });

  it('remove drops the entry', async () => {
    await federateAdd(projectDir, targetDir, {});
    await federateRemove(projectDir, 'target');
    const reg = JSON.parse(readFileSync(join(homeDir, '.pindex', 'registry.json'), 'utf-8')) as {
      projects: Array<{ path: string; federatedRepos?: unknown[] }>;
    };
    const me = reg.projects.find((p) => p.path === projectDir)!;
    expect(me.federatedRepos ?? []).toHaveLength(0);
  });

  it('remove throws on unknown name', async () => {
    await expect(federateRemove(projectDir, 'nope')).rejects.toThrow(/No federated repo named/);
  });

  it('add is idempotent (already federated)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await federateAdd(projectDir, targetDir, {});
    await federateAdd(projectDir, targetDir, {});
    const reg = JSON.parse(readFileSync(join(homeDir, '.pindex', 'registry.json'), 'utf-8')) as {
      projects: Array<{ path: string; federatedRepos?: unknown[] }>;
    };
    const me = reg.projects.find((p) => p.path === projectDir)!;
    expect(me.federatedRepos ?? []).toHaveLength(1);
    log.mockRestore();
  });

  it('list shows (none) when no federated repos', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await federateList(projectDir);
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('none');
    log.mockRestore();
  });

  it('add throws when the target path does not exist on disk', async () => {
    await expect(
      federateAdd(projectDir, join(homeDir, 'does-not-exist'), {}),
    ).rejects.toThrow(/Target path does not exist/);
  });

  it('add throws when the current project is not registered', async () => {
    const unregistered = join(homeDir, 'unregistered');
    mkdirSync(unregistered, { recursive: true });
    await expect(federateAdd(unregistered, targetDir, {})).rejects.toThrow(
      /Current project not registered/,
    );
  });

  it('add throws when the target has no .mcp.json', async () => {
    rmSync(join(targetDir, '.mcp.json'), { force: true });
    await expect(federateAdd(projectDir, targetDir, {})).rejects.toThrow(
      /Target has no \.mcp\.json/,
    );
  });

  it('add uses an explicit --name when provided', async () => {
    await federateAdd(projectDir, targetDir, { name: 'aliasedTarget' });
    const reg = JSON.parse(readFileSync(join(homeDir, '.pindex', 'registry.json'), 'utf-8')) as {
      projects: Array<{ path: string; federatedRepos?: Array<{ path: string; name: string }> }>;
    };
    const me = reg.projects.find((p) => p.path === projectDir)!;
    expect(me.federatedRepos![0]!.name).toBe('aliasedTarget');
  });

  it('add throws when the requested --name is already in use in the federation', async () => {
    // 'project' is my own name, which is in the `used` set.
    await expect(
      federateAdd(projectDir, targetDir, { name: 'project' }),
    ).rejects.toThrow(/already in use in this federation/);
  });

  it('add auto-assigns a unique name when the target name collides with mine', async () => {
    // Register a second target whose name equals my own ('project') to force the
    // collision -> assignName() branch.
    const collidingTarget = join(homeDir, 'colliding');
    mkdirSync(collidingTarget, { recursive: true });
    writeFileSync(
      join(collidingTarget, '.mcp.json'),
      JSON.stringify({ mcpServers: { pindex: { env: {} } } }),
    );
    writeFileSync(
      join(homeDir, '.pindex', 'registry.json'),
      JSON.stringify({
        version: 1,
        projects: [
          { hash: 'a', path: projectDir, monitoringPort: 7842, name: 'project', federatedRepos: [] },
          { hash: 'c', path: collidingTarget, monitoringPort: 7844, name: 'project', federatedRepos: [] },
        ],
      }),
    );

    await federateAdd(projectDir, collidingTarget, {});
    const reg = JSON.parse(readFileSync(join(homeDir, '.pindex', 'registry.json'), 'utf-8')) as {
      projects: Array<{ path: string; name: string; federatedRepos?: Array<{ path: string; name: string }> }>;
    };
    const me = reg.projects.find((p) => p.path === projectDir)!;
    // Name must NOT collide with my own name.
    expect(me.federatedRepos![0]!.name).not.toBe('project');
  });

  it('add does not duplicate an existing FEDERATION_REPOS entry written by hand', async () => {
    // Pre-seed FEDERATION_REPOS with the targetRoot so the `!list.includes` branch
    // takes the false path (no push).
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { pindex: { env: { FEDERATION_REPOS: targetDir } } } }),
    );

    await federateAdd(projectDir, targetDir, {});
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { pindex: { env: { FEDERATION_REPOS?: string } } };
    };
    // Should still contain it exactly once.
    const occurrences = (mcp.mcpServers.pindex.env.FEDERATION_REPOS ?? '')
      .split(delimiter)
      .filter((p) => p === targetDir).length;
    expect(occurrences).toBe(1);
  });

  it('remove keeps remaining FEDERATION_REPOS entries when more than one is federated', async () => {
    // Add a second federated target so removing one leaves a non-empty list.
    const secondTarget = join(homeDir, 'target2');
    mkdirSync(secondTarget, { recursive: true });
    writeFileSync(
      join(secondTarget, '.mcp.json'),
      JSON.stringify({ mcpServers: { pindex: { env: {} } } }),
    );
    writeFileSync(
      join(homeDir, '.pindex', 'registry.json'),
      JSON.stringify({
        version: 1,
        projects: [
          { hash: 'a', path: projectDir, monitoringPort: 7842, name: 'project', federatedRepos: [] },
          { hash: 'b', path: targetDir, monitoringPort: 7843, name: 'target', federatedRepos: [] },
          { hash: 'd', path: secondTarget, monitoringPort: 7845, name: 'target2', federatedRepos: [] },
        ],
      }),
    );

    await federateAdd(projectDir, targetDir, {});
    await federateAdd(projectDir, secondTarget, {});
    await federateRemove(projectDir, 'target');

    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { pindex: { env: { FEDERATION_REPOS?: string } } };
    };
    // target removed, secondTarget retained -> FEDERATION_REPOS still set.
    expect(mcp.mcpServers.pindex.env.FEDERATION_REPOS).toBe(secondTarget);
  });

  it('remove deletes FEDERATION_REPOS entirely when the last entry is removed', async () => {
    await federateAdd(projectDir, targetDir, {});
    await federateRemove(projectDir, 'target');

    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { pindex: { env: { FEDERATION_REPOS?: string } } };
    };
    expect(mcp.mcpServers.pindex.env.FEDERATION_REPOS).toBeUndefined();
  });

  it('remove matches by path as well as by name', async () => {
    await federateAdd(projectDir, targetDir, {});
    await federateRemove(projectDir, targetDir); // match by path, not name
    const reg = JSON.parse(readFileSync(join(homeDir, '.pindex', 'registry.json'), 'utf-8')) as {
      projects: Array<{ path: string; federatedRepos?: unknown[] }>;
    };
    const me = reg.projects.find((p) => p.path === projectDir)!;
    expect(me.federatedRepos ?? []).toHaveLength(0);
  });

  it('remove throws when the current project is not registered', async () => {
    const unregistered = join(homeDir, 'unregistered-rm');
    mkdirSync(unregistered, { recursive: true });
    await expect(federateRemove(unregistered, 'target')).rejects.toThrow(
      /Current project not registered/,
    );
  });

  it('list reports not-registered for an unknown project (no throw)', async () => {
    const unregistered = join(homeDir, 'unregistered-list');
    mkdirSync(unregistered, { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await federateList(unregistered);
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Current project not registered');
    log.mockRestore();
  });

  it('add throws when the target exists on disk but is not in the registry', async () => {
    const onDiskButUnregistered = join(homeDir, 'on-disk-only');
    mkdirSync(onDiskButUnregistered, { recursive: true });
    writeFileSync(
      join(onDiskButUnregistered, '.mcp.json'),
      JSON.stringify({ mcpServers: { pindex: { env: {} } } }),
    );
    await expect(federateAdd(projectDir, onDiskButUnregistered, {})).rejects.toThrow(
      /Target not registered/,
    );
  });

  it('add throws when the current project has no .mcp.json (readMcpJson guard)', async () => {
    // Remove the project's own .mcp.json so readMcpJson() throws AFTER all the
    // registry/target validation has passed.
    rmSync(join(projectDir, '.mcp.json'), { force: true });
    await expect(federateAdd(projectDir, targetDir, {})).rejects.toThrow(
      /\.mcp\.json not found/,
    );
  });

  it('add seeds the pindex env block when .mcp.json has no pindex server config', async () => {
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    await federateAdd(projectDir, targetDir, {});
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { pindex: { env: { FEDERATION_REPOS?: string } } };
    };
    expect(mcp.mcpServers.pindex.env.FEDERATION_REPOS).toContain(targetDir);
  });

  it('add seeds the env object when the pindex config has no env key', async () => {
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { pindex: {} } }),
    );
    await federateAdd(projectDir, targetDir, {});
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { pindex: { env: { FEDERATION_REPOS?: string } } };
    };
    expect(mcp.mcpServers.pindex.env.FEDERATION_REPOS).toContain(targetDir);
  });
});
