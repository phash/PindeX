import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { serverCommand, nodeScriptCommand } from '../../src/cli/mcp-json.js';

// Mock the project-detector module to avoid touching ~/.pindex
vi.mock('../../src/cli/project-detector.js', () => {
  const mockGetProjectIndexPath = vi.fn((p: string) =>
    join(p, '.pindex', 'index.db'),
  );
  const mockFindProjectRoot = vi.fn((dir: string) => dir);

  // Module-level shared store so every `new GlobalRegistry()` instance sees the
  // same data (mirrors the real registry which is backed by a single JSON file).
  type Entry = {
    path: string;
    hash: string;
    name: string;
    monitoringPort: number;
    federatedRepos: Array<{ path: string; name: string }>;
    addedAt: string;
  };
  const __store: Entry[] = [];

  // Mock GlobalRegistry — derives a per-path hash so distinct paths are distinct
  // entries, but keeps the legacy 'abc12345' for the canonical single-path case.
  class MockGlobalRegistry {
    upsert(projectPath: string) {
      const existing = __store.find((e) => e.path === projectPath);
      if (existing) return existing;
      const entry: Entry = {
        path: projectPath,
        hash: 'h' + String(__store.length),
        name: 'test-project',
        monitoringPort: 7843,
        federatedRepos: [],
        addedAt: new Date().toISOString(),
      };
      __store.push(entry);
      return entry;
    }

    list() {
      return __store;
    }

    getByPath(projectPath: string) {
      return __store.find((e) => e.path === projectPath);
    }

    setFederatedRepos(projectPath: string, repos: Array<{ path: string; name: string }>) {
      const entry = __store.find((e) => e.path === projectPath);
      if (entry) entry.federatedRepos = repos;
    }

    read() {
      return __store;
    }
  }

  return {
    getProjectIndexPath: mockGetProjectIndexPath,
    findProjectRoot: mockFindProjectRoot,
    GlobalRegistry: MockGlobalRegistry,
    hashProjectPath: vi.fn((p: string) => 'h' + p),
    __resetStore: () => { __store.length = 0; },
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
  initProject,
} = await import('../../src/cli/init.js');

// Reset the shared in-memory registry store between every test so federation
// state from one test cannot leak into another.
const __detectorMock = await import('../../src/cli/project-detector.js');
beforeEach(() => {
  (__detectorMock as unknown as { __resetStore: () => void }).__resetStore();
});

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
      federatedRepos: [] as Array<{ path: string; name: string }>,
      addedAt: new Date().toISOString(),
    };

    writeMcpJson(tempDir, entry);

    const mcpJsonPath = join(tempDir, '.mcp.json');
    expect(existsSync(mcpJsonPath)).toBe(true);

    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    expect(config.mcpServers.pindex).toBeDefined();
    expect(isAbsolute(config.mcpServers.pindex.command)).toBe(true);
    expect(config.mcpServers.pindex.command).toBe(process.execPath);
    expect(config.mcpServers.pindex.args[0].replace(/\\/g, '/')).toMatch(/dist\/index\.js$/);
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
      federatedRepos: [
        { path: '/path/to/repo-a', name: 'repo-a' },
        { path: '/path/to/repo-b', name: 'repo-b' },
      ],
      addedAt: new Date().toISOString(),
    };

    writeMcpJson(tempDir, entry);

    const config = JSON.parse(readFileSync(join(tempDir, '.mcp.json'), 'utf-8'));
    expect(config.mcpServers.pindex.env.FEDERATION_REPOS).toBe(
      '/path/to/repo-a:/path/to/repo-b',
    );
  });
});

