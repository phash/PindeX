import path from 'node:path';
import { assignName } from './registry-name.js';

/**
 * Parses the FEDERATION_REPOS env value.
 * - A value starting with `[` is a JSON array of paths.
 * - Otherwise paths are separated by the OS path delimiter (`:` posix, `;` win32).
 *   On posix a legacy `,` separator is still accepted.
 * `delimiter` is injectable so both platforms can be tested anywhere.
 */
export function parseFederationRepos(value: string, delimiter: string = path.delimiter): string[] {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  const separators = delimiter === ':' ? /[:,]/ : new RegExp(`[${delimiter.replace(/[\\\]^-]/g, '\\$&')}]`);
  return trimmed
    .split(separators)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Formats paths for FEDERATION_REPOS using the OS path delimiter. Falls back to a
 * JSON array when a path itself contains the delimiter (unambiguous either way).
 */
export function formatFederationRepos(paths: string[], delimiter: string = path.delimiter): string {
  if (paths.some((p) => p.includes(delimiter))) return JSON.stringify(paths);
  return paths.join(delimiter);
}

interface NamedEntry {
  path: string;
  name: string;
  federatedRepos?: Array<{ path: string; name: string }>;
}

/**
 * Name of a federated repo inside the primary project's RepoSet:
 * the alias stored by `federate add --name`, else the target's registry name,
 * else an auto-generated unique name.
 */
export function resolveFederatedName(
  repoPath: string,
  primary: NamedEntry | undefined,
  allEntries: NamedEntry[],
  usedNames: Set<string>,
): string {
  const alias = primary?.federatedRepos?.find((f) => f.path === repoPath)?.name;
  if (alias && !usedNames.has(alias)) return alias;
  const registered = allEntries.find((e) => e.path === repoPath)?.name;
  if (registered && !usedNames.has(registered)) return registered;
  return assignName(repoPath, usedNames);
}
