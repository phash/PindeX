import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Mock the project-detector module to avoid touching ~/.pindex
vi.mock('../../src/cli/project-detector.js', () => {
  const mockGetProjectIndexPath = vi.fn((p: string) =>
    join(p, '.pindex', 'index.db'),
  );
  const mockFindProjectRoot = vi.fn((dir: string) => dir);

  // Mock GlobalRegistry
  class MockGlobalRegistry {
    private entries: Array<{
      path: string;
      hash: string;
      name: string;
      monitoringPort: number;
      federatedRepos: string[];
      addedAt: string;
    }> = [];

    upsert(projectPath: string) {
      const existing = this.entries.find((e) => e.path === projectPath);
      if (existing) return existing;
      const entry = {
        path: projectPath,
        hash: 'abc12345',
        name: 'test-project',
        monitoringPort: 7843,
        federatedRepos: [] as string[],
        addedAt: new Date().toISOString(),
      };
      this.entries.push(entry);
      return entry;
    }

    list() {
      return this.entries;
    }

    getByPath(projectPath: string) {
      return this.entries.find((e) => e.path === projectPath);
    }

    setFederatedRepos(projectPath: string, repos: string[]) {
      const entry = this.entries.find((e) => e.path === projectPath);
      if (entry) entry.federatedRepos = repos;
    }

    read() {
      return this.entries;
    }
  }

  return {
    getProjectIndexPath: mockGetProjectIndexPath,
    findProjectRoot: mockFindProjectRoot,
    GlobalRegistry: MockGlobalRegistry,
    hashProjectPath: vi.fn(() => 'abc12345'),
  };
});

// Dynamically import after mock setup
const {
  writeMcpJson,
  injectClaudeMdSection,
  injectClaudeSettings,
  injectGitignore,
  removeClaudeMdSection,
  removeClaudeSettings,
  removeMcpJson,
} = await import('../../src/cli/init.js');

describe('writeMcpJson', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pindex-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes valid JSON with correct env vars', () => {
    const entry = {
      path: tempDir,
      hash: 'abc12345',
      name: 'test-project',
      monitoringPort: 7843,
      federatedRepos: [] as string[],
      addedAt: new Date().toISOString(),
    };

    writeMcpJson(tempDir, entry);

    const mcpJsonPath = join(tempDir, '.mcp.json');
    expect(existsSync(mcpJsonPath)).toBe(true);

    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers.pindex).toBeDefined();
    expect(config.mcpServers.pindex.command).toBe('pindex-server');
    expect(config.mcpServers.pindex.env.PROJECT_ROOT).toBe(tempDir);
    expect(config.mcpServers.pindex.env.MONITORING_PORT).toBe('7843');
    expect(config.mcpServers.pindex.env.AUTO_REINDEX).toBe('true');
    expect(config.mcpServers.pindex.env.FEDERATION_REPOS).toBeUndefined();
  });

  it('includes FEDERATION_REPOS when repos are present', () => {
    const entry = {
      path: tempDir,
      hash: 'abc12345',
      name: 'test-project',
      monitoringPort: 7843,
      federatedRepos: ['/path/to/repo-a', '/path/to/repo-b'],
      addedAt: new Date().toISOString(),
    };

    writeMcpJson(tempDir, entry);

    const config = JSON.parse(readFileSync(join(tempDir, '.mcp.json'), 'utf-8'));
    expect(config.mcpServers.pindex.env.FEDERATION_REPOS).toBe(
      '/path/to/repo-a:/path/to/repo-b',
    );
  });
});

describe('injectClaudeMdSection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pindex-claude-md-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates CLAUDE.md if missing', () => {
    const result = injectClaudeMdSection(tempDir);
    expect(result).toBe('created');
    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# CLAUDE.md');
    expect(content).toContain('<!-- pindex -->');
    expect(content).toContain('PindeX');
  });

  it('appends section if CLAUDE.md exists without marker', () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), '# My Project\n\nExisting content.\n', 'utf-8');

    const result = injectClaudeMdSection(tempDir);
    expect(result).toBe('added');
    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Existing content.');
    expect(content).toContain('<!-- pindex -->');
  });

  it('skips if marker is already present (idempotent)', () => {
    writeFileSync(
      join(tempDir, 'CLAUDE.md'),
      '# My Project\n\n## PindeX – Codebase Navigation\nold content\n<!-- pindex -->\n',
      'utf-8',
    );

    const result = injectClaudeMdSection(tempDir);
    expect(result).toBe('skipped');
  });

  it('replaces existing section when force=true', () => {
    writeFileSync(
      join(tempDir, 'CLAUDE.md'),
      '# My Project\n\n## PindeX – Old Section\nold content\n<!-- pindex -->\n',
      'utf-8',
    );

    const result = injectClaudeMdSection(tempDir, { force: true });
    expect(result).toBe('updated');
    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('<!-- pindex -->');
    expect(content).not.toContain('Old Section');
  });
});

