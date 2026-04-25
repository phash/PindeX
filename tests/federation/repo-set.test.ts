import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { RepoSet, type Repo } from '../../src/federation/repo-set.js';

describe('RepoSet', () => {
  let primaryDb: Database.Database;
  let federatedDbA: Database.Database;
  let federatedDbB: Database.Database;

  beforeEach(() => {
    primaryDb = createTestDb();
    federatedDbA = createTestDb();
    federatedDbB = createTestDb();
  });

  function makeRepos(): RepoSet {
    return RepoSet.fromServerConfig(
      primaryDb,
      'local',
      [
        { name: 'auth', path: '/auth', db: federatedDbA },
        { name: 'web', path: '/web', db: federatedDbB },
      ],
    );
  }

  it('returns all repos when filter() is called with undefined', () => {
    const repos = makeRepos().filter(undefined);
    expect(repos.map((r) => r.name)).toEqual(['local', 'auth', 'web']);
  });

  it('returns all repos when filter() is called with an empty array', () => {
    const repos = makeRepos().filter([]);
    expect(repos.map((r) => r.name)).toEqual(['local', 'auth', 'web']);
  });

  it('returns only the named repos when filter() is given a list', () => {
    const repos = makeRepos().filter(['auth']);
    expect(repos.map((r) => r.name)).toEqual(['auth']);
  });

  it('preserves the order in which repos were registered', () => {
    const repos = makeRepos().filter(['web', 'local']);
    // Order follows the RepoSet's internal order (local first), not the
    // order of names in the filter argument.
    expect(repos.map((r) => r.name)).toEqual(['local', 'web']);
  });

  it('throws when an unknown name is provided', () => {
    expect(() => makeRepos().filter(['nope'])).toThrow(
      /Unknown repo name: 'nope'\. Known: \[local, auth, web\]/,
    );
  });

  it('marks the primary repo with isPrimary=true and federated repos with isPrimary=false', () => {
    const repos = makeRepos().filter(undefined);
    expect(repos[0]).toMatchObject({ name: 'local', isPrimary: true });
    expect(repos[1]).toMatchObject({ name: 'auth', isPrimary: false });
  });

  it('exposes the primary repo via the primary getter', () => {
    expect(makeRepos().primary.name).toBe('local');
  });

  it('exposes all repos via the all getter', () => {
    expect(makeRepos().all.map((r: Repo) => r.name)).toEqual(['local', 'auth', 'web']);
  });
});
