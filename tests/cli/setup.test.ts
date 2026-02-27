import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// We need to mock homedir to use a temp directory in tests
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(),
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
});
