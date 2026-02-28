import { writeFileSync, existsSync, mkdirSync, readFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import {
  findProjectRoot,
  getProjectIndexPath,
  GlobalRegistry,
  type RegistryEntry,
} from './project-detector.js';

// ─── .mcp.json generation ─────────────────────────────────────────────────

export function writeMcpJson(
  projectRoot: string,
  entry: RegistryEntry,
): void {
  const federationEnv =
    entry.federatedRepos.length > 0
      ? { FEDERATION_REPOS: entry.federatedRepos.join(':') }
      : {};

  const config = {
    mcpServers: {
      pindex: {
        command: 'pindex-server',
        args: [] as string[],
        env: {
          PROJECT_ROOT: entry.path,
          INDEX_PATH: getProjectIndexPath(entry.path),
          MONITORING_PORT: String(entry.monitoringPort),
          AUTO_REINDEX: 'true',
          GENERATE_SUMMARIES: 'false',
          MONITORING_AUTO_OPEN: 'false',
          BASELINE_MODE: 'false',
          TOKEN_PRICE_PER_MILLION: '3.00',
          ...federationEnv,
        },
      },
    },
  };

  const mcpJsonPath = join(projectRoot, '.mcp.json');
  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ─── CLAUDE.md injection ───────────────────────────────────────────────────

const CLAUDE_MD_MARKER = '<!-- pindex -->';

const CLAUDE_MD_SECTION = `
## PindeX – Codebase Navigation

Dieses Projekt ist mit PindeX indexiert.

**PFLICHT-WORKFLOW** – bei jeder Codebase-Aufgabe:
1. **Unbekannte Datei?** → \`mcp__pindex__get_file_summary\` ZUERST, dann ggf. \`get_context\`
2. **Symbol suchen?** → \`mcp__pindex__search_symbols\` oder \`find_symbol\`
3. **Abhängigkeiten?** → \`mcp__pindex__get_dependencies\`
4. **Wo wird etwas verwendet?** → \`mcp__pindex__find_usages\`
5. **Projekt-Überblick?** → \`mcp__pindex__get_project_overview\`

**VERBOTEN** (solange PindeX verfügbar):
- \`Read\` auf Quellcode-Dateien ohne vorherigen \`get_file_summary\`-Aufruf
- \`Glob\`/\`Grep\` zur Symbol-Suche statt \`search_symbols\`

**Kontext auslagern:**
- Wichtige Entscheidungen / Muster → \`mcp__pindex__save_context\` speichern
- Zu Sessionbeginn → \`mcp__pindex__search_docs\` für gespeicherten Kontext

**Fallback:** Falls ein Tool \`null\` zurückgibt → \`Read\`/\`Grep\` als Fallback.
${CLAUDE_MD_MARKER}
`;

/**
 * Appends the PindeX section to the project's CLAUDE.md (or creates the file).
 * Idempotent: skips if the marker is already present, unless force=true.
 * With force=true the existing section is replaced (useful after PindeX updates).
 */
export function injectClaudeMdSection(
  projectRoot: string,
  { force = false } = {},
): 'added' | 'updated' | 'skipped' | 'created' {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes(CLAUDE_MD_MARKER)) {
      if (!force) return 'skipped';
      // Strip the old section and re-inject with current template
      const stripped = existing.replace(
        /\n## PindeX[\s\S]*?<!--\s*pindex\s*-->\n?/,
        '',
      );
      writeFileSync(claudeMdPath, stripped.trimEnd() + CLAUDE_MD_SECTION, 'utf-8');
      return 'updated';
    }
    appendFileSync(claudeMdPath, CLAUDE_MD_SECTION, 'utf-8');
    return 'added';
  } else {
    writeFileSync(claudeMdPath, `# CLAUDE.md\n${CLAUDE_MD_SECTION}`, 'utf-8');
    return 'created';
  }
}

// ─── .claude/settings.json Hook injection ─────────────────────────────────

const HOOK_MARKER = 'pindex-hook';

const PINDEX_HOOKS = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Read|Glob|Grep',
        hooks: [
          {
            type: 'command',
            // Remind Claude to prefer PindeX tools for source-code exploration
            command: `node -e "const f=process.env.CLAUDE_TOOL_INPUT_FILE_PATH||''; const src=/\\.(ts|tsx|js|jsx|py|java|go|rs|cs|cpp|c|rb|swift|kt)$/i.test(f); if(src) process.stdout.write('[PindeX] Bevorzuge get_file_summary / get_context / search_symbols statt direktem Read. Nur als Fallback Read nutzen.\\n')"`,
          },
        ],
      },
    ],
  },
};

