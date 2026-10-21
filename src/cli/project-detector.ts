import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync,
  openSync, closeSync, unlinkSync, statSync,
} from 'node:fs';
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

/** Returns the projects directory within ~/.pindex. */
export function getProjectsDir(): string {
  return join(getPindexHome(), 'projects');
}

/** Creates ~/.pindex with owner-only (0700) perms and tightens it if it already
 *  exists, so registry/config/PID files are not world-readable on a shared host
 *  (SEC-13). Best-effort: chmod failures (e.g. on Windows) are ignored. */
export function ensurePindexHome(): string {
  const home = getPindexHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(home, 0o700); } catch { /* best-effort */ }
  }
  return home;
}

/** Writes a file with owner-only (0600) permissions, tightening any pre-existing
 *  file too (writeFileSync's `mode` only applies on creation). SEC-13/SEC-14. */
export function writeFileSecure(path: string, data: string): void {
  writeFileSync(path, data, { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
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

/** Default port of the aggregated dashboard (`pindex gui`); outside the per-project range (>= 7842). */
export const GUI_DEFAULT_PORT = 7841;

/** GUI fallback ports when the preferred one is busy: below 7841, so they never collide with
 *  per-project monitoring ports (7842+). Tried in descending order. */
export const GUI_FALLBACK_PORTS = [7840, 7839, 7838, 7837, 7836] as const;

/** Ports the GUI tries in order: the preferred port, then the fallback range (without duplicates). */
export function guiPortCandidates(preferred: number): number[] {
  return [preferred, ...GUI_FALLBACK_PORTS.filter((p) => p !== preferred)];
}

/** A deterministic monitoring port for a project, stored in registry to stay stable. Never GUI_DEFAULT_PORT. */
export function computeDefaultPort(hash: string): number {
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

export class RegistryCorruptError extends Error {
  constructor(path: string, cause: unknown) {
    super(`registry file ${path} is corrupt and was left untouched: ${String(cause)}`);
    this.name = 'RegistryCorruptError';
  }
}

export class RegistryLockError extends Error {
  constructor(lockPath: string) {
    super(`could not acquire registry lock ${lockPath}`);
    this.name = 'RegistryLockError';
  }
}

export interface GlobalRegistryOptions {
  /** Lock acquisition attempts before giving up (default 50). */
  lockRetries?: number;
  /** Delay between lock attempts in ms (default 20). */
  lockRetryDelayMs?: number;
}

const STALE_LOCK_MS = 5000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes via `<path>.<pid>.tmp` + rename so readers never see a truncated file. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSecure(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

export class GlobalRegistry {
  private readonly registryPath: string;
  private readonly lockPath: string;
  private readonly lockRetries: number;
  private readonly lockRetryDelayMs: number;

  constructor(opts: GlobalRegistryOptions = {}) {
    this.registryPath = join(getPindexHome(), 'registry.json');
    this.lockPath = `${this.registryPath}.lock`;
    this.lockRetries = opts.lockRetries ?? 50;
    this.lockRetryDelayMs = opts.lockRetryDelayMs ?? 20;
  }

  /** Parses + normalises the registry. Side-effect free. Missing file -> []. Corrupt -> throws. */
  private load(): RegistryEntry[] {
    if (!existsSync(this.registryPath)) return [];
    let parsed: RegistryFile;
    try {
      parsed = JSON.parse(readFileSync(this.registryPath, 'utf-8')) as RegistryFile;
    } catch (err) {
      throw new RegistryCorruptError(this.registryPath, err);
    }
    const projects = parsed.projects ?? [];

    // Migration (in memory only; persisted by the next locked mutation).
    const usedNames = new Set<string>(
      projects.map((p) => p.name).filter((n): n is string => Boolean(n)),
    );
    for (const p of projects) {
      if (!p.name) {
        p.name = assignName(p.path, usedNames);
        usedNames.add(p.name);
      }
      // Normalise old string[] federatedRepos to FederatedRegistryEntry[]
      if (Array.isArray(p.federatedRepos)) {
        const normalised: FederatedRegistryEntry[] = [];
        for (const item of p.federatedRepos as unknown[]) {
          if (typeof item === 'string') {
            const targetEntry = projects.find((q) => q.path === item);
            const name = targetEntry?.name ?? (item.split('/').pop() || 'federated');
            normalised.push({ path: item, name });
          } else if (item && typeof item === 'object' && 'path' in item && 'name' in item) {
            normalised.push(item as FederatedRegistryEntry);
          }
        }
        p.federatedRepos = normalised;
      }
    }
    return projects;
  }

  /** Side-effect free read for display; a corrupt file yields [] (mutations refuse instead). */
  read(): RegistryEntry[] {
    try {
      return this.load();
    } catch (err) {
      process.stderr.write(`[pindex] registry: ${(err as Error).message}\n`);
      return [];
    }
  }

  private acquireLock(): void {
    ensurePindexHome();
    for (let attempt = 0; attempt < this.lockRetries; attempt++) {
      try {
        closeSync(openSync(this.lockPath, 'wx', 0o600));
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS) {
            // Known race: two waiters may both judge the same lock stale; one can then
            // unlink the lock the other just re-created. Accepted: needs a >5 s dead holder
            // plus simultaneous takeover, and writes stay atomic (rename) regardless.
            unlinkSync(this.lockPath);
            continue;
          }
        } catch { /* lock vanished between calls: retry immediately */ continue; }
        sleepSync(this.lockRetryDelayMs);
      }
    }
    throw new RegistryLockError(this.lockPath);
  }

  /** Runs fn on a fresh, locked read; writes atomically if fn returns a new list. */
  private mutate<T>(fn: (projects: RegistryEntry[]) => { next: RegistryEntry[]; result: T }): T {
    this.acquireLock();
    try {
      const { next, result } = fn(this.load());
      const data: RegistryFile = { version: 1, projects: next };
      writeAtomic(this.registryPath, JSON.stringify(data, null, 2));
      return result;
    } finally {
      try { unlinkSync(this.lockPath); } catch { /* best-effort */ }
    }
  }

  /** Add or update a project entry. Returns the (possibly newly assigned) entry. */
  upsert(projectPath: string, extra?: Partial<RegistryEntry>): RegistryEntry {
    const normalizedPath = resolve(projectPath);
    const hash = hashProjectPath(normalizedPath);
    return this.mutate((projects) => {
      const existingIdx = projects.findIndex((p) => p.hash === hash);
      if (existingIdx !== -1) {
        const updated = { ...projects[existingIdx], ...extra };
        projects[existingIdx] = updated;
        return { next: projects, result: updated };
      }

      // Assign a port that isn't already used by another project
      const usedPorts = new Set(projects.map((p) => p.monitoringPort));
      let port = computeDefaultPort(hash);
      while (usedPorts.has(port)) port++;

      const usedNames = new Set(projects.map((e) => e.name).filter((n): n is string => Boolean(n)));
      const entry: RegistryEntry = {
        path: normalizedPath,
        hash,
        name: assignName(normalizedPath, usedNames),
        monitoringPort: port,
        federatedRepos: [] as FederatedRegistryEntry[],
        addedAt: new Date().toISOString(),
        ...extra,
      };
      return { next: [...projects, entry], result: entry };
    });
  }

  /** Update the federated repos list for a project (structured entries). */
  setFederatedRepos(projectPath: string, repos: FederatedRegistryEntry[]): void {
    const hash = hashProjectPath(resolve(projectPath));
    this.mutate((projects) => {
      const idx = projects.findIndex((p) => p.hash === hash);
      if (idx !== -1) projects[idx].federatedRepos = repos;
      return { next: projects, result: undefined };
    });
  }

  /** Overwrite the registry entry matching entry.path. Inserts if not present. */
  replace(entry: RegistryEntry): void {
    this.mutate((all) => {
      const idx = all.findIndex((e) => e.path === entry.path);
      const next = [...all];
      if (idx === -1) next.push(entry);
      else next[idx] = entry;
      return { next, result: undefined };
    });
  }

  remove(projectPath: string): void {
    const hash = hashProjectPath(resolve(projectPath));
    this.mutate((projects) => ({ next: projects.filter((p) => p.hash !== hash), result: undefined }));
  }

  list(): RegistryEntry[] {
    return this.read();
  }

  getByPath(projectPath: string): RegistryEntry | undefined {
    const hash = hashProjectPath(resolve(projectPath));
    return this.read().find((p) => p.hash === hash);
  }
}
