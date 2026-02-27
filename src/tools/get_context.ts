import { readFileSync, existsSync } from 'node:fs';
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

  const content = readFileSync(absolutePath, 'utf-8');
  const allLines = content.split('\n');
  const totalLines = allLines.length;

  const range = input.range ?? DEFAULT_RANGE;
  const targetLine = Math.max(1, input.line);

  // Compute the window: [startLine, endLine] (1-indexed, inclusive)
  const halfRange = Math.floor(range / 2);
  let startLine = Math.max(1, targetLine - halfRange);
  let endLine = Math.min(totalLines, startLine + range - 1);

  // Adjust if we hit the bottom boundary
  if (endLine - startLine < range - 1) {
    startLine = Math.max(1, endLine - range + 1);
  }

  const selectedLines = allLines.slice(startLine - 1, endLine);
  const code = selectedLines.join('\n');

  return {
    code,
    language: fileRecord.language,
    startLine,
    endLine,
  };
}
