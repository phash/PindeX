import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

type McpJson = { mcpServers?: Record<string, McpServerEntry> } & Record<string, unknown>;

/** Directory holding the compiled output (dist/). Falls back to ../dist when run from src/. */
function distRoot(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return basename(root) === 'src' ? join(root, '..', 'dist') : root;
}

/**
 * Absolute `node` + absolute script path, so the spawned command does not depend on PATH.
 * `scriptRelativeToDist` is relative to the dist/ directory, e.g. `index.js`.
 */
export function nodeScriptCommand(scriptRelativeToDist: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [resolve(distRoot(), scriptRelativeToDist)] };
}

/** Command that starts the MCP stdio server (dist/index.js). */
export function serverCommand(): { command: string; args: string[] } {
  return nodeScriptCommand('index.js');
}

/** Reads and parses `.mcp.json`. Returns null if missing; throws a clear error if invalid (file untouched). */
export function readMcpJson(projectRoot: string): McpJson | null {
  const path = join(projectRoot, '.mcp.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value is not an object');
    }
    return parsed as McpJson;
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${(err as Error).message}). Fix or remove it manually; PindeX will not overwrite it.`,
    );
  }
}

/**
 * Sets (or with null removes) the `pindex` server in `.mcp.json`, preserving all other
 * servers and top-level keys. The file is deleted only if nothing else remains.
 */
export function mergeMcpServer(
  projectRoot: string,
  name: 'pindex',
  server: McpServerEntry | null,
): void {
  const path = join(projectRoot, '.mcp.json');
  const config = readMcpJson(projectRoot) ?? {};
  const servers = { ...(config.mcpServers ?? {}) };

  if (server === null) {
    if (!existsSync(path)) return;
    delete servers[name];
  } else {
    servers[name] = server;
  }

  const next: McpJson = { ...config, mcpServers: servers };
  if (Object.keys(servers).length === 0) {
    delete next.mcpServers;
    if (Object.keys(next).length === 0) {
      unlinkSync(path);
      return;
    }
  }
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}
