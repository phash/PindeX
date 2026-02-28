import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';

/** Returns the global ~/.pindex directory (migrates from ~/.mcp-indexer if present). */
export function getPindexHome(): string {
  const newHome = join(homedir(), '.pindex');
  const oldHome = join(homedir(), '.mcp-indexer');
  if (!existsSync(newHome) && existsSync(oldHome)) {
    try {
      renameSync(oldHome, newHome);
    } catch {
      // If rename fails (e.g. cross-device), just use the new path
    }
  }
  return newHome;
}

/** @deprecated Use getPindexHome() */
export function getMcpIndexerHome(): string {
  return getPindexHome();
}

/** Returns the projects directory within ~/.pindex. */
export function getProjectsDir(): string {
  return join(getPindexHome(), 'projects');
}

/** Returns a deterministic hash for a project path (used as its directory name). */
export function hashProjectPath(projectPath: string): string {
  const normalized = resolve(projectPath);
  return createHash('sha256').update(normalized).digest('hex').substring(0, 8);
}

/** Returns the index DB path for a given project (stored locally in {projectPath}/.pindex/). */
export function getProjectIndexPath(projectPath: string): string {
  return join(resolve(projectPath), '.pindex', 'index.db');
}

/** Returns the meta JSON path for a given project (stored locally in {projectPath}/.pindex/). */
export function getProjectMetaPath(projectPath: string): string {
  return join(resolve(projectPath), '.pindex', 'meta.json');
}

export interface ProjectMeta {
  path: string;
  lastIndexed: string | null;
  hash: string;
}

/**
 * Walks upward from startDir looking for common project root markers.
 * Returns the directory containing the first marker found, or startDir if none.
 */
export function findProjectRoot(startDir: string): string {
  const markers = ['package.json', '.git', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml'];
  let current = resolve(startDir);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) break; // filesystem root reached
    current = parent;
  }
  return resolve(startDir);
}

/** A deterministic monitoring port for a project, stored in registry to stay stable. */
function computeDefaultPort(hash: string): number {
  return 7842 + (parseInt(hash.slice(0, 4), 16) % 2000);
}

// ─── Global Registry ───────────────────────────────────────────────────────

export interface RegistryEntry {
  path: string;
  hash: string;
  name: string;
  monitoringPort: number;
  federatedRepos: string[];
  addedAt: string;
}

interface RegistryFile {
  version: number;
  projects: RegistryEntry[];
}

export class GlobalRegistry {
  private readonly registryPath: string;

  constructor() {
    this.registryPath = join(getPindexHome(), 'registry.json');
  }

  read(): RegistryEntry[] {
    if (!existsSync(this.registryPath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.registryPath, 'utf-8')) as RegistryFile;
      return data.projects ?? [];
    } catch {
      return [];
    }
  }

  private write(entries: RegistryEntry[]): void {
    const home = getPindexHome();
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    const data: RegistryFile = { version: 1, projects: entries };
    writeFileSync(this.registryPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Add or update a project entry. Returns the (possibly newly assigned) entry. */
  upsert(projectPath: string, extra?: Partial<RegistryEntry>): RegistryEntry {
    const normalizedPath = resolve(projectPath);
    const hash = hashProjectPath(normalizedPath);
    const projects = this.read();
    const existingIdx = projects.findIndex((p) => p.hash === hash);

    if (existingIdx !== -1) {
      const updated = { ...projects[existingIdx], ...extra };
      projects[existingIdx] = updated;
      this.write(projects);
      return updated;
    }

    // Assign a port that isn't already used by another project
    const usedPorts = new Set(projects.map((p) => p.monitoringPort));
    let port = computeDefaultPort(hash);
    while (usedPorts.has(port)) port++;

    const name = normalizedPath.split('/').pop() ?? normalizedPath;
    const entry: RegistryEntry = {
      path: normalizedPath,
      hash,
      name,
      monitoringPort: port,
      federatedRepos: [],
      addedAt: new Date().toISOString(),
      ...extra,
    };
    projects.push(entry);
    this.write(projects);
    return entry;
  }

  /** Update the federated repos list for a project. */
  setFederatedRepos(projectPath: string, repos: string[]): void {
    const hash = hashProjectPath(resolve(projectPath));
    const projects = this.read();
    const idx = projects.findIndex((p) => p.hash === hash);
    if (idx !== -1) {
      projects[idx].federatedRepos = repos;
      this.write(projects);
    }
  }

  remove(projectPath: string): void {
    const hash = hashProjectPath(resolve(projectPath));
    const projects = this.read().filter((p) => p.hash !== hash);
    this.write(projects);
  }

  list(): RegistryEntry[] {
    return this.read();
  }

  getByPath(projectPath: string): RegistryEntry | undefined {
    const hash = hashProjectPath(resolve(projectPath));
    return this.read().find((p) => p.hash === hash);
  }
}
