import { delimiter } from 'node:path';

/**
 * `FEDERATION_REPOS` is a delimiter-separated list of absolute repo paths stored
 * in `.mcp.json`. We use the OS path delimiter (`:` on POSIX, `;` on Windows) —
 * the same convention as `PATH` — because a plain `:` collides with the colon in
 * Windows drive letters (`C:\...`), which silently corrupts every path on
 * Windows. On POSIX the delimiter stays `:`, so existing values keep working
 * with no migration.
 *
 * Read side additionally accepts a comma as a separator for backward
 * compatibility with hand-edited values.
 */

/** Parses a `FEDERATION_REPOS` env value into a list of absolute paths. */
export function parseFederationRepos(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Serialises a list of absolute paths into a `FEDERATION_REPOS` env value. */
export function joinFederationRepos(paths: string[]): string {
  return paths.join(delimiter);
}