describe('injectClaudeSettings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pindex-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .claude/settings.json if missing', () => {
    const result = injectClaudeSettings(tempDir);
    expect(result).toBe('created');

    const settingsPath = join(tempDir, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const config = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(config.hooks).toBeDefined();
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.SessionStart).toHaveLength(1);
    expect(config.hooks.PreToolUse[0]._pindex).toBe('pindex-hook');
  });

  it('merges hooks into existing settings.json', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', hooks: { CustomHook: [{ type: 'test' }] } }),
      'utf-8',
    );

    const result = injectClaudeSettings(tempDir);
    expect(result).toBe('added');

    const config = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(config.theme).toBe('dark');
    expect(config.hooks.CustomHook).toBeDefined();
    expect(config.hooks.PreToolUse).toBeDefined();
    expect(config.hooks.SessionStart).toBeDefined();
  });

  it('skips if marker is already present (idempotent)', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ _pindex: 'pindex-hook', matcher: 'Read|Glob|Grep' }],
          SessionStart: [{ _pindex: 'pindex-hook' }],
        },
      }),
      'utf-8',
    );

    const result = injectClaudeSettings(tempDir);
    expect(result).toBe('skipped');
  });
});

describe('injectGitignore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pindex-gitignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .gitignore if missing', () => {
    const result = injectGitignore(tempDir);
    expect(result).toBe('created');
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(content).toContain('.pindex/');
  });

  it('adds entry to existing .gitignore', () => {
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules/\n', 'utf-8');

    const result = injectGitignore(tempDir);
    expect(result).toBe('added');
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.pindex/');
  });

  it('skips if .pindex/ already present (idempotent)', () => {
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules/\n.pindex/\n', 'utf-8');

    const result = injectGitignore(tempDir);
    expect(result).toBe('already_present');
  });

  it('detects .pindex without trailing slash', () => {
    writeFileSync(join(tempDir, '.gitignore'), '.pindex\n', 'utf-8');

    const result = injectGitignore(tempDir);
    expect(result).toBe('already_present');
  });
});

describe('removeClaudeMdSection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pindex-rm-claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns "skipped" if CLAUDE.md does not exist', () => {
    const result = removeClaudeMdSection(tempDir);
    expect(result).toBe('skipped');
  });

  it('returns "not_found" if marker is absent', () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), '# My Project\n', 'utf-8');
    const result = removeClaudeMdSection(tempDir);
    expect(result).toBe('not_found');
  });

  it('removes section and returns "removed"', () => {
    writeFileSync(
      join(tempDir, 'CLAUDE.md'),
      '# My Project\n\n## PindeX – Codebase Navigation\nSome content\n<!-- pindex -->\n',
      'utf-8',
    );

    const result = removeClaudeMdSection(tempDir);
    expect(result).toBe('removed');

    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).not.toContain('<!-- pindex -->');
    expect(content).not.toContain('PindeX');
  });
});

describe('removeClaudeSettings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pindex-rm-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns "skipped" if settings.json does not exist', () => {
    const result = removeClaudeSettings(tempDir);
    expect(result).toBe('skipped');
  });

  it('returns "not_found" if hook marker is absent', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [] } }),
      'utf-8',
    );

    const result = removeClaudeSettings(tempDir);
    expect(result).toBe('not_found');
  });

  it('removes hooks and cleans empty objects', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ _pindex: 'pindex-hook', matcher: 'Read|Glob|Grep' }],
          SessionStart: [{ _pindex: 'pindex-hook' }],
        },
      }),
      'utf-8',
    );

    const result = removeClaudeSettings(tempDir);
    expect(result).toBe('removed');

    const config = JSON.parse(
      readFileSync(join(claudeDir, 'settings.json'), 'utf-8'),
    );
    // Since both arrays become empty, the hooks object and its keys should be cleaned
    expect(config.hooks).toBeUndefined();
  });

  it('preserves other hooks when removing pindex hooks', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        hooks: {
          PreToolUse: [
            { type: 'other', matcher: 'Something' },
            { _pindex: 'pindex-hook', matcher: 'Read|Glob|Grep' },
          ],
          SessionStart: [{ _pindex: 'pindex-hook' }],
        },
      }),
      'utf-8',
    );

    const result = removeClaudeSettings(tempDir);
    expect(result).toBe('removed');

    const config = JSON.parse(
      readFileSync(join(claudeDir, 'settings.json'), 'utf-8'),
    );
    expect(config.theme).toBe('dark');
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.PreToolUse[0].type).toBe('other');
    // SessionStart should be cleaned since it's now empty
    expect(config.hooks.SessionStart).toBeUndefined();
  });
});

describe('removeMcpJson', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pindex-rm-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns "skipped" if .mcp.json does not exist', () => {
    const result = removeMcpJson(tempDir);
    expect(result).toBe('skipped');
  });

  it('removes .mcp.json and returns "removed"', () => {
    writeFileSync(join(tempDir, '.mcp.json'), '{}', 'utf-8');
    expect(existsSync(join(tempDir, '.mcp.json'))).toBe(true);

    const result = removeMcpJson(tempDir);
    expect(result).toBe('removed');
    expect(existsSync(join(tempDir, '.mcp.json'))).toBe(false);
  });
});
