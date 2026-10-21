import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  GlobalRegistry,
  findProjectRoot,
  type RegistryEntry,
  type FederatedRegistryEntry,
} from './project-detector.js';
import { readMcpJson } from './mcp-json.js';
import { writeMcpJson } from './init.js';
import { assignName } from '../federation/registry-name.js';

/** Throws unless the project has a (valid) .mcp.json. */
function requireMcpJson(projectRoot: string): void {
  if (!readMcpJson(projectRoot)) {
    throw new Error(
      `.mcp.json not found at ${join(projectRoot, '.mcp.json')}. Run 'pindex init' first.`,
    );
  }
}

export async function federateAdd(
  cwd: string,
  targetPath: string,
  options: { name?: string; autoRegister?: boolean },
): Promise<void> {
  const projectRoot = findProjectRoot(resolve(cwd));
  const targetRoot = resolve(targetPath);

  if (!existsSync(targetRoot)) {
    throw new Error(`Target path does not exist: ${targetRoot}`);
  }

  if (targetRoot === projectRoot) {
    throw new Error('Cannot federate the current project with itself.');
  }

  const registry = new GlobalRegistry();
  if (options.autoRegister) {
    // `pindex add` convenience: register both projects and make sure a pindex
    // server entry exists in the current project's .mcp.json.
    registry.upsert(targetRoot);
    const mine = registry.upsert(projectRoot);
    if (!readMcpJson(projectRoot)?.mcpServers?.pindex) writeMcpJson(projectRoot, mine);
  }
  const entries = registry.list();

  const me = entries.find((e) => e.path === projectRoot);
  if (!me) {
    throw new Error(`Current project not registered: ${projectRoot}. Run 'pindex init'.`);
  }

  const target = entries.find((e) => e.path === targetRoot);
  if (!target) {
    throw new Error(
      `Target not registered: ${targetRoot}. Run 'pindex init' in that directory first.`,
    );
  }

  // Check .mcp.json exists in target (validates it was pindex-init-ed)
  if (!options.autoRegister && !existsSync(join(targetRoot, '.mcp.json'))) {
    throw new Error(
      `Target has no .mcp.json: ${targetRoot}. Run 'pindex init' in that directory first.`,
    );
  }

  const existingFederated = (me.federatedRepos ?? []) as FederatedRegistryEntry[];
  if (existingFederated.some((f) => f.path === targetRoot)) {
    console.log(`Already federated: ${target.name} (${targetRoot})`);
    return;
  }

  // Allocate a unique name within MY federation set (including my own name).
  const used = new Set<string>([me.name, ...existingFederated.map((f) => f.name)]);
  const name =
    options.name ??
    (used.has(target.name) ? assignName(targetRoot, used) : target.name);
  if (options.name && used.has(options.name)) {
    throw new Error(`Name '${options.name}' already in use in this federation. Provide a different --name.`);
  }

  requireMcpJson(projectRoot);
  const updated: RegistryEntry = {
    ...me,
    federatedRepos: [...existingFederated, { path: targetRoot, name }],
  };
  registry.replace(updated);
  // Rebuild the whole pindex entry (command, allowlisted env, FEDERATION_REPOS from the
  // registry) instead of re-persisting what a repo-shipped .mcp.json contained.
  writeMcpJson(projectRoot, updated);

  console.log(
    `federated '${name}' (path: ${targetRoot}). Restart the MCP server to pick up the change.`,
  );
}

export async function federateRemove(cwd: string, nameOrPath: string): Promise<void> {
  const projectRoot = findProjectRoot(resolve(cwd));
  const registry = new GlobalRegistry();
  const me = registry.list().find((e) => e.path === projectRoot);
  if (!me) {
    throw new Error(`Current project not registered: ${projectRoot}.`);
  }

  const existingFederated = (me.federatedRepos ?? []) as FederatedRegistryEntry[];
  const match = existingFederated.find(
    (f) => f.name === nameOrPath || f.path === nameOrPath || f.path === resolve(nameOrPath),
  );
  if (!match) {
    const known = existingFederated.map((f) => f.name).join(', ');
    throw new Error(
      `No federated repo named '${nameOrPath}' (or matching path). Known: [${known}]`,
    );
  }

  requireMcpJson(projectRoot);
  const updated: RegistryEntry = {
    ...me,
    federatedRepos: existingFederated.filter((f) => f !== match),
  };
  registry.replace(updated);
  writeMcpJson(projectRoot, updated);

  console.log(`removed federation '${match.name}' (${match.path}). Restart the MCP server.`);
}

export async function federateList(cwd: string): Promise<void> {
  const projectRoot = findProjectRoot(resolve(cwd));
  const registry = new GlobalRegistry();
  const me = registry.list().find((e) => e.path === projectRoot);
  if (!me) {
    console.log(`Current project not registered: ${projectRoot}.`);
    return;
  }

  const existingFederated = (me.federatedRepos ?? []) as FederatedRegistryEntry[];
  console.log(`Federated repos (in ${projectRoot}):`);
  if (existingFederated.length === 0) {
    console.log(`  (none)`);
    return;
  }
  const longestName = existingFederated.reduce((m, f) => Math.max(m, f.name.length), 0);
  for (const f of existingFederated) {
    console.log(`  ${f.name.padEnd(longestName)} ${f.path}`);
  }
}
