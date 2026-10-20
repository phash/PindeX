import { writeFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, join, relative, basename } from 'node:path';
import {
  findProjectRoot,
  getProjectIndexPath,
  GlobalRegistry,
  type RegistryEntry,
} from './project-detector.js';
import { mergeMcpServer, serverCommand, nodeScriptCommand } from './mcp-json.js';
import { formatFederationRepos } from '../federation/env.js';

// ─── .mcp.json generation ─────────────────────────────────────────────────

export function writeMcpJson(
  projectRoot: string,
  entry: RegistryEntry,
): void {
  const federationEnv: Record<string, string> =
    entry.federatedRepos.length > 0
      ? { FEDERATION_REPOS: formatFederationRepos(entry.federatedRepos.map((r) => r.path)) }
      : {};

  mergeMcpServer(projectRoot, 'pindex', {
    ...serverCommand(),
    env: {
      PROJECT_ROOT: entry.path,
      INDEX_PATH: getProjectIndexPath(entry.path),
      MONITORING_PORT: String(entry.monitoringPort),
      AUTO_REINDEX: 'true',
      GENERATE_SUMMARIES: 'false',
      MONITORING_AUTO_OPEN: 'false',
      BASELINE_MODE: 'false',
      ...federationEnv,
    },
  });
}

// ─── CLAUDE.md injection ───────────────────────────────────────────────────

const SECTION_START = '<!-- pindex:start -->';
const SECTION_END = '<!-- pindex:end -->';
/** End marker of sections written by older versions (no start marker). */
const LEGACY_SECTION_END = '<!-- pindex -->';
const LEGACY_HEADING = '## PindeX – Codebase Navigation';

const CLAUDE_MD_SECTION = `
${SECTION_START}
## PindeX – Codebase Navigation

Dieses Projekt ist mit PindeX indexiert.

**PFLICHT-WORKFLOW** – bei jeder Codebase-Aufgabe:
1. **Unbekannte Datei?** → \`mcp__pindex__get_file_summary\` ZUERST, dann ggf. \`get_context\`
2. **Symbol suchen?** → \`mcp__pindex__search_symbols\`
3. **Abhängigkeiten?** → \`mcp__pindex__get_dependencies\`
4. **Wo wird etwas verwendet?** → \`mcp__pindex__find_usages\`
5. **Projekt-Überblick?** → \`mcp__pindex__get_project_overview\`

**VERBOTEN** (solange PindeX verfügbar):
- \`Read\` auf Quellcode-Dateien ohne vorherigen \`get_file_summary\`-Aufruf
- \`Glob\`/\`Grep\` zur Symbol-Suche statt \`search_symbols\`

**Kontext auslagern:**
- Wichtige Entscheidungen / Muster → \`mcp__pindex__save_context\` speichern
- Zu Sessionbeginn → \`mcp__pindex__search_docs\` für gespeicherten Kontext

**Fallback:** Liefert ein PindeX-Tool kein Ergebnis oder einen Fehler → \`Read\`/\`Grep\` als Fallback.
${SECTION_END}
`;

function hasSection(content: string): boolean {
  return content.includes(SECTION_START) || content.includes(LEGACY_SECTION_END);
}

/**
 * Removes the PindeX section: between the start/end markers, or (legacy, no start marker)
 * from the exact legacy heading to the legacy end marker. Returns null if nothing matched.
 */
function stripSection(content: string): string | null {
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\n?${escape(SECTION_START)}[\\s\\S]*?${escape(SECTION_END)}\\n?`),
    new RegExp(`\\n?${escape(LEGACY_HEADING)}[\\s\\S]*?${escape(LEGACY_SECTION_END)}\\n?`),
  ];
  for (const re of patterns) {
    if (re.test(content)) return content.replace(re, '');
  }
  // Orphan legacy end marker without the exact heading: drop a preceding "## PindeX" heading
  // block if there is one, else only the marker line itself.
  const endIdx = content.indexOf(LEGACY_SECTION_END);
  if (endIdx === -1) return null;
  const headingIdx = content.lastIndexOf('\n## PindeX', endIdx);
  const from = headingIdx !== -1 ? headingIdx : endIdx;
  const to = endIdx + LEGACY_SECTION_END.length;
  return content.slice(0, from) + content.slice(content[to] === '\n' ? to + 1 : to);
}

/**
 * Appends the PindeX section to the project's CLAUDE.md (or creates the file).
 * Idempotent: skips if a section marker is already present, unless force=true.
 * With force=true the existing section is replaced (useful after PindeX updates).
 */
export function injectClaudeMdSection(
  projectRoot: string,
  { force = false } = {},
): 'added' | 'updated' | 'skipped' | 'created' {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (hasSection(existing)) {
      if (!force) return 'skipped';
      // Strip the old section and re-inject with current template
      const stripped = stripSection(existing) ?? existing;
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

function isPindexEntry(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null &&
    (entry as { _pindex?: unknown })._pindex === HOOK_MARKER;
}

/** Parses settings.json; throws a clear error (file untouched) if it is not a JSON object. */
function readSettings(settingsPath: string): Record<string, unknown> {
  const raw = readFileSync(settingsPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value is not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${settingsPath} is not valid JSON (${(err as Error).message}). Fix or remove it manually; PindeX will not overwrite it.`,
    );
  }
}

