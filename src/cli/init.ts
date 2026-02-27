import { writeFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import {
  findProjectRoot,
  hashProjectPath,
  getProjectIndexPath,
  GlobalRegistry,
  getPindexHome,
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

Dieses Projekt ist mit PindeX indexiert. **Immer** \`mcp__pindex__*\` Tools für Codebase-Exploration verwenden:

| Tool | Wann nutzen |
|---|---|
| \`mcp__pindex__get_file_summary\` | Datei-Überblick (Symbole, Imports, Exports) |
| \`mcp__pindex__search_symbols\` | Symbole / Funktionen suchen |
| \`mcp__pindex__get_symbol\` | Symbol-Details holen (Signatur, Ort, Dependencies) |
| \`mcp__pindex__get_context\` | Gezielten Zeilenbereich lesen (token-effizient) |
| \`mcp__pindex__find_usages\` | Alle Verwendungsstellen eines Symbols |
| \`mcp__pindex__get_dependencies\` | Import-Graph einer Datei |
| \`mcp__pindex__get_project_overview\` | Projektstruktur, Entry Points, Statistiken |

**Fallback:** Falls ein Tool \`null\` zurückgibt → \`Read\`/\`Grep\` als Fallback nutzen.
${CLAUDE_MD_MARKER}
`;

/**
 * Appends the PindeX section to the project's CLAUDE.md (or creates the file).
 * Idempotent: skips if the marker is already present.
 */
function injectClaudeMdSection(projectRoot: string): 'added' | 'skipped' | 'created' {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes(CLAUDE_MD_MARKER)) return 'skipped';
    appendFileSync(claudeMdPath, CLAUDE_MD_SECTION, 'utf-8');
    return 'added';
  } else {
    writeFileSync(claudeMdPath, `# CLAUDE.md\n${CLAUDE_MD_SECTION}`, 'utf-8');
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

  // Ensure the project's DB directory exists
  const dbDir = join(getPindexHome(), 'projects', entry.hash);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  writeMcpJson(projectRoot, entry);
  const claudeResult = injectClaudeMdSection(projectRoot);

  const relPath = '.mcp.json';
  const claudeStatus =
    claudeResult === 'created' ? 'created' :
    claudeResult === 'added'   ? 'section added' :
                                 'already present';
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║           PindeX – Ready                 ║');
  console.log('  ╚══════════════════════════════════════════╝\n');
  console.log(`  Project   : ${projectRoot}`);
  console.log(`  Index     : ~/.pindex/projects/${entry.hash}/index.db`);
  console.log(`  Port      : ${entry.monitoringPort}`);
  console.log(`  Config    : ${relPath} (written)`);
  console.log(`  CLAUDE.md : ${claudeStatus}\n`);
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
