import {
  findProjectRoot,
  getProjectIndexPath,
  GlobalRegistry,
  type RegistryEntry,
} from './cli/project-detector.js';
import { detectProjectLanguages } from './indexer/detect-languages.js';
import { parseFederationRepos } from './federation/repos-env.js';

export interface ServerConfig {
  projectRoot: string;
  indexPath: string;
  monitoringPort: number;
  languages: string[];
  federationRepos: string[];
}

/**
 * Resolves the server's runtime configuration. Explicit environment variables
 * always win; anything not set is derived from the project root and the global
 * registry. When the project isn't registered yet (e.g. the server was launched
 * as a zero-config Claude Code plugin), it is self-registered so the CLI and the
 * aggregated GUI discover it, and it uses the same index path / port a
 * `pindex init` would have assigned. Registry access is best-effort and never
 * blocks startup.
 */
export async function resolveServerConfig(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ServerConfig> {
  const projectRoot = env.PROJECT_ROOT ?? findProjectRoot(cwd);

  let entry: RegistryEntry | undefined;
  try {
    const registry = new GlobalRegistry();
    entry = registry.getByPath(projectRoot) ?? registry.upsert(projectRoot);
  } catch (err) {
    process.stderr.write(`[pindex] registry self-register skipped: ${String(err)}\n`);
  }

  const root = entry?.path ?? projectRoot;

  const indexPath = env.INDEX_PATH ?? getProjectIndexPath(root);

  const monitoringPort = env.MONITORING_PORT
    ? parseInt(env.MONITORING_PORT, 10)
    : entry?.monitoringPort ?? 7842;

  const languages = env.LANGUAGES
    ? env.LANGUAGES.split(',').map((s) => s.trim()).filter(Boolean)
    : await detectProjectLanguages(root);

  const federationRepos = env.FEDERATION_REPOS
    ? parseFederationRepos(env.FEDERATION_REPOS)
    : entry?.federatedRepos.map((r) => r.path) ?? [];

  return { projectRoot: root, indexPath, monitoringPort, languages, federationRepos };
}
