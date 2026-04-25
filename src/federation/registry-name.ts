import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/** Returns a stable, unique name for a federated repo path.
 *  - First choice: basename(path) (e.g. /home/me/auth → "auth")
 *  - On collision: basename + "-" + first 4 hex of sha256(path)
 *  - On second collision: basename + "-" + first 8 hex */
export function assignName(path: string, existingNames: Set<string>): string {
  const base = basename(path.replace(/\/+$/, ''));
  if (!existingNames.has(base)) return base;

  const hash = createHash('sha256').update(path).digest('hex');
  const short = `${base}-${hash.slice(0, 4)}`;
  if (!existingNames.has(short)) return short;

  return `${base}-${hash.slice(0, 8)}`;
}
