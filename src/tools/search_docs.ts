import type { SearchDocsInput, DocSearchResult } from '../types.js';
import { searchDocumentsFts, searchContextEntriesFts } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';
import { dedupByKey } from '../federation/merge.js';

const PREVIEW_LENGTH = 200;

function preview(content: string): string {
  const trimmed = content.trim();
  return trimmed.length <= PREVIEW_LENGTH
    ? trimmed
    : trimmed.substring(0, PREVIEW_LENGTH) + '…';
}

export function searchDocs(repoSet: RepoSet, input: SearchDocsInput): DocSearchResult[] {
  const { query, limit = 20, type = 'all' } = input;
  const repos = repoSet.filter(input.repos);
  const all: DocSearchResult[] = [];

  for (const repo of repos) {
    try {
      if (type === 'docs' || type === 'all') {
        const docLimit = type === 'all' ? Math.ceil(limit * 0.7) : limit;
        const docRows = searchDocumentsFts(repo.db, query, docLimit);
        for (const row of docRows) {
          all.push({
            type: 'doc',
            id: row.id,
            content_preview: preview(row.content),
            project: repo.name,
            file: row.file_path,
            heading: row.heading,
            start_line: row.start_line,
          });
        }
      }

      if (type === 'context' || type === 'all') {
        const ctxLimit = type === 'all' ? Math.ceil(limit * 0.3) : limit;
        const ctxRows = searchContextEntriesFts(repo.db, query, ctxLimit);
        for (const row of ctxRows) {
          all.push({
            type: 'context',
            id: row.id,
            content_preview: preview(row.content),
            project: repo.name,
            tags: row.tags,
            session_id: row.session_id,
            created_at: row.created_at,
          });
        }
      }
    } catch (err) {
      process.stderr.write(
        `[pindex] search_docs failed for repo '${repo.name}': ${String(err)}\n`,
      );
    }
  }

  const deduped = dedupByKey(
    all,
    (r) => `${r.project}::${r.file ?? r.id}::${r.start_line ?? r.created_at ?? ''}`,
  );
  return deduped.slice(0, limit * Math.max(repos.length, 1));
}
