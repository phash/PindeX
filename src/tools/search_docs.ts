import type Database from 'better-sqlite3';
import type { SearchDocsInput, DocSearchResult } from '../types.js';
import { searchDocumentsFts, searchContextEntriesFts } from '../db/queries.js';

const PREVIEW_LENGTH = 200;

function preview(content: string): string {
  const trimmed = content.trim();
  return trimmed.length <= PREVIEW_LENGTH
    ? trimmed
    : trimmed.substring(0, PREVIEW_LENGTH) + '…';
}

export function searchDocs(
  db: Database.Database,
  input: SearchDocsInput,
): DocSearchResult[] {
  const { query, limit = 20, type = 'all' } = input;
  const results: DocSearchResult[] = [];

  if (type === 'docs' || type === 'all') {
    const docLimit = type === 'all' ? Math.ceil(limit * 0.7) : limit;
    const docRows = searchDocumentsFts(db, query, docLimit);
    for (const row of docRows) {
      results.push({
        type: 'doc',
        id: row.id,
        content_preview: preview(row.content),
        file: row.file_path,
        heading: row.heading,
        start_line: row.start_line,
      });
    }
  }

  if (type === 'context' || type === 'all') {
    const ctxLimit = type === 'all' ? Math.ceil(limit * 0.3) : limit;
    const ctxRows = searchContextEntriesFts(db, query, ctxLimit);
    for (const row of ctxRows) {
      results.push({
        type: 'context',
        id: row.id,
        content_preview: preview(row.content),
        tags: row.tags,
        session_id: row.session_id,
        created_at: row.created_at,
      });
    }
  }

  return results.slice(0, limit);
}
