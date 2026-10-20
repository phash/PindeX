import { writeFileSync, existsSync, mkdirSync, readFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  findProjectRoot,
  getProjectIndexPath,
  GlobalRegistry,
  type RegistryEntry,
} from './project-detector.js';
import { mergeMcpServer, serverCommand, nodeScriptCommand, readMcpJson } from './mcp-json.js';
import { formatFederationRepos } from '../federation/env.js';

// ─── .mcp.json generation ─────────────────────────────────────────────────

/** Env keys pindex derives from the registry; always rewritten (a stale value would break the server). */
const MANAGED_ENV_KEYS = ['PROJECT_ROOT', 'INDEX_PATH', 'MONITORING_PORT', 'FEDERATION_REPOS'] as const;

/** Defaults written only when the key is not set yet; user edits survive re-runs. */
const DEFAULT_ENV: Record<string, string> = {
  AUTO_REINDEX: 'true',
  GENERATE_SUMMARIES: 'false',
  MONITORING_AUTO_OPEN: 'false',
  BASELINE_MODE: 'false',
};

export function writeMcpJson(
  projectRoot: string,
  entry: RegistryEntry,
): void {
  const managed: Record<string, string> = {
    PROJECT_ROOT: entry.path,
    INDEX_PATH: getProjectIndexPath(entry.path),
    MONITORING_PORT: String(entry.monitoringPort),
  };
  if (entry.federatedRepos.length > 0) {
    managed.FEDERATION_REPOS = formatFederationRepos(entry.federatedRepos.map((r) => r.path));
  }

  // Keep user-set keys (LANGUAGES, PINDEX_LSP, …) from an existing pindex entry.
  const userEnv = { ...(readMcpJson(projectRoot)?.mcpServers?.pindex?.env ?? {}) };
  for (const key of MANAGED_ENV_KEYS) delete userEnv[key];

  mergeMcpServer(projectRoot, 'pindex', {
    ...serverCommand(),
    env: { ...DEFAULT_ENV, ...userEnv, ...managed },
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

// ─── .claude/settings(.local).json Hook injection ─────────────────────────────────

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

type Settings = Record<string, unknown>;
type HookMap = Record<string, unknown[]>;

/** Parses a settings file; throws a clear error (file untouched) if it is not a JSON object. */
function readSettings(settingsPath: string): Settings {
  const raw = readFileSync(settingsPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value is not an object');
    }
    return parsed as Settings;
  } catch (err) {
    throw new Error(
      `${settingsPath} is not valid JSON (${(err as Error).message}). Fix or remove it manually; PindeX will not overwrite it.`,
    );
  }
}

function readSettingsIfExists(settingsPath: string): Settings | null {
  return existsSync(settingsPath) ? readSettings(settingsPath) : null;
}

function writeSettings(settingsPath: string, settings: Settings): void {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function hookEntries(settings: Settings | null, event: string): unknown[] {
  return (settings?.hooks as HookMap | undefined)?.[event] ?? [];
}

/**
 * Returns a copy of `settings` with `event`'s pindex-marked entries replaced by `add`
 * (or just removed when `add` is null). Empty event arrays and an empty hooks object are dropped.
 */
function withPindexHook(settings: Settings, event: string, add: object | null): Settings {
  const hooks: HookMap = { ...(settings.hooks as HookMap | undefined) };
  const kept = (hooks[event] ?? []).filter((h) => !isPindexEntry(h));
  const next = add ? [...kept, { ...add, _pindex: HOOK_MARKER }] : kept;
  if (next.length > 0) hooks[event] = next;
  else delete hooks[event];
  const updated: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete updated.hooks;
  return updated;
}

/** SessionStart entry: starts the dashboard in the background without opening a browser. */
function sessionStartEntry(): { hooks: { type: string; command: string }[] } {
  const { command, args } = nodeScriptCommand('cli/index.js');
  return {
    hooks: [{ type: 'command', command: `"${command}" "${args[0]}" gui --no-open` }],
  };
}

/** True if `entries` hold exactly one pindex entry and it runs the current SessionStart command. */
function hasCurrentSessionStart(entries: unknown[]): boolean {
  const ours = entries.filter(isPindexEntry) as { hooks?: { command?: string }[] }[];
  const expected = sessionStartEntry().hooks[0].command;
  return ours.length === 1 && (ours[0].hooks ?? []).some((h) => h.command === expected);
}

/**
 * Installs the PindeX hooks:
 * - PreToolUse (portable command) → shared `.claude/settings.json`
 * - SessionStart (machine-specific absolute node/script paths) → `.claude/settings.local.json`
 * A pindex SessionStart entry left in settings.json by older versions is moved out.
 * Idempotent: skips when everything is already up to date, unless force=true.
 * Both files are parsed before anything is written; malformed JSON is never overwritten.
 */
export function injectClaudeSettings(
  projectRoot: string,
  { force = false } = {},
): 'added' | 'skipped' | 'created' {
  const claudeDir = join(projectRoot, '.claude');
  const sharedPath = join(claudeDir, 'settings.json');
  const localPath = join(claudeDir, 'settings.local.json');

  const shared = readSettingsIfExists(sharedPath);
  const local = readSettingsIfExists(localPath);

  const upToDate =
    hookEntries(shared, 'PreToolUse').some(isPindexEntry) &&
    !hookEntries(shared, 'SessionStart').some(isPindexEntry) &&
    hasCurrentSessionStart(hookEntries(local, 'SessionStart'));
  if (upToDate && !force) return 'skipped';

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  let nextShared = withPindexHook(shared ?? {}, 'PreToolUse', PINDEX_HOOKS.hooks.PreToolUse[0]);
  nextShared = withPindexHook(nextShared, 'SessionStart', null);
  writeSettings(sharedPath, nextShared);
  writeSettings(localPath, withPindexHook(local ?? {}, 'SessionStart', sessionStartEntry()));

  return shared === null ? 'created' : 'added';
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
 * Removes PindeX hooks from `.claude/settings.json` (PreToolUse, legacy SessionStart) and
 * `.claude/settings.local.json` (SessionStart). User entries are kept; a settings.local.json
 * left empty is deleted. Returns 'removed' | 'not_found' | 'skipped' (neither file exists).
 */
export function removeClaudeSettings(projectRoot: string): 'removed' | 'not_found' | 'skipped' {
  const sharedPath = join(projectRoot, '.claude', 'settings.json');
  const localPath = join(projectRoot, '.claude', 'settings.local.json');
  const shared = readSettingsIfExists(sharedPath);
  const local = readSettingsIfExists(localPath);
  if (shared === null && local === null) return 'skipped';

  const hasOurs = (s: Settings | null) =>
    [...hookEntries(s, 'PreToolUse'), ...hookEntries(s, 'SessionStart')].some(isPindexEntry);
  const sharedHasOurs = hasOurs(shared);
  const localHasOurs = hasOurs(local);
  if (!sharedHasOurs && !localHasOurs) return 'not_found';

  const strip = (s: Settings) =>
    withPindexHook(withPindexHook(s, 'PreToolUse', null), 'SessionStart', null);
  if (shared && sharedHasOurs) writeSettings(sharedPath, strip(shared));
  if (local && localHasOurs) {
    const next = strip(local);
    if (Object.keys(next).length === 0) unlinkSync(localPath);
    else writeSettings(localPath, next);
  }
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