/**
 * Writes/merges the PindeX PreToolUse hook into .claude/settings.json.
 * Idempotent: skips if the hook marker is already present.
 */
export function injectClaudeSettings(
  projectRoot: string,
  { force = false } = {},
): 'added' | 'skipped' | 'created' {
  const claudeDir = join(projectRoot, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    if (raw.includes(HOOK_MARKER) && !force) return 'skipped';

    let existing: Record<string, unknown>;
    try { existing = JSON.parse(raw); } catch { existing = {}; }

    // Deep-merge hooks
    const merged = {
      ...existing,
      hooks: {
        ...(existing.hooks as object | undefined),
        PreToolUse: [
          // Remove old pindex hook entries, then re-add
          ...((existing.hooks as { PreToolUse?: unknown[] } | undefined)?.PreToolUse ?? [])
            .filter((h) => !JSON.stringify(h).includes(HOOK_MARKER)),
          { ...PINDEX_HOOKS.hooks.PreToolUse[0], _pindex: HOOK_MARKER },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    return 'added';
  } else {
    const config = {
      hooks: {
        PreToolUse: [{ ...PINDEX_HOOKS.hooks.PreToolUse[0], _pindex: HOOK_MARKER }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return 'created';
  }
}

// ─── .gitignore injection ──────────────────────────────────────────────────

/**
 * Adds `.pindex/` to the project's .gitignore (or creates the file).
 * Idempotent: skips if already present.
 */
export function injectGitignore(
  projectRoot: string,
): 'added' | 'already_present' | 'created' {
  const gitignorePath = join(projectRoot, '.gitignore');
  const entry = '.pindex/';
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (content.split('\n').some((l) => l.trim() === entry || l.trim() === '.pindex')) {
      return 'already_present';
    }
    appendFileSync(gitignorePath, `\n# PindeX index data\n${entry}\n`, 'utf-8');
    return 'added';
  } else {
    writeFileSync(gitignorePath, `# PindeX index data\n${entry}\n`, 'utf-8');
    return 'created';
  }
}

// ─── Init project ──────────────────────────────────────────────────────────

/**
 * Run `pindex` with no arguments in a project directory.
 * Detects project root, registers in global registry, writes .mcp.json.
 */
export async function initProject(cwd: string): Promise<void> {
  const projectRoot = findProjectRoot(cwd);
  const registry = new GlobalRegistry();
  const entry = registry.upsert(projectRoot);

  // Ensure the project's local .pindex/ directory exists
  const dbDir = join(projectRoot, '.pindex');
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  writeMcpJson(projectRoot, entry);
  const claudeResult = injectClaudeMdSection(projectRoot);
  const hooksResult = injectClaudeSettings(projectRoot);
  const gitignoreResult = injectGitignore(projectRoot);

  const relPath = '.mcp.json';
  const claudeStatus =
    claudeResult === 'created' ? 'created' :
    claudeResult === 'added'   ? 'section added' :
    claudeResult === 'updated' ? 'section updated' :
                                 'already present';
  const hooksStatus =
    hooksResult === 'created' ? 'created' :
    hooksResult === 'added'   ? 'hook added' :
                                'already present';
  const gitignoreStatus =
    gitignoreResult === 'created'        ? 'created' :
    gitignoreResult === 'added'          ? 'entry added' :
                                           'already present';
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║           PindeX – Ready                 ║');
  console.log('  ╚══════════════════════════════════════════╝\n');
  console.log(`  Project   : ${projectRoot}`);
  console.log(`  Index     : ${projectRoot}/.pindex/index.db`);
  console.log(`  .gitignore: ${gitignoreStatus}`);
  console.log(`  Port      : ${entry.monitoringPort}`);
  console.log(`  Config    : ${relPath} (written)`);
  console.log(`  CLAUDE.md : ${claudeStatus}`);
  console.log(`  Hooks     : ${hooksStatus}\n`);
  console.log('  ── Next steps ─────────────────────────────');
  console.log('  1. Restart Claude Code in this directory');
  console.log('     Claude Code will pick up .mcp.json automatically.');
  console.log('  2. Open the dashboard:  pindex-gui');
  if (entry.federatedRepos.length > 0) {
    console.log(`\n  Federated repos (${entry.federatedRepos.length}):`);
    for (const r of entry.federatedRepos) console.log(`    - ${r}`);
  }
  console.log('\n  ══════════════════════════════════════════\n');
}

// ─── Cleanup helpers ───────────────────────────────────────────────────────

/**
 * Removes the PindeX section from CLAUDE.md (if present).
 * Returns 'removed' | 'not_found' | 'skipped' (file didn't exist).
 */
export function removeClaudeMdSection(projectRoot: string): 'removed' | 'not_found' | 'skipped' {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) return 'skipped';
  const content = readFileSync(claudeMdPath, 'utf-8');
  if (!content.includes(CLAUDE_MD_MARKER)) return 'not_found';
  const stripped = content.replace(/\n## PindeX[\s\S]*?<!--\s*pindex\s*-->\n?/, '');
  writeFileSync(claudeMdPath, stripped, 'utf-8');
  return 'removed';
}

/**
 * Removes the PindeX PreToolUse hook from .claude/settings.json (if present).
 * Returns 'removed' | 'not_found' | 'skipped' (file didn't exist).
 */
export function removeClaudeSettings(projectRoot: string): 'removed' | 'not_found' | 'skipped' {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return 'skipped';
  const raw = readFileSync(settingsPath, 'utf-8');
  if (!raw.includes(HOOK_MARKER)) return 'not_found';
  let existing: Record<string, unknown>;
  try { existing = JSON.parse(raw); } catch { return 'not_found'; }
  const hooks = existing.hooks as { PreToolUse?: unknown[] } | undefined;
  const filtered = (hooks?.PreToolUse ?? []).filter(
    (h) => !JSON.stringify(h).includes(HOOK_MARKER),
  );
  const updated = {
    ...existing,
    hooks: { ...hooks, PreToolUse: filtered },
  };
  // Remove empty PreToolUse array to keep settings.json clean
  if (filtered.length === 0) delete (updated.hooks as Record<string, unknown>).PreToolUse;
  if (Object.keys(updated.hooks as object).length === 0) delete (updated as Record<string, unknown>).hooks;
  writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  return 'removed';
}

/**
 * Removes .mcp.json from the project root (if present).
 * Returns 'removed' | 'skipped'.
 */
export function removeMcpJson(projectRoot: string): 'removed' | 'skipped' {
  const mcpJsonPath = join(projectRoot, '.mcp.json');
  if (!existsSync(mcpJsonPath)) return 'skipped';
  unlinkSync(mcpJsonPath);
  return 'removed';
}

// ─── Add federated repo ────────────────────────────────────────────────────

/**
 * Link another repository to the current project for cross-repo search.
 * Updates .mcp.json with FEDERATION_REPOS.
 */
export async function addFederatedRepo(cwd: string, repoPath: string): Promise<void> {
  const projectRoot = findProjectRoot(cwd);
  const resolvedRepo = resolve(repoPath);

  if (!existsSync(resolvedRepo)) {
    console.error(`Error: path does not exist: ${resolvedRepo}`);
    process.exit(1);
  }
  if (resolvedRepo === projectRoot) {
    console.error('Error: cannot add the current project as a federated repo.');
    process.exit(1);
  }

  const registry = new GlobalRegistry();

  // Register the federated repo itself (so pindex-gui knows about it too)
  registry.upsert(resolvedRepo);

  // Update current project's federated repos list
  const currentEntry = registry.upsert(projectRoot);
  const existing = currentEntry.federatedRepos;

  if (existing.includes(resolvedRepo)) {
    console.log(`Already linked: ${resolvedRepo}`);
    return;
  }

  const updated = [...existing, resolvedRepo];
  registry.setFederatedRepos(projectRoot, updated);

  // Re-read to get the updated entry
  const updatedEntry = registry.getByPath(projectRoot)!;
  writeMcpJson(projectRoot, updatedEntry);

  const repoName = resolvedRepo.split('/').pop() ?? resolvedRepo;
  console.log(`\n  ✓ Linked: ${repoName}  (${resolvedRepo})`);
  console.log('  .mcp.json updated with FEDERATION_REPOS.\n');
  console.log('  Restart Claude Code to activate cross-repo search.\n');
}

// ─── Remove federated repo ─────────────────────────────────────────────────

export async function removeFederatedRepo(cwd: string, repoPath: string): Promise<void> {
  const projectRoot = findProjectRoot(cwd);
  const resolvedRepo = resolve(repoPath);

  const registry = new GlobalRegistry();
  const entry = registry.getByPath(projectRoot);
  if (!entry) {
    console.error('Project not registered. Run  pindex  first.');
    process.exit(1);
  }

  const updated = entry.federatedRepos.filter((r) => r !== resolvedRepo);
  registry.setFederatedRepos(projectRoot, updated);

  const updatedEntry = registry.getByPath(projectRoot)!;
  writeMcpJson(projectRoot, updatedEntry);

  console.log(`\n  ✓ Unlinked: ${resolvedRepo}`);
  console.log('  .mcp.json updated. Restart Claude Code to apply.\n');
}
