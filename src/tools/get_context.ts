import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { GetContextInput, GetContextOutput } from '../types.js';
import { getFileByPath } from '../db/queries.js';
import { resolveWithinRoot } from '../util/paths.js';
import type { RepoSet } from '../federation/repo-set.js';

const DEFAULT_RANGE = 30;

/** Loads a specific line range from a file on disk.
 *  The DB is consulted only for the language – actual code is read live. */
export async function getContext(
  repoSet: RepoSet,
  input: GetContextInput,
): Promise<GetContextOutput[]> {
  const repos = repoSet.filter(input.repos);
  const out: GetContextOutput[] = [];

  for (const repo of repos) {
    const fileRecord = getFileByPath(repo.db, input.file);
    if (!fileRecord) continue;

    const absolutePath = resolveWithinRoot(repo.path, input.file);
    if (!absolutePath || !existsSync(absolutePath)) continue;

    const range = input.range ?? DEFAULT_RANGE;
    const targetLine = Math.max(1, input.line);
    const halfRange = Math.floor(range / 2);

    // Collect a buffer of ~2×range lines around the target (enough for boundary adjustment).
    // This avoids reading the entire file when only ~30 lines are needed.
    const collectStart = Math.max(1, targetLine - range);
    const collectEnd = targetLine + range;

    const rl = createInterface({ input: createReadStream(absolutePath, { encoding: 'utf-8' }) });
    const collected: string[] = [];
    let lineCount = 0;
    let hitEof = true;

    try {
      for await (const line of rl) {
        lineCount++;
        if (lineCount >= collectStart) {
          collected.push(line);
        }
        if (lineCount >= collectEnd) {
          hitEof = false;
          break;
        }
      }
    } finally {
      rl.close();
    }

    // If we didn't exhaust the file, there are more lines beyond collectEnd.
    // Use a large sentinel so endLine is not artificially capped.
    const effectiveTotal = hitEof ? lineCount : Infinity;

    let startLine = Math.max(1, targetLine - halfRange);
    let endLine = Math.min(effectiveTotal, startLine + range - 1);

    // Adjust if we hit the bottom boundary
    if (endLine - startLine < range - 1) {
      startLine = Math.max(1, endLine - range + 1);
    }

    const offset = startLine - collectStart;
    const selectedLines = collected.slice(offset, offset + (endLine - startLine + 1));
    const code = selectedLines.join('\n');

    out.push({
      code,
      language: fileRecord.language,
      startLine,
      endLine,
      project: repo.name,
    });
  }

  return out;
}
