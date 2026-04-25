import type Database from 'better-sqlite3';

/** A single indexed repository (primary or federated) inside a RepoSet. */
export interface Repo {
  name: string;
  path: string;
  db: Database.Database;
  isPrimary: boolean;
}

/** Federated DB record before being unified into a RepoSet. */
export interface FederatedRepoConfig {
  name: string;
  path: string;
  db: Database.Database;
}

/** Holds the primary repo plus zero or more federated repos. Provides a
 *  uniform iteration surface for federation-aware tools. */
export class RepoSet {
  private readonly repos: Repo[];

  private constructor(repos: Repo[]) {
    this.repos = repos;
  }

  static fromServerConfig(
    primaryDb: Database.Database,
    primaryName: string,
    federated: FederatedRepoConfig[],
    primaryPath = '',
  ): RepoSet {
    const all: Repo[] = [
      { name: primaryName, path: primaryPath, db: primaryDb, isPrimary: true },
      ...federated.map((f) => ({ name: f.name, path: f.path, db: f.db, isPrimary: false })),
    ];
    return new RepoSet(all);
  }

  /** Returns the subset matching the given names. Empty/undefined returns all.
   *  Throws on any unknown name. */
  filter(repos?: string[]): Repo[] {
    if (!repos || repos.length === 0) return [...this.repos];
    const wanted = new Set(repos);
    const known = this.repos.map((r) => r.name);
    for (const name of wanted) {
      if (!known.includes(name)) {
        throw new Error(
          `Unknown repo name: '${name}'. Known: [${known.join(', ')}]`,
        );
      }
    }
    return this.repos.filter((r) => wanted.has(r.name));
  }

  get primary(): Repo {
    const p = this.repos.find((r) => r.isPrimary);
    if (!p) throw new Error('RepoSet has no primary repo');
    return p;
  }

  get all(): Repo[] {
    return [...this.repos];
  }
}