describe('writeMcpJson / removeMcpJson merge behavior', () => {
  let tempDir: string;
  const entry = () => ({
    path: tempDir,
    hash: 'abc12345',
    name: 'test-project',
    monitoringPort: 7843,
    federatedRepos: [] as Array<{ path: string; name: string }>,
    addedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    tempDir = join(tmpdir(), `pindex-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps foreign servers when writing, and removeMcpJson leaves them in place', () => {
    const serena = { command: 'uvx', args: ['serena'] };
    writeFileSync(join(tempDir, '.mcp.json'), JSON.stringify({ mcpServers: { serena } }), 'utf-8');

    writeMcpJson(tempDir, entry());
    let config = JSON.parse(readFileSync(join(tempDir, '.mcp.json'), 'utf-8'));
    expect(config.mcpServers.serena).toEqual(serena);
    expect(config.mcpServers.pindex).toBeDefined();

    expect(removeMcpJson(tempDir)).toBe('removed');
    expect(existsSync(join(tempDir, '.mcp.json'))).toBe(true);
    config = JSON.parse(readFileSync(join(tempDir, '.mcp.json'), 'utf-8'));
    expect(config.mcpServers).toEqual({ serena });
  });

  it('does not overwrite an invalid .mcp.json and throws a clear error', () => {
    const path = join(tempDir, '.mcp.json');
    writeFileSync(path, '{ not json', 'utf-8');
    expect(() => writeMcpJson(tempDir, entry())).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf-8')).toBe('{ not json');
    expect(() => removeMcpJson(tempDir)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf-8')).toBe('{ not json');
  });

  it('serverCommand and nodeScriptCommand return absolute node + script paths', () => {
    const cmd = serverCommand();
    expect(cmd.command).toBe(process.execPath);
    expect(isAbsolute(cmd.args[0])).toBe(true);
    expect(cmd.args[0].replace(/\\/g, '/')).toMatch(/dist\/index\.js$/);
    expect(nodeScriptCommand('hooks/x.js').args[0].replace(/\\/g, '/')).toMatch(/dist\/hooks\/x\.js$/);
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
    expect(content).toContain('<!-- pindex:start -->');
    expect(content).toContain('PindeX');
  });

  it('appends section if CLAUDE.md exists without marker', () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), '# My Project\n\nExisting content.\n', 'utf-8');

    const result = injectClaudeMdSection(tempDir);
    expect(result).toBe('added');
    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Existing content.');
    expect(content).toContain('<!-- pindex:start -->');
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
      '# My Project\n\n## PindeX – Codebase Navigation\nOld Section content\n<!-- pindex -->\n',
      'utf-8',
    );

    const result = injectClaudeMdSection(tempDir, { force: true });
    expect(result).toBe('updated');
    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('<!-- pindex:start -->');
    expect(content).toContain('<!-- pindex:end -->');
    expect(content).not.toContain('Old Section');
  });

  it('force with an orphan legacy end marker does not stack sections', () => {
    const p = join(tempDir, 'CLAUDE.md');
    writeFileSync(p, '# P\n\nmine\n\n## PindeX stale\nold\n<!-- pindex -->\n', 'utf-8');
    expect(injectClaudeMdSection(tempDir, { force: true })).toBe('updated');
    let content = readFileSync(p, 'utf-8');
    expect(content).toContain('mine');
    expect(content).not.toContain('stale');
    expect(content).not.toContain('<!-- pindex -->');
    expect(content.match(/pindex:start/g)).toHaveLength(1);

    writeFileSync(p, '# P\n\nmine\n<!-- pindex -->\nafter\n', 'utf-8');
    injectClaudeMdSection(tempDir, { force: true });
    content = readFileSync(p, 'utf-8');
    expect(content).toContain('mine');
    expect(content).toContain('after');
    expect(content).not.toContain('<!-- pindex -->');
  });

  it('template has no find_symbol and no null claim', () => {
    injectClaudeMdSection(tempDir);
    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content).not.toContain('find_symbol');
    expect(content).not.toContain('null');
  });

  it('wraps the section in start/end markers', () => {
    injectClaudeMdSection(tempDir);
    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content.indexOf('<!-- pindex:start -->')).toBeGreaterThanOrEqual(0);
    expect(content.indexOf('<!-- pindex:start -->')).toBeLessThan(content.indexOf('<!-- pindex:end -->'));
  });

  it('force keeps a user heading "## PindeX notes" above the section', () => {
    injectClaudeMdSection(tempDir);
    const p = join(tempDir, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('# CLAUDE.md', '# CLAUDE.md\n\n## PindeX notes\nmine\n'), 'utf-8');
    expect(injectClaudeMdSection(tempDir, { force: true })).toBe('updated');
    const content = readFileSync(p, 'utf-8');
    expect(content).toContain('## PindeX notes\nmine');
    expect(content.match(/pindex:start/g)).toHaveLength(1);
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

  it('user hook merely mentioning pindex-hook survives inject + remove', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const mine = { hooks: [{ type: 'command', command: 'echo pindex-hook is mine' }] };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [mine] } }), 'utf-8');
    injectClaudeSettings(tempDir);
    removeClaudeSettings(tempDir);
    const config = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(config.hooks.SessionStart).toEqual([mine]);
  });

  it('malformed settings.json is left untouched and reported', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const p = join(claudeDir, 'settings.json');
    writeFileSync(p, '{ not json pindex-hook', 'utf-8');
    expect(() => injectClaudeSettings(tempDir)).toThrow(/not valid JSON/);
    expect(() => removeClaudeSettings(tempDir)).toThrow(/not valid JSON/);
    expect(readFileSync(p, 'utf-8')).toBe('{ not json pindex-hook');
  });

  it('SessionStart hook is quiet (--no-open) with absolute node + script', () => {
    injectClaudeSettings(tempDir);
    const config = JSON.parse(readFileSync(join(tempDir, '.claude', 'settings.json'), 'utf-8'));
    const cmd: string = config.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('--no-open');
    expect(cmd).toContain(` gui --no-open`);
    const { command, args } = nodeScriptCommand('cli/index.js');
    expect(cmd).toBe(`"${command}" "${args[0]}" gui --no-open`);
  });

  it('upgrades the old bare "pindex gui" SessionStart hook without --force', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ _pindex: 'pindex-hook', matcher: 'Read|Glob|Grep', hooks: [] }],
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo mine' }] },
            { _pindex: 'pindex-hook', hooks: [{ type: 'command', command: 'pindex gui' }] },
          ],
        },
      }),
      'utf-8',
    );
    expect(injectClaudeSettings(tempDir)).toBe('added');
    const config = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    const cmds = config.hooks.SessionStart.map((e: any) => e.hooks[0].command);
    expect(cmds).toContain('echo mine');
    expect(cmds.filter((c: string) => c.includes('gui'))).toHaveLength(1);
    expect(cmds.some((c: string) => c === 'pindex gui')).toBe(false);
    expect(cmds.some((c: string) => c.includes('--no-open'))).toBe(true);
    // second run is a no-op
    expect(injectClaudeSettings(tempDir)).toBe('skipped');
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

  it('keeps a user "## PindeX notes" heading above the marked section', () => {
    writeFileSync(
      join(tempDir, 'CLAUDE.md'),
      '# P\n\n## PindeX notes\nmine\n\n<!-- pindex:start -->\n## PindeX – Codebase Navigation\nx\n<!-- pindex:end -->\n\n## After\nkeep\n',
      'utf-8',
    );
    expect(removeClaudeMdSection(tempDir)).toBe('removed');
    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('## PindeX notes\nmine');
    expect(content).toContain('## After\nkeep');
    expect(content).not.toContain('Codebase Navigation');
    expect(content).not.toContain('pindex:');
  });

  it('legacy section: strips only from the exact heading, not an earlier "## PindeX notes"', () => {
    writeFileSync(
      join(tempDir, 'CLAUDE.md'),
      '# P\n\n## PindeX notes\nmine\n\n## PindeX – Codebase Navigation\nold\n<!-- pindex -->\n',
      'utf-8',
    );
    expect(removeClaudeMdSection(tempDir)).toBe('removed');
    const content = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('## PindeX notes\nmine');
    expect(content).not.toContain('Codebase Navigation');
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

describe('initProject', () => {
  let tempDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pindex-initproj-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it('creates .pindex dir, .mcp.json, CLAUDE.md, hooks and .gitignore', async () => {
    await initProject(tempDir);

    // .pindex/ directory created
    expect(existsSync(join(tempDir, '.pindex'))).toBe(true);

    // .mcp.json written with correct shape
    const mcpPath = join(tempDir, '.mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(isAbsolute(config.mcpServers.pindex.command)).toBe(true);
    expect(config.mcpServers.pindex.command).toBe(process.execPath);
    expect(config.mcpServers.pindex.args[0].replace(/\\/g, '/')).toMatch(/dist\/index\.js$/);
    expect(config.mcpServers.pindex.env.PROJECT_ROOT).toBe(tempDir);
    // index path uses absolute path inside the project's .pindex/
    expect(config.mcpServers.pindex.env.INDEX_PATH).toContain('.pindex');
    expect(config.mcpServers.pindex.env.MONITORING_PORT).toBe('7843');
    expect(config.mcpServers.pindex.env.AUTO_REINDEX).toBe('true');

    // side-effect files
    expect(existsSync(join(tempDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(tempDir, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(tempDir, '.gitignore'))).toBe(true);

    // banner printed
    expect(logSpy).toHaveBeenCalled();
  });

  it('is idempotent on re-init (already registered) and reuses .pindex dir', async () => {
    await initProject(tempDir);
    // second run must not throw and should leave files in place
    await initProject(tempDir);

    const config = JSON.parse(readFileSync(join(tempDir, '.mcp.json'), 'utf-8'));
    expect(config.mcpServers.pindex.env.PROJECT_ROOT).toBe(tempDir);
    expect(existsSync(join(tempDir, '.pindex'))).toBe(true);
  });

  it('prints federated repos in the banner when present', async () => {
    // First init to register the project, then federate a sibling repo.
    await initProject(tempDir);

    const repoDir = join(tmpdir(), `pindex-fed-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repoDir, { recursive: true });
    try {
      new __detectorMock.GlobalRegistry().setFederatedRepos(tempDir, [{ path: repoDir, name: 'fed' }]);
      logSpy.mockClear();
      await initProject(tempDir);
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('Federated repos');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
