import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// We need to mock homedir to use a temp directory in tests
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(),
    platform: vi.fn(actual.platform),
  };
});

describe('registerMcpServer', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `mcp-setup-test-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });

    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates claude_code_config.json when it does not exist', async () => {
    mkdirSync(join(tempHome, '.claude'), { recursive: true });
    const { registerMcpServer } = await import('../../src/cli/setup.js');
    registerMcpServer();

    const configPath = join(tempHome, '.claude', 'claude_code_config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers).toHaveProperty('pindex');
  });

  it('merges into existing claude_code_config.json without losing other settings', async () => {
    const claudeDir = join(tempHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const configPath = join(claudeDir, 'claude_code_config.json');
    writeFileSync(configPath, JSON.stringify({ theme: 'dark', mcpServers: { 'other-server': {} } }));

    const { registerMcpServer } = await import('../../src/cli/setup.js');
    registerMcpServer();

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.theme).toBe('dark');
    expect(config.mcpServers).toHaveProperty('other-server');
    expect(config.mcpServers).toHaveProperty('pindex');
  });
});

describe('writeGlobalConfig', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `mcp-config-test-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates config.json in ~/.pindex', async () => {
    const { writeGlobalConfig } = await import('../../src/cli/setup.js');
    writeGlobalConfig();

    const configPath = join(tempHome, '.pindex', 'config.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.version).toBe('1.0.0');
    expect(config.daemon).toHaveProperty('monitoringPort');
  });

  it('does not overwrite existing config', async () => {
    const home = join(tempHome, '.pindex');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 'custom' }));

    const { writeGlobalConfig } = await import('../../src/cli/setup.js');
    writeGlobalConfig();

    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'));
    expect(config.version).toBe('custom'); // unchanged
  });

  it('writes config.json with owner-only (0600) permissions', async () => {
    const { writeGlobalConfig } = await import('../../src/cli/setup.js');
    writeGlobalConfig();

    const configPath = join(tempHome, '.pindex', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    // On POSIX the file must be 0600; skip the bit-check on Windows.
    if (process.platform !== 'win32') {
      const mode = statSync(configPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe('runSetup', () => {
  let tempHome: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `mcp-runsetup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(tempHome);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes config but no systemd unit on linux', async () => {
    const { platform } = await import('node:os');
    vi.mocked(platform).mockReturnValue('linux');

    const { runSetup } = await import('../../src/cli/setup.js');
    const setup = await import('../../src/cli/setup.js');
    await runSetup();

    expect(existsSync(join(tempHome, '.pindex', 'config.json'))).toBe(true);
    expect(existsSync(join(tempHome, '.config', 'systemd', 'user', 'pindex.service'))).toBe(false);
    expect('installSystemdService' in setup).toBe(false);
    expect(logSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
  });
});
