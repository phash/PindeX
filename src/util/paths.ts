import { resolve, sep } from 'node:path';

/**
 * Resolves `relative` against `projectRoot` and returns the absolute path
 * ONLY if it stays within the root. Prevents path traversal attacks via
 * tainted tool inputs (e.g. `file: "../../etc/passwd"`).
 *
 * Returns `null` when the resolved path escapes `projectRoot`.
 */
export function resolveWithinRoot(projectRoot: string, relative: string): string | null {
  const normalizedRoot = resolve(projectRoot);
  const candidate = resolve(normalizedRoot, relative);
  if (candidate === normalizedRoot) return candidate;
  if (candidate.startsWith(normalizedRoot + sep)) return candidate;
  return null;
}
