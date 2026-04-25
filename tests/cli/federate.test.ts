import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { federateAdd, federateRemove, federateList } from '../../src/cli/federate.js';

describe('pindex federate CLI', () => {
  let homeDir: string;
  let projectDir: string;
  let targetDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'pindex-fed-cli-'));
    process.env.HOME = homeDir;

    projectDir = join(homeDir, 'project');
    targetDir = join(homeDir, 'target');
    mkdirSync(join(projectDir, '.pindex'), { recursive: true });
    mkdirSync(join(targetDir, '.pindex'), { recursive: true });
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
});
