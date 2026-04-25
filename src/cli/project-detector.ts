import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { assignName } from '../federation/registry-name.js';

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

export interface FederatedRegistryEntry {
  path: string;
  name: string;
}

export interface RegistryEntry {
  path: string;
  hash: string;
  name: string;
  monitoringPort: number;
  federatedRepos: FederatedRegistryEntry[];
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
    let parsed: RegistryFile;
    try {
      parsed = JSON.parse(readFileSync(this.registryPath, 'utf-8')) as RegistryFile;
    } catch (err) {
      process.stderr.write(`[pindex] registry: failed to parse ${this.registryPath}: ${String(err)}\n`);
      return [];
    }
    const projects = parsed.projects ?? [];

    // Migration: assign name to any entry that lacks one.
    let migrated = false;
    const usedNames = new Set<string>(
      projects.map((p) => p.name).filter((n): n is string => Boolean(n)),
    );
    for (const p of projects) {
      if (!p.name) {
        p.name = assignName(p.path, usedNames);
        usedNames.add(p.name);
        migrated = true;
      }
      // Migration: normalise old string[] federatedRepos to FederatedRegistryEntry[]
      if (Array.isArray(p.federatedRepos)) {
        const normalised: FederatedRegistryEntry[] = [];
        for (const item of p.federatedRepos as unknown[]) {
          if (typeof item === 'string') {
            // Old shape: just a path. Resolve a name from the global registry,
            // or auto-name if the target isn't itself registered.
            const targetEntry = projects.find((q) => q.path === item);
            const name = targetEntry?.name ?? (item.split('/').pop() || 'federated');
            normalised.push({ path: item, name });
            migrated = true;
          } else if (item && typeof item === 'object' && 'path' in item && 'name' in item) {
            normalised.push(item as FederatedRegistryEntry);
          }
        }
        p.federatedRepos = normalised;
      }
    }
    if (migrated) {
      this.write(projects);
    }
    return projects;
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

    const usedNames = new Set(projects.map((e) => e.name).filter((n): n is string => Boolean(n)));
    const name = assignName(normalizedPath, usedNames);
    const entry: RegistryEntry = {
      path: normalizedPath,
      hash,
      name,
      monitoringPort: port,
      federatedRepos: [] as FederatedRegistryEntry[],
      addedAt: new Date().toISOString(),
      ...extra,
    };
    projects.push(entry);
    this.write(projects);
    return entry;
  }

  /** Update the federated repos list for a project (structured entries). */
  setFederatedRepos(projectPath: string, repos: FederatedRegistryEntry[]): void {
    const hash = hashProjectPath(resolve(projectPath));
    const projects = this.read();
    const idx = projects.findIndex((p) => p.hash === hash);
    if (idx !== -1) {
      projects[idx].federatedRepos = repos;
      this.write(projects);
    }
  }

  /** Overwrite the registry entry matching entry.path. Inserts if not present. */
  replace(entry: RegistryEntry): void {
    const all = this.read();
    const idx = all.findIndex((e) => e.path === entry.path);
    if (idx === -1) {
      this.write([...all, entry]);
    } else {
      const next = [...all];
      next[idx] = entry;
      this.write(next);
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
