import type Database from 'better-sqlite3';
import { RepoSet } from '../../src/federation/repo-set.js';

/** Builds a single-repo RepoSet from a single test DB. Used by per-tool
 *  unit tests that don't actually exercise federation. */
export function makeTestRepoSet(db: Database.Database, name: string = 'local'): RepoSet {
  return RepoSet.fromServerConfig(db, name, []);
}

/** Builds a multi-repo RepoSet for federation tests. */
export function makeFederatedTestRepoSet(
  primary: { db: Database.Database; name: string },
  federated: Array<{ db: Database.Database; name: string; path?: string }>,
): RepoSet {
  return RepoSet.fromServerConfig(
    primary.db,
    primary.name,
    federated.map((f) => ({ name: f.name, path: f.path ?? `/test/${f.name}`, db: f.db })),
  );
}
