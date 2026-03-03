import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { GetContextInput, GetContextOutput } from '../types.js';
import { getFileByPath } from '../db/queries.js';

const DEFAULT_RANGE = 30;

/** Loads a specific line range from a file on disk.
 *  The DB is consulted only for the language – actual code is read live. */
export async function getContext(
  db: Database.Database,
  projectRoot: string,
  input: GetContextInput,
): Promise<GetContextOutput | null> {
  const fileRecord = getFileByPath(db, input.file);
  if (!fileRecord) return null;

  const absolutePath = join(projectRoot, input.file);
  if (!existsSync(absolutePath)) return null;

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

  return {
    code,
    language: fileRecord.language,
    startLine,
    endLine,
  };
}
