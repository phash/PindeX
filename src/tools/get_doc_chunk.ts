import type Database from 'better-sqlite3';
import type { GetDocChunkInput, GetDocChunkOutput, DocChunk } from '../types.js';
import { getFileByPath, getDocumentChunksByFileId } from '../db/queries.js';

export function getDocChunk(
  db: Database.Database,
  input: GetDocChunkInput,
): GetDocChunkOutput | null {
  const fileRecord = getFileByPath(db, input.file);
  if (!fileRecord) return null;

  const allChunks = getDocumentChunksByFileId(db, fileRecord.id);
  if (allChunks.length === 0) return null;

  const chunks: DocChunk[] =
    input.chunk_index !== undefined
      ? allChunks
          .filter((c) => c.chunk_index === input.chunk_index)
          .map((c) => ({
            index: c.chunk_index,
            heading: c.heading,
            start_line: c.start_line,
            end_line: c.end_line,
            content: c.content,
          }))
      : allChunks.map((c) => ({
          index: c.chunk_index,
          heading: c.heading,
          start_line: c.start_line,
          end_line: c.end_line,
          content: c.content,
        }));

  return {
    file: input.file,
    total_chunks: allChunks.length,
    chunks,
  };
}
