import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';

// Point ~/.pindex at a temp dir cross-platform (Windows os.homedir() ignores HOME).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

import { resolveServerConfig } from '../src/server-config.js';
import { getProjectIndexPath, GlobalRegistry } from '../src/cli/project-detector.js';

describe('resolveServerConfig', () => {
  let home: string;
  let proj: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'pindex-cfg-home-'));
    proj = mkdtempSync(join(tmpdir(), 'pindex-cfg-proj-'));
    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(home);
    writeFileSync(join(proj, 'package.json'), '{}'); // root marker for findProjectRoot
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('explicit env always wins over derived values', async () => {
    const cfg = await resolveServerConfig(
      {
        PROJECT_ROOT: proj,
        INDEX_PATH: '/explicit/index.db',
        MONITORING_PORT: '9999',
        LANGUAGES: 'python, go',
        FEDERATION_REPOS: ['/a', '/b'].join(delimiter),
      } as NodeJS.ProcessEnv,
      proj,
    );
    expect(cfg.indexPath).toBe('/explicit/index.db');
    expect(cfg.monitoringPort).toBe(9999);
    expect(cfg.languages).toEqual(['python', 'go']);
    expect(cfg.federationRepos).toEqual(['/a', '/b']);
  });

  it('derives config, autodetects languages, and self-registers when env is empty', async () => {
    writeFileSync(join(proj, 'main.py'), 'x = 1');

    const cfg = await resolveServerConfig({} as NodeJS.ProcessEnv, proj);

    expect(cfg.projectRoot).toBe(resolve(proj));
    expect(cfg.indexPath).toBe(getProjectIndexPath(proj));
    expect(cfg.languages).toEqual(['python']);
    expect(cfg.monitoringPort).toBeGreaterThanOrEqual(7842);

    // Self-registered so the CLI / aggregated GUI can discover the project.
    expect(new GlobalRegistry().getByPath(proj)?.path).toBe(resolve(proj));
  });
});
