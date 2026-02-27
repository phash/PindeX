import type Database from 'better-sqlite3';
import type { ReindexInput, ReindexOutput } from '../types.js';
import type { Indexer } from '../indexer/index.js';

export async function reindex(
  _db: Database.Database,
  indexer: Indexer,
  input: ReindexInput,
): Promise<ReindexOutput> {
  if (input.target) {
    // Re-index a specific file (force=true to bypass hash check)
    const result = await indexer.indexFile(input.target, true);
    return {
      indexed: result.status === 'indexed' ? 1 : 0,
      updated: result.status === 'updated' ? 1 : 0,
      errors: result.errors,
    };
  }

  // Re-index everything (force=false to use hash-based skipping)
  const result = await indexer.indexAll();
  await indexer.resolveDependencies();

  return {
    indexed: result.indexed,
    updated: result.updated,
    errors: result.errors,
  };
}
