import type { GetDocChunkInput, GetDocChunkOutput, DocChunk } from '../types.js';
import { getFileByPath, getDocumentChunksByFileId } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';
import { resolveWithinRoot } from '../util/paths.js';

export function getDocChunk(repoSet: RepoSet, input: GetDocChunkInput): GetDocChunkOutput[] {
  const repos = repoSet.filter(input.repos);
  const out: GetDocChunkOutput[] = [];

  for (const repo of repos) {
    if (repo.path && !resolveWithinRoot(repo.path, input.file)) continue;

    const fileRecord = getFileByPath(repo.db, input.file);
    if (!fileRecord) continue;

    const allChunks = getDocumentChunksByFileId(repo.db, fileRecord.id);
    if (allChunks.length === 0) continue;

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

    out.push({
      file: input.file,
      total_chunks: allChunks.length,
      chunks,
      project: repo.name,
    });
  }

  return out;
}
