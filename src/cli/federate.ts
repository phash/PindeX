import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  GlobalRegistry,
  findProjectRoot,
  type RegistryEntry,
  type FederatedRegistryEntry,
} from './project-detector.js';
import { readMcpJson, mergeMcpServer, type McpServerEntry } from './mcp-json.js';
import { assignName } from '../federation/registry-name.js';
import { parseFederationRepos, formatFederationRepos } from '../federation/env.js';

function readPindexServer(projectRoot: string): McpServerEntry {
  const mcp = readMcpJson(projectRoot);
  if (!mcp) {
    throw new Error(
      `.mcp.json not found at ${join(projectRoot, '.mcp.json')}. Run 'pindex init' first.`,
    );
  }
  const server: McpServerEntry = mcp.mcpServers?.pindex ?? {};
  server.env = server.env ?? {};
  return server;
}

export async function federateAdd(
  cwd: string,
  targetPath: string,
  options: { name?: string },
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
  if (!existsSync(join(targetRoot, '.mcp.json'))) {
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

  const updated: RegistryEntry = {
    ...me,
    federatedRepos: [...existingFederated, { path: targetRoot, name }],
  };
  registry.replace(updated);

  const server = readPindexServer(projectRoot);
  const env = server.env!;
  const list = parseFederationRepos(env.FEDERATION_REPOS);
  if (!list.includes(targetRoot)) list.push(targetRoot);
  env.FEDERATION_REPOS = formatFederationRepos(list);
  mergeMcpServer(projectRoot, 'pindex', server);

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

  const updated: RegistryEntry = {
    ...me,
    federatedRepos: existingFederated.filter((f) => f !== match),
  };
  registry.replace(updated);

  const server = readPindexServer(projectRoot);
  const env = server.env!;
  const list = parseFederationRepos(env.FEDERATION_REPOS).filter((p) => p !== match.path);
  if (list.length > 0) {
    env.FEDERATION_REPOS = formatFederationRepos(list);
  } else {
    delete env.FEDERATION_REPOS;
  }
  mergeMcpServer(projectRoot, 'pindex', server);

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
