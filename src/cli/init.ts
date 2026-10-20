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

/**
 * The only user-set env keys carried over from an existing `.mcp.json`. A repo can ship its
 * own `.mcp.json`, so anything that could load code, redirect network traffic, widen exposure
 * or enable the LSP (NODE_OPTIONS, SUMMARIZER_BASE_URL, PINDEX_BIND_HOST, PINDEX_LSP, …) is
 * never persisted silently; the user re-adds trusted keys by hand.
 */
export const PRESERVED_ENV_KEYS = [
  'LANGUAGES',
  'AUTO_REINDEX',
  'GENERATE_SUMMARIES',
  'SUMMARIZER_MODEL',
  'MONITORING_AUTO_OPEN',
  'EXPOSE_CORE_TOOLS_ONLY',
  'OBSERVATION_RETENTION',
  'PINDEX_PARSE_WORKERS',
] as const;

const SAFE_ENV_NAME = /^[A-Z0-9_]{1,64}$/;

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

  const existingEnv: Record<string, unknown> = readMcpJson(projectRoot)?.mcpServers?.pindex?.env ?? {};
  const preserved: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(existingEnv)) {
    if ((MANAGED_ENV_KEYS as readonly string[]).includes(key)) continue;
    if ((PRESERVED_ENV_KEYS as readonly string[]).includes(key) && typeof value === 'string') {
      preserved[key] = value;
    } else if (value !== DEFAULT_ENV[key]) {
      // A pindex-written default (e.g. BASELINE_MODE=false) is rewritten anyway: no warning.
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    // Names only, never values (they may hold secrets); untrusted names that are not plain
    // env identifiers are only counted (no terminal escape sequences reach the console).
    const printable = dropped.filter((k) => SAFE_ENV_NAME.test(k));
    const others = dropped.length - printable.length;
    const names = [...printable, ...(others > 0 ? [`+${others} other key(s)`] : [])].join(', ');
    console.warn(
      `  [pindex] .mcp.json: dropped env keys not kept automatically: ${names} — re-add trusted ones by hand.`,
    );
  }

  mergeMcpServer(projectRoot, 'pindex', {
    ...serverCommand(),
    env: { ...DEFAULT_ENV, ...preserved, ...managed },
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
5. **Wie hängen A und B zusammen?** → \`mcp__pindex__get_call_path\`
6. **Projekt-Überblick?** → \`mcp__pindex__get_project_overview\`

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
  const current = hooks[event] ?? [];
  if (!Array.isArray(current)) {
    throw new Error(`hooks.${event} in a Claude settings file is not an array. Fix it manually; PindeX will not overwrite it.`);
  }
  const kept = current.filter((h) => !isPindexEntry(h));
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

/**
 * PreToolUse entry: on a whole-file Read, `pindex hook pre-tool-use` injects a symbol outline.
 * Absolute node/script paths → settings.local.json. Hard 5 s timeout (seconds); the hook fails open.
 */
function preToolUseEntry(): { matcher: string; hooks: { type: string; command: string; timeout: number }[] } {
  const { command, args } = nodeScriptCommand('cli/index.js');
  return {
    matcher: 'Read',
    hooks: [{ type: 'command', command: `"${command}" "${args[0]}" hook pre-tool-use`, timeout: 5 }],
  };
}

/** True if `entries` hold exactly one pindex entry and it runs `expected`. */
function hasCurrentCommand(entries: unknown[], expected: string): boolean {
  const ours = entries.filter(isPindexEntry) as { hooks?: { command?: string }[] }[];
  return ours.length === 1 && (ours[0].hooks ?? []).some((h) => h.command === expected);
}

/**
 * Installs the PindeX hooks:
 * - PreToolUse (outline on whole-file Read) and SessionStart (dashboard) both carry machine-specific
 *   absolute node/script paths → `.claude/settings.local.json`
 * Pindex entries left in the shared settings.json by older versions (the broken
 * CLAUDE_TOOL_INPUT_FILE_PATH PreToolUse, SessionStart) are removed — upgrade needs no --force.
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
    !hookEntries(shared, 'PreToolUse').some(isPindexEntry) &&
    !hookEntries(shared, 'SessionStart').some(isPindexEntry) &&
    hasCurrentCommand(hookEntries(local, 'PreToolUse'), preToolUseEntry().hooks[0].command) &&
    hasCurrentCommand(hookEntries(local, 'SessionStart'), sessionStartEntry().hooks[0].command);
  if (upToDate && !force) return 'skipped';

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  // Build both results before writing either, so a failure leaves both files untouched.
  let nextShared = withPindexHook(shared ?? {}, 'PreToolUse', null);
  nextShared = withPindexHook(nextShared, 'SessionStart', null);
  const nextLocal = withPindexHook(
    withPindexHook(local ?? {}, 'PreToolUse', preToolUseEntry()),
    'SessionStart',
    sessionStartEntry(),
  );
  writeSettings(sharedPath, nextShared);
  writeSettings(localPath, nextLocal);

  return shared === null ? 'created' : 'added';
}

// ─── .gitignore injection ──────────────────────────────────────────────────

/**
 * Adds `.pindex/` and `.claude/settings.local.json` to the project's .gitignore (or creates
 * the file). Idempotent: only missing entries are appended.
 */
export function injectGitignore(
  projectRoot: string,
): 'added' | 'already_present' | 'created' {
  const gitignorePath = join(projectRoot, '.gitignore');
  // .pindex/ = index data; settings.local.json = SessionStart hook with absolute local paths.
  const entries = [
    { line: '.pindex/', aliases: ['.pindex/', '.pindex'], comment: '# PindeX index data' },
    { line: '.claude/settings.local.json', aliases: ['.claude/settings.local.json', '/.claude/settings.local.json'], comment: '# Claude Code local settings (PindeX hook with absolute paths)' },
  ];
  const block = (list: typeof entries) => list.map((e) => `${e.comment}\n${e.line}\n`).join('');
  if (existsSync(gitignorePath)) {
    const lines = readFileSync(gitignorePath, 'utf-8').split('\n').map((l) => l.trim());
    const missing = entries.filter((e) => !e.aliases.some((a) => lines.includes(a)));
    if (missing.length === 0) return 'already_present';
    appendFileSync(gitignorePath, `\n${block(missing)}`, 'utf-8');
    return 'added';
  } else {
    writeFileSync(gitignorePath, block(entries), 'utf-8');
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
 * Removes PindeX hooks from `.claude/settings.json` (legacy PreToolUse/SessionStart) and
 * `.claude/settings.local.json` (PreToolUse, SessionStart). User entries are kept; a settings.local.json
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