const OLD_SESSION_START_COMMAND = 'pindex gui';

/** SessionStart entry: starts the dashboard in the background without opening a browser. */
function sessionStartEntry(): { hooks: { type: string; command: string }[] } {
  const { command, args } = nodeScriptCommand('cli/index.js');
  return {
    hooks: [{ type: 'command', command: `"${command}" "${args[0]}" gui --no-open` }],
  };
}

/** True if an existing pindex SessionStart entry still uses the old bare `pindex gui` command. */
function hasStaleSessionStart(settings: Record<string, unknown>): boolean {
  const entries = (settings.hooks as Record<string, unknown[]> | undefined)?.SessionStart ?? [];
  return entries.some((e) => {
    const entry = e as { _pindex?: string; hooks?: { command?: string }[] };
    return entry._pindex === HOOK_MARKER &&
      (entry.hooks ?? []).some((h) => h.command === OLD_SESSION_START_COMMAND);
  });
}

/**
 * Writes/merges PindeX hooks (PreToolUse + SessionStart) into .claude/settings.json.
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
    const existing = readSettings(settingsPath);
    const eh = existing.hooks as Record<string, unknown[]> | undefined;
    const alreadyInstalled = [...(eh?.PreToolUse ?? []), ...(eh?.SessionStart ?? [])].some(isPindexEntry);
    if (alreadyInstalled && !force && !hasStaleSessionStart(existing)) return 'skipped';

    // Deep-merge hooks
    const existingHooks = existing.hooks as Record<string, unknown[]> | undefined;
    const merged = {
      ...existing,
      hooks: {
        ...existingHooks,
        PreToolUse: [
          // Remove old pindex hook entries, then re-add
          ...(existingHooks?.PreToolUse ?? [])
            .filter((h) => !isPindexEntry(h)),
          { ...PINDEX_HOOKS.hooks.PreToolUse[0], _pindex: HOOK_MARKER },
        ],
        SessionStart: [
          ...(existingHooks?.SessionStart ?? [])
            .filter((h) => !isPindexEntry(h)),
          { ...sessionStartEntry(), _pindex: HOOK_MARKER },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    return 'added';
  } else {
    const config = {
      hooks: {
        PreToolUse: [{ ...PINDEX_HOOKS.hooks.PreToolUse[0], _pindex: HOOK_MARKER }],
        SessionStart: [{ ...sessionStartEntry(), _pindex: HOOK_MARKER }],
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
    for (const r of entry.federatedRepos) console.log(`    - ${r.name}  ${r.path}`);
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
  if (!hasSection(content)) return 'not_found';
  const stripped = stripSection(content);
  if (stripped === null) return 'not_found';
  writeFileSync(claudeMdPath, stripped, 'utf-8');
  return 'removed';
}

/**
 * Removes PindeX hooks (PreToolUse + SessionStart) from .claude/settings.json (if present).
 * Returns 'removed' | 'not_found' | 'skipped' (file didn't exist).
 */
export function removeClaudeSettings(projectRoot: string): 'removed' | 'not_found' | 'skipped' {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return 'skipped';
  const existing = readSettings(settingsPath);
  const hooks = existing.hooks as Record<string, unknown[]> | undefined;
  if (![...(hooks?.PreToolUse ?? []), ...(hooks?.SessionStart ?? [])].some(isPindexEntry)) return 'not_found';
  const filteredPre = (hooks?.PreToolUse ?? []).filter(
    (h) => !isPindexEntry(h),
  );
  const filteredSession = (hooks?.SessionStart ?? []).filter(
    (h) => !isPindexEntry(h),
  );
  const updated = {
    ...existing,
    hooks: { ...hooks, PreToolUse: filteredPre, SessionStart: filteredSession },
  };
  const hooksObj = updated.hooks as Record<string, unknown[]>;
  // Remove empty arrays to keep settings.json clean
  if (filteredPre.length === 0) delete hooksObj.PreToolUse;
  if (filteredSession.length === 0) delete hooksObj.SessionStart;
  if (Object.keys(hooksObj).length === 0) delete (updated as Record<string, unknown>).hooks;
  writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  return 'removed';
}

/**
 * Removes the pindex server from .mcp.json, keeping other servers.
 * The file is deleted only if nothing else is left in it.
 * Returns 'removed' | 'skipped'.
 */
export function removeMcpJson(projectRoot: string): 'removed' | 'skipped' {
  if (!existsSync(join(projectRoot, '.mcp.json'))) return 'skipped';
  mergeMcpServer(projectRoot, 'pindex', null);
  return 'removed';
}
