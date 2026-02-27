import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Returns the global ~/.mcp-indexer directory. */
export function getMcpIndexerHome(): string {
  return join(homedir(), '.mcp-indexer');
}

/** Returns the projects directory within ~/.mcp-indexer. */
export function getProjectsDir(): string {
  return join(getMcpIndexerHome(), 'projects');
}

/** Returns a deterministic hash for a project path (used as its directory name). */
export function hashProjectPath(projectPath: string): string {
  const normalized = resolve(projectPath);
  return createHash('sha256').update(normalized).digest('hex').substring(0, 8);
}

/** Returns the index DB path for a given project. */
export function getProjectIndexPath(projectPath: string): string {
  const hash = hashProjectPath(projectPath);
  return join(getProjectsDir(), hash, 'index.db');
}

/** Returns the meta JSON path for a given project. */
export function getProjectMetaPath(projectPath: string): string {
  const hash = hashProjectPath(projectPath);
  return join(getProjectsDir(), hash, 'meta.json');
}

export interface ProjectMeta {
  path: string;
  lastIndexed: string | null;
  hash: string;
}
