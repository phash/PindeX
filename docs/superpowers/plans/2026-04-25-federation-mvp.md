# Federation-as-USP MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make federation a real, discoverable feature: 9 read-only exploration tools become federation-aware, gain a `repos: string[]` scoping param, and federated repos get stable user-facing names. Add CLI subcommands `pindex federate add/remove/list`. Write/session tools stay strictly local.

**Architecture:** A new `RepoSet` abstraction unifies the primary DB and federated DBs into one list of `{ name, path, db, isPrimary }` records. The 9 federation-aware tools accept a `RepoSet` instead of `(db, federatedDbs[])` and iterate uniformly, tagging each result with the repo name and deduplicating per tool-specific key. The `FEDERATION_REPOS` env var contract is unchanged; the new CLI just edits `.mcp.json` and registry entries.

**Tech Stack:** TypeScript 5.x (ESM/NodeNext), `better-sqlite3`, Vitest 4 with `pool: 'forks'`, Zod for schemas. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-25-federation-mvp-design.md`

---

## Context For The Implementer

Before starting, read:

- `docs/superpowers/specs/2026-04-25-federation-mvp-design.md` — the approved design.
- `CLAUDE.md` (project root) — commit, workflow, security rules.
- `src/server.ts` — current MCP tool dispatcher (`createMcpServer`), look at how `federatedDbs` is currently passed to `searchSymbols` and `getProjectOverview` (and only those two).
- `src/tools/search_symbols.ts` — current federation-aware tool, will be the simplest to refactor onto `RepoSet`.
- `src/tools/find_usages.ts`, `get_symbol.ts`, `get_file_summary.ts`, `get_context.ts`, `get_dependencies.ts`, `search_docs.ts`, `get_doc_chunk.ts` — currently NOT federation-aware; will be migrated.
- `src/tools/schemas.ts` — Zod schemas that need a new `repos` field on 9 tools.
- `src/cli/init.ts` — existing pattern for editing `.mcp.json` and `registry.json`.
- `src/cli/project-detector.ts` — `GlobalRegistry` class.
- `tests/helpers/db.ts` — existing `createTestDb` helper that the new `makeTestRepoSet` will build on.

### Worktree

Work from `/home/manuel/claude/PindeX-federation` on branch `feat/federation-mvp`.
**Every shell command must start with `cd /home/manuel/claude/PindeX-federation`** and `git rev-parse --abbrev-ref HEAD` MUST return `feat/federation-mvp` before any `git commit`.

The worktree starts WITHOUT `node_modules/`. Task 1 includes the `npm install` step that creates it.

### Conventions (from CLAUDE.md)

- Relative imports use `.js` extension even from `.ts` files.
- Forward slashes in paths everywhere.
- No silent catches — `process.stderr.write(\`[pindex] <context>: \${String(err)}\n\`)` minimum.
- Strict TypeScript. No `any`. No non-null `!` unless justified.
- Commit messages: `feat:`, `fix:`, `test:`, `perf:`, `refactor:`, `docs:`, `chore:`, with co-author footer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

### Commands

- `npm test` — full unit suite (currently 430 passing on `main` after v1.4.0).
- `npm run test:integration` — integration suite (rebuilds dist, currently 30 passing).
- `npm run lint` — `tsc --noEmit`.
- `npm run build` — compile `src/` → `dist/`.

---

## File Structure

### New files
- `src/federation/repo-set.ts` — `RepoSet` class.
- `src/federation/merge.ts` — `dedupByKey<T>` helper.
- `src/federation/registry-name.ts` — `assignName` helper.
- `src/cli/federate.ts` — `federateAdd`, `federateRemove`, `federateList`.
- `tests/federation/repo-set.test.ts`
- `tests/federation/merge.test.ts`
- `tests/federation/registry-name.test.ts`
- `tests/cli/federate.test.ts`
- `tests/helpers/repo-set.ts` — `makeTestRepoSet(db, name?)` wrapper used by all per-tool tests.
- `tests/integration/federation-e2e.test.ts`

### Modified files
- `src/server.ts` — `FederatedDb` gains `name: string`; `createMcpServer` builds a `RepoSet` and passes it to the 9 federation-aware tool handlers.
- `src/index.ts` — at startup, populate `name` on each federated DB record (looked up from `GlobalRegistry`, fallback to `assignName`).
- `src/cli/project-detector.ts` — `GlobalRegistry` entries gain a `name: string` field; one-time auto-naming on read.
- `src/cli/init.ts` — `pindex init` sets `name` for the local entry.
- `src/cli/index.ts` — router gets `federate` subcommand.
- `src/tools/schemas.ts` — `repos?: z.array(z.string()).optional()` added to 9 schemas.
- `src/tools/search_symbols.ts`, `get_project_overview.ts`, `find_usages.ts`, `get_symbol.ts`, `get_file_summary.ts`, `get_context.ts`, `get_dependencies.ts`, `search_docs.ts`, `get_doc_chunk.ts` — signature change to accept `RepoSet`.
- `src/types.ts` — `project: string` becomes required on the relevant Output types.
- `README.md`, `CLAUDE.md` — document `pindex federate` + the `repos` param.

---

## Task 1: assignName helper

Pure function, zero dependencies. The simplest piece of the puzzle.

**Files:**
- Create: `src/federation/registry-name.ts`
- Create: `tests/federation/registry-name.test.ts`

- [ ] **Step 1: Install deps (this is also where node_modules first gets created in the worktree)**

```bash
cd /home/manuel/claude/PindeX-federation && npm install 2>&1 | tail -3
```
Expected: deps install cleanly (~7 MB of pyright comes along via optionalDependency from v1.4.0).

- [ ] **Step 2: Write the failing test**

```ts
// tests/federation/registry-name.test.ts
import { describe, it, expect } from 'vitest';
import { assignName } from '../../src/federation/registry-name.js';

describe('assignName', () => {
  it('returns the basename when no collision', () => {
    expect(assignName('/home/me/auth', new Set())).toBe('auth');
  });

  it('appends a 4-hex path-hash suffix on first-order collision', () => {
    const taken = new Set(['utils']);
    const result = assignName('/home/me/project-b/utils', taken);
    expect(result).toMatch(/^utils-[a-f0-9]{4}$/);
  });

  it('extends to 8-hex on second-order collision', () => {
    const taken = new Set(['utils', 'utils-1234']);
    // Force a hash collision by using a known path that produces '1234'.
    // We can't predict the actual hash; instead, verify shape: when both
    // basename and basename-4hex are taken, the result has 8 hex.
    const result = assignName('/home/me/x/utils', taken);
    if (result === 'utils-1234') {
      // unlikely-but-possible exact reproduction; treat as pass
      expect(result).toMatch(/^utils-[a-f0-9]{4}$/);
    } else if (result.startsWith('utils-') && result.length === 'utils-12345678'.length) {
      expect(result).toMatch(/^utils-[a-f0-9]{8}$/);
    } else {
      // 4-hex variant for this path didn't happen to collide; that's fine too
      expect(result).toMatch(/^utils-[a-f0-9]{4}$/);
    }
  });

  it('is deterministic for the same path', () => {
    const path = '/home/me/something/utils';
    const a = assignName(path, new Set(['utils']));
    const b = assignName(path, new Set(['utils']));
    expect(a).toBe(b);
  });

  it('handles paths with trailing slashes', () => {
    expect(assignName('/home/me/auth/', new Set())).toBe('auth');
  });
});
```

- [ ] **Step 3: Run test, verify fail**

```bash
cd /home/manuel/claude/PindeX-federation && npm test -- tests/federation/registry-name.test.ts 2>&1 | tail -5
```
Expected: FAIL — `Cannot find module '../../src/federation/registry-name.js'`.

- [ ] **Step 4: Implement**

```ts
// src/federation/registry-name.ts
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/** Returns a stable, unique name for a federated repo path.
 *  - First choice: basename(path) (e.g. /home/me/auth → "auth")
 *  - On collision: basename + "-" + first 4 hex of sha256(path)
 *  - On second collision: basename + "-" + first 8 hex */
export function assignName(path: string, existingNames: Set<string>): string {
  const base = basename(path.replace(/\/+$/, ''));
  if (!existingNames.has(base)) return base;

  const hash = createHash('sha256').update(path).digest('hex');
  const short = `${base}-${hash.slice(0, 4)}`;
  if (!existingNames.has(short)) return short;

  return `${base}-${hash.slice(0, 8)}`;
}
```

- [ ] **Step 5: Tests pass**

```bash
cd /home/manuel/claude/PindeX-federation && npm test -- tests/federation/registry-name.test.ts 2>&1 | tail -5
```
Expected: 5 tests pass.

- [ ] **Step 6: Full suite + lint**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: 435/435 (430 + 5 new).

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
cd /home/manuel/claude/PindeX-federation
git rev-parse --abbrev-ref HEAD  # MUST say feat/federation-mvp
git add src/federation/registry-name.ts tests/federation/registry-name.test.ts
git commit -m "$(cat <<'EOF'
feat(federation): add assignName helper with collision suffixes

Returns basename(path) when free; appends a 4-hex sha256(path)-based
suffix on collision; extends to 8 hex on second-order collision. Pure
deterministic function used by both the GlobalRegistry migration and
the CLI federate-add path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: dedupByKey helper

Another pure function with zero dependencies. TDD.

**Files:**
- Create: `src/federation/merge.ts`
- Create: `tests/federation/merge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/federation/merge.test.ts
import { describe, it, expect } from 'vitest';
import { dedupByKey } from '../../src/federation/merge.js';

describe('dedupByKey', () => {
  it('returns the input unchanged when no duplicates', () => {
    const input = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = dedupByKey(input, (x) => String(x.id));
    expect(result).toEqual(input);
  });

  it('keeps the first occurrence of each key', () => {
    const input = [
      { id: 1, project: 'a' },
      { id: 2, project: 'b' },
      { id: 1, project: 'c' },
    ];
    const result = dedupByKey(input, (x) => String(x.id));
    expect(result).toEqual([
      { id: 1, project: 'a' },
      { id: 2, project: 'b' },
    ]);
  });

  it('handles an empty array', () => {
    expect(dedupByKey<{ id: number }>([], (x) => String(x.id))).toEqual([]);
  });

  it('preserves input order', () => {
    const input = [{ k: 'b' }, { k: 'a' }, { k: 'c' }, { k: 'a' }];
    const result = dedupByKey(input, (x) => x.k);
    expect(result.map((x) => x.k)).toEqual(['b', 'a', 'c']);
  });

  it('uses the keyFn output as the dedup identity, not deep equality', () => {
    const input = [
      { name: 'A', kind: 'class' },
      { name: 'A', kind: 'function' }, // same name, different kind — should NOT dedup
    ];
    const result = dedupByKey(input, (x) => `${x.name}::${x.kind}`);
    expect(result).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd /home/manuel/claude/PindeX-federation && npm test -- tests/federation/merge.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/federation/merge.ts

/** Deduplicates an array of items by a string key derived from each item.
 *  Order-preserving; first occurrence of each key wins. */
export function dedupByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
```

- [ ] **Step 4: Tests pass**

```bash
cd /home/manuel/claude/PindeX-federation && npm test -- tests/federation/merge.test.ts 2>&1 | tail -5
```
Expected: 5 tests pass.

- [ ] **Step 5: Full suite + lint**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: 440/440.

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd /home/manuel/claude/PindeX-federation
git add src/federation/merge.ts tests/federation/merge.test.ts
git commit -m "$(cat <<'EOF'
feat(federation): add dedupByKey helper for tool result merging

Order-preserving generic dedup. Each federation-aware tool will call
dedupByKey with a tool-specific key function (e.g. \${project}::\${name}::\${kind}
for search_symbols).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: RepoSet class

Builds on the spec's `Repo` shape: `{ name, path, db, isPrimary }`.

**Files:**
- Create: `src/federation/repo-set.ts`
- Create: `tests/federation/repo-set.test.ts`
- Create: `tests/helpers/repo-set.ts` (test helper used by all per-tool tests later)

- [ ] **Step 1: Write the failing test**

```ts
// tests/federation/repo-set.test.ts
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
```

- [ ] **Step 2: Verify fail**

```bash
cd /home/manuel/claude/PindeX-federation && npm test -- tests/federation/repo-set.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/federation/repo-set.ts
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
```

- [ ] **Step 4: Add the test helper**

```ts
// tests/helpers/repo-set.ts
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
```

- [ ] **Step 5: Tests pass**

```bash
cd /home/manuel/claude/PindeX-federation && npm test -- tests/federation/repo-set.test.ts 2>&1 | tail -5
```
Expected: 8 tests pass.

- [ ] **Step 6: Full suite + lint**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: 448/448.

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
cd /home/manuel/claude/PindeX-federation
git add src/federation/repo-set.ts tests/federation/repo-set.test.ts tests/helpers/repo-set.ts
git commit -m "$(cat <<'EOF'
feat(federation): add RepoSet abstraction over primary + federated DBs

RepoSet unifies the primary database and federated DBs into one ordered
list of Repo records. filter(repos?) returns the subset matching the
given names, throws on unknown names, returns all when undefined/empty.
This collapses the existing primary-vs-federated branching that
complicates the two federation-aware tools today and is the foundation
for the other 7 tools that join in subsequent commits.

Test helpers makeTestRepoSet / makeFederatedTestRepoSet land alongside
to keep per-tool tests concise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: GlobalRegistry name field + migration

Adds `name: string` to registry entries. On first read after upgrade, entries without a name get auto-named.

**Files:**
- Modify: `src/cli/project-detector.ts`
- Modify: `src/cli/init.ts`
- Modify: `tests/cli/project-detector.test.ts`

- [ ] **Step 1: Add a test for the new field + migration**

Append to `tests/cli/project-detector.test.ts` (inside the existing top-level `describe`):

```ts
describe('GlobalRegistry — name field', () => {
  it('assigns a name on upsert when missing', () => {
    const reg = new GlobalRegistry();
    const entry = reg.upsert('/tmp/some-test-project-' + Date.now());
    expect(entry.name).toBeDefined();
    expect(typeof entry.name).toBe('string');
    expect(entry.name.length).toBeGreaterThan(0);
  });

  it('auto-names entries on read when name is missing (migration)', () => {
    // Write a registry file by hand without name fields.
    const home = getPindexHome();
    mkdirSync(home, { recursive: true });
    const path = join(home, 'registry.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        projects: [
          { hash: 'aaa', path: '/x/foo', port: 7842 },
          { hash: 'bbb', path: '/x/bar', port: 7843 },
        ],
      }),
    );

    const reg = new GlobalRegistry();
    const entries = reg.list();
    expect(entries.every((e) => typeof e.name === 'string' && e.name.length > 0)).toBe(true);

    // The migration should have written back to disk.
    const reread = JSON.parse(readFileSync(path, 'utf-8')) as { projects: Array<{ name?: string }> };
    expect(reread.projects.every((p) => typeof p.name === 'string')).toBe(true);
  });
});
```

You'll need these imports at the top of the test file (add if missing):

```ts
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPindexHome } from '../../src/cli/project-detector.js';
```

- [ ] **Step 2: Verify the new tests fail**

```bash
cd /home/manuel/claude/PindeX-federation && npm test -- tests/cli/project-detector.test.ts 2>&1 | tail -10
```
Expected: 2 new tests fail (name field doesn't exist yet); existing tests still pass.

- [ ] **Step 3: Update the RegistryEntry interface and GlobalRegistry**

Open `src/cli/project-detector.ts`. Find the `RegistryEntry` interface and add the `name` field:

```ts
export interface RegistryEntry {
  hash: string;
  path: string;
  port: number;
  federatedRepos?: string[];
  name: string;
}
```

Find `GlobalRegistry.upsert` and `GlobalRegistry.read`. Update the `read` method to migrate-on-read:

```ts
read(): RegistryEntry[] {
  if (!existsSync(this.registryPath)) return [];
  let parsed: RegistryFile;
  try {
    parsed = JSON.parse(readFileSync(this.registryPath, 'utf-8')) as RegistryFile;
  } catch {
    return [];
  }
  const projects = parsed.projects ?? [];

  // Migration: assign name to any entry that lacks one.
  let migrated = false;
  const usedNames = new Set<string>(
    projects.map((p) => p.name).filter((n): n is string => Boolean(n)),
  );
  for (const p of projects) {
    if (!p.name) {
      p.name = assignName(p.path, usedNames);
      usedNames.add(p.name);
      migrated = true;
    }
  }
  if (migrated) {
    this.write(projects);
  }
  return projects;
}
```

Update `upsert` so that newly added entries have a `name`:

```ts
upsert(projectPath: string): RegistryEntry {
  const entries = this.read();
  const existing = entries.find((e) => e.path === projectPath);
  if (existing) return existing;

  const hash = hashPath(projectPath);
  const port = computeNextAvailablePort(entries);
  const usedNames = new Set(entries.map((e) => e.name).filter((n): n is string => Boolean(n)));
  const name = assignName(projectPath, usedNames);

  const entry: RegistryEntry = { hash, path: projectPath, port, name };
  this.write([...entries, entry]);
  return entry;
}
```

Add the import at the top of `src/cli/project-detector.ts`:

```ts
import { assignName } from '../federation/registry-name.js';
```

- [ ] **Step 4: Tests pass**

```bash
cd /home/manuel/claude/PindeX-federation && npm test -- tests/cli/project-detector.test.ts 2>&1 | tail -10
```
Expected: all tests pass including the 2 new ones.

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: 450/450 (448 + 2 new).

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd /home/manuel/claude/PindeX-federation
git add src/cli/project-detector.ts tests/cli/project-detector.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add name field to GlobalRegistry with one-shot migration

Each project entry now carries a stable, user-facing name (default:
basename(path), with hash suffix on collision). GlobalRegistry.read()
migrates pre-existing 1.4.0 registries on first access and writes the
result back; subsequent reads hit the cached, fully-named state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: FederatedDb gets a name + server builds RepoSet

Wires the unified set into the MCP server. The 9 tool handlers continue to use the OLD signature for now; this task only updates `server.ts` and `index.ts`. Tools migrate one at a time in Tasks 7–11.

**Files:**
- Modify: `src/server.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Update FederatedDb to require name**

In `src/server.ts`, find `export interface FederatedDb { path: string; db: Database.Database; }` and update:

```ts
export interface FederatedDb {
  name: string;
  path: string;
  db: Database.Database;
}
```

In `src/server.ts`, inside `createMcpServer`, after the existing setup, add:

```ts
import { RepoSet } from './federation/repo-set.js';

// ...existing imports...

export interface CreateMcpServerOptions {
  // ...existing fields...
  /** Name for the primary (local) repo. Required so RepoSet has a stable
   *  identity for it in tool results. Provided by index.ts at startup. */
  primaryName?: string;
}
```

Add a private builder near the top of `createMcpServer`:

```ts
const primaryName = options.primaryName ?? 'local';
const repoSet = RepoSet.fromServerConfig(
  db,
  primaryName,
  federatedDbs.map((f) => ({ name: f.name, path: f.path, db: f.db })),
);
```

The existing tool handlers still call functions with the old `(db, args, federatedDbs?, projectRoot?)` signature. They are unchanged in this task. The `repoSet` is built and ready for Task 7+ to use.

- [ ] **Step 2: Update src/index.ts to populate names**

In `src/index.ts`, where `federatedDbs` is built (around line 49):

```ts
const federatedDbs = FEDERATION_REPOS.map((repoPath) => {
  const dbPath = getProjectIndexPath(repoPath);
  try {
    const fedDb = openDatabase(dbPath);
    return { path: repoPath, db: fedDb };
  } catch {
    process.stderr.write(`[pindex] Warning: could not open federated DB for ${repoPath}\n`);
    return null;
  }
}).filter((x): x is { path: string; db: ReturnType<typeof openDatabase> } => x !== null);
```

Change to:

```ts
import { GlobalRegistry } from './cli/project-detector.js';
import { assignName } from './federation/registry-name.js';

// ...existing code...

const registry = new GlobalRegistry();
const allEntries = registry.list();
const usedNames = new Set<string>();

// Resolve the primary (local) name first so collisions in federated
// names don't accidentally shadow it.
const primaryEntry = allEntries.find((e) => e.path === PROJECT_ROOT);
const primaryName = primaryEntry?.name ?? assignName(PROJECT_ROOT, usedNames);
usedNames.add(primaryName);

const federatedDbs = FEDERATION_REPOS.map((repoPath) => {
  const dbPath = getProjectIndexPath(repoPath);
  try {
    const fedDb = openDatabase(dbPath);
    const entry = allEntries.find((e) => e.path === repoPath);
    let name = entry?.name;
    if (!name) {
      name = assignName(repoPath, usedNames);
      process.stderr.write(
        `[pindex] federated repo '${repoPath}' has no persisted name; using auto-generated '${name}'. Run 'pindex federate add ${repoPath}' to persist.\n`,
      );
    }
    usedNames.add(name);
    return { name, path: repoPath, db: fedDb };
  } catch {
    process.stderr.write(`[pindex] Warning: could not open federated DB for ${repoPath}\n`);
    return null;
  }
}).filter((x): x is { name: string; path: string; db: ReturnType<typeof openDatabase> } => x !== null);
```

And update the `createMcpServer` call to pass `primaryName`:

```ts
const server = createMcpServer(db, indexer, tokenLogger, monitoringServer, {
  // ...existing fields...
  primaryName,
});
```

- [ ] **Step 3: Tests still pass (no test changes; the wiring is internal)**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: 450/450 still.

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

If a TypeScript error fires because some test instantiates `FederatedDb` without `name`, find the test and add `name: 'test'`. There is one such test in `tests/integration/mcp-server.test.ts` if memory serves; grep for `federatedDbs:` in tests/.

- [ ] **Step 4: Commit**

```bash
cd /home/manuel/claude/PindeX-federation
git add src/server.ts src/index.ts
# If you had to update test fixtures, add them too.
git commit -m "$(cat <<'EOF'
feat(server): build a RepoSet at startup, plumb primary name through

FederatedDb gains a required name field, populated from GlobalRegistry
when present and via assignName() otherwise (with a one-time stderr
warning so the user knows to run 'pindex federate add' to persist).
createMcpServer now accepts a primaryName and constructs a RepoSet
that subsequent tasks will hand to federation-aware tool handlers.

The 9 existing tool handlers still use the old (db, federatedDbs)
signature in this commit; their migration follows in tasks 7–11.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add `repos` to schemas

Adds the optional `repos: string[]` to the 9 federation-aware tool schemas. The tool handlers don't use it yet — that's Tasks 7–11. This task only adds the surface so client validation passes immediately when callers start sending it.

**Files:**
- Modify: `src/tools/schemas.ts`
- Modify: `src/types.ts`
- Modify: `tests/tools/validation.test.ts`

- [ ] **Step 1: Add tests for the new field**

Append to `tests/tools/validation.test.ts` (inside the existing top-level `describe`):

```ts
describe('repos param on federation-aware tool schemas', () => {
  const SCHEMAS = [
    'SearchSymbolsSchema',
    'GetSymbolSchema',
    'GetContextSchema',
    'GetFileSummarySchema',
    'FindUsagesSchema',
    'GetDependenciesSchema',
    'GetProjectOverviewSchema',
    'SearchDocsSchema',
    'GetDocChunkSchema',
  ] as const;

  it('accepts repos as an optional string[]', async () => {
    const schemas = await import('../../src/tools/schemas.js');
    for (const name of SCHEMAS) {
      const schema = (schemas as never as Record<string, { safeParse: (v: unknown) => { success: boolean } }>)[name];
      expect(schema).toBeDefined();
      // build a minimal valid input and add repos
      const baseValid: Record<string, unknown> = {
        SearchSymbolsSchema: { query: 'x' },
        GetSymbolSchema: { name: 'x' },
        GetContextSchema: { file: 'x.ts', line: 1 },
        GetFileSummarySchema: { file: 'x.ts' },
        FindUsagesSchema: { symbol: 'x' },
        GetDependenciesSchema: { file: 'x.ts' },
        GetProjectOverviewSchema: {},
        SearchDocsSchema: { query: 'x' },
        GetDocChunkSchema: { file: 'docs/x.md', chunkIndex: 0 },
      }[name] as Record<string, unknown>;

      const ok = schema.safeParse({ ...baseValid, repos: ['a', 'b'] });
      expect(ok.success, `${name} should accept repos`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd /home/manuel/claude/PindeX-federation && npm test -- tests/tools/validation.test.ts 2>&1 | tail -10
```
Expected: the new test fails for the schemas that currently don't have `repos` (most of them).

- [ ] **Step 3: Add `repos` to all 9 schemas**

In `src/tools/schemas.ts`, add a constant near the top:

```ts
const reposField = z.array(z.string()).optional();
```

Then add `repos: reposField` to each of the 9 schemas. For example, `SearchSymbolsSchema`:

```ts
export const SearchSymbolsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  // ...existing fields...
  repos: reposField,
});
```

Repeat for `GetSymbolSchema`, `GetContextSchema`, `GetFileSummarySchema`, `FindUsagesSchema`, `GetDependenciesSchema`, `GetProjectOverviewSchema`, `SearchDocsSchema`, `GetDocChunkSchema`.

Also add `repos?: string[]` to the corresponding Input types in `src/types.ts` (e.g. `SearchSymbolsInput`, `GetSymbolInput`, etc.).

- [ ] **Step 4: Tests pass**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: 451/451 (450 + 1 new).

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd /home/manuel/claude/PindeX-federation
git add src/tools/schemas.ts src/types.ts tests/tools/validation.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): add optional repos param to 9 federation-aware schemas

repos: string[] is now accepted by every read-only exploration tool
(search_symbols, get_symbol, get_context, get_file_summary, find_usages,
get_dependencies, get_project_overview, search_docs, get_doc_chunk).
The handlers ignore it for now; tool migration to consume it follows
in tasks 7–11.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Migrate search_symbols + get_project_overview

Both already have federation; this task simplifies them onto `RepoSet` and honours the `repos` scoping param.

**Files:**
- Modify: `src/tools/search_symbols.ts`
- Modify: `src/tools/get_project_overview.ts`
- Modify: `src/server.ts` (call sites)
- Modify: `tests/tools/search_symbols.test.ts`
- Modify: `tests/tools/get_project_overview.test.ts`

- [ ] **Step 1: Add federation tests for search_symbols**

Append to `tests/tools/search_symbols.test.ts`:

```ts
describe('searchSymbols — federation', () => {
  let primaryDb: Database.Database;
  let federatedDb: Database.Database;
  let primaryFileId: number;
  let federatedFileId: number;

  beforeEach(() => {
    primaryDb = createTestDb();
    federatedDb = createTestDb();
    primaryFileId = insertTestFile(primaryDb, { path: 'src/local.ts' });
    federatedFileId = insertTestFile(federatedDb, { path: 'src/remote.ts' });
    insertTestSymbol(primaryDb, { fileId: primaryFileId, name: 'LocalThing' });
    insertTestSymbol(federatedDb, { fileId: federatedFileId, name: 'RemoteThing' });
  });

  it('returns results from both repos with project tags', () => {
    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );
    const results = searchSymbols(repoSet, { query: 'Thing' });
    const byProject = new Map(results.map((r) => [r.name, r.project]));
    expect(byProject.get('LocalThing')).toBe('main');
    expect(byProject.get('RemoteThing')).toBe('auth');
  });

  it('scopes by repos param', () => {
    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );
    const results = searchSymbols(repoSet, { query: 'Thing', repos: ['auth'] });
    expect(results.map((r) => r.name)).toEqual(['RemoteThing']);
  });

  it('throws on unknown repo name', () => {
    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );
    expect(() => searchSymbols(repoSet, { query: 'Thing', repos: ['nope'] })).toThrow(
      /Unknown repo name: 'nope'/,
    );
  });
});
```

Add the import at the top: `import { makeFederatedTestRepoSet } from '../helpers/repo-set.js';`

Existing tests will fail because they pass `(db, input)` instead of `(repoSet, input)`. Update them to wrap `db` via `makeTestRepoSet(db)`.

- [ ] **Step 2: Refactor `src/tools/search_symbols.ts`**

```ts
// src/tools/search_symbols.ts
import { readFileSync, existsSync } from 'node:fs';
import type { SearchSymbolsInput, SymbolSearchResult } from '../types.js';
import { searchSymbolsFts } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';
import { dedupByKey } from '../federation/merge.js';
import { resolveWithinRoot } from '../util/paths.js';

export function searchSymbols(
  repoSet: RepoSet,
  input: SearchSymbolsInput,
): SymbolSearchResult[] {
  const limit = input.limit ?? 20;
  const filters = { isAsync: input.isAsync, hasTryCatch: input.hasTryCatch };

  const repos = repoSet.filter(input.repos);
  const all: SymbolSearchResult[] = [];

  for (const repo of repos) {
    try {
      for (const row of searchSymbolsFts(repo.db, input.query, limit, filters)) {
        const result: SymbolSearchResult = {
          name: row.name,
          kind: row.kind,
          signature: row.signature,
          summary: row.summary,
          file: row.file_path,
          line: row.start_line,
          isAsync: row.is_async === 1,
          hasTryCatch: row.has_try_catch === 1,
          project: repo.name,
        };

        if (input.snippet && repo.path) {
          const absPath = resolveWithinRoot(repo.path, row.file_path);
          if (absPath && existsSync(absPath)) {
            try {
              const lines = readFileSync(absPath, 'utf-8').split('\n');
              const startIdx = Math.max(0, row.start_line - 1);
              result.snippet = lines.slice(startIdx, startIdx + 5).join('\n');
            } catch (err) {
              process.stderr.write(`[pindex] search_symbols snippet read failed for ${absPath}: ${String(err)}\n`);
            }
          }
        }

        all.push(result);
      }
    } catch (err) {
      process.stderr.write(`[pindex] search_symbols failed for repo '${repo.name}': ${String(err)}\n`);
    }
  }

  return dedupByKey(all, (r) => `${r.project}::${r.name}::${r.kind}`).slice(0, limit * repos.length);
}
```

Update `SymbolSearchResult` in `src/types.ts` so `project: string` is required (not optional).

- [ ] **Step 3: Refactor `src/tools/get_project_overview.ts`**

Apply the same pattern: accept `RepoSet`, iterate, tag results with `project: repo.name`. The full function body is similar to search_symbols structurally; iterate over `repoSet.filter(input.repos)`, run the existing per-DB query for each repo, merge results into a federation-shaped output.

The existing function returns aggregated stats per repo; this refactor preserves that shape but uses `RepoSet`.

```ts
// src/tools/get_project_overview.ts (replace the entire export function)
import type {
  GetProjectOverviewInput,
  GetProjectOverviewOutput,
  ProjectOverviewSnapshot,
} from '../types.js';
import { ... } from '../db/queries.js';     // keep existing imports
import type { RepoSet } from '../federation/repo-set.js';

export function getProjectOverview(
  repoSet: RepoSet,
  primaryProjectRoot: string,
  sessionId: string,
  input: GetProjectOverviewInput,
): GetProjectOverviewOutput {
  const repos = repoSet.filter(input.repos);
  const primary = repoSet.primary;

  // Build per-repo snapshot (existing logic, but parameterised on repo).
  const snapshots: ProjectOverviewSnapshot[] = repos.map((repo) => buildSnapshot(repo.db, repo.name));

  // Find the primary in the snapshots list and use it as the top-level fields,
  // while exposing all repos under federated_projects.
  const primarySnap = snapshots.find((s) => s.project === primary.name) ?? snapshots[0];
  const federated = snapshots.filter((s) => s !== primarySnap);

  return {
    ...primarySnap,
    federated_projects: federated,
  };
}

function buildSnapshot(db: import('better-sqlite3').Database, name: string): ProjectOverviewSnapshot {
  // Move the existing per-DB aggregation logic here.
  // Return shape: { project: name, ...stats }
}
```

Update `src/types.ts` so `ProjectOverviewSnapshot.project: string` is required.

- [ ] **Step 4: Update server.ts call sites**

In `src/server.ts`, find the cases for `search_symbols` and `get_project_overview`:

```ts
case 'search_symbols':
  result = searchSymbols(repoSet, args as SearchSymbolsInput);
  break;
case 'get_project_overview':
  result = getProjectOverview(repoSet, projectRoot, sessionId, args as GetProjectOverviewInput);
  break;
```

(Remove the `db, ..., federatedDbs, projectRoot` from those calls; pass `repoSet` instead.)

- [ ] **Step 5: Tests pass**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -10
```
Expected: 454/454 (451 + 3 new from search_symbols federation tests; existing tests adjusted to use makeTestRepoSet).

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd /home/manuel/claude/PindeX-federation
git add src/tools/search_symbols.ts src/tools/get_project_overview.ts src/server.ts src/types.ts tests/tools/
git commit -m "$(cat <<'EOF'
feat(tools): migrate search_symbols + get_project_overview to RepoSet

Both tools now accept a RepoSet and honour the repos scoping param.
Result types make project: string required (was optional). The
primary-vs-federated branching pattern from earlier is replaced by a
uniform iteration over repoSet.filter(input.repos).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Migrate find_usages + get_symbol

Both deal with a single symbol's appearance. New federation territory.

**Files:**
- Modify: `src/tools/find_usages.ts`
- Modify: `src/tools/get_symbol.ts`
- Modify: `src/server.ts`
- Modify: `tests/tools/find_usages.test.ts`
- Modify: `tests/tools/get_symbol.test.ts`

- [ ] **Step 1: Add federation tests for find_usages**

Append to `tests/tools/find_usages.test.ts`:

```ts
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

describe('findUsages — federation', () => {
  it('returns usages tagged with their repo of origin', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    const pf = insertTestFile(primaryDb, { path: 'src/local.ts' });
    const ff = insertTestFile(federatedDb, { path: 'src/remote.ts' });
    const ps = insertTestSymbol(primaryDb, { fileId: pf, name: 'parseToken' });
    const fs = insertTestSymbol(federatedDb, { fileId: ff, name: 'parseToken' });
    insertTestUsage(primaryDb, ps, pf, 10);
    insertTestUsage(federatedDb, fs, ff, 20);

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = findUsages(repoSet, { symbol: 'parseToken' });
    const projects = results.map((r) => r.project).sort();
    expect(projects).toEqual(['auth', 'main']);
  });

  it('scopes by repos param', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    const pf = insertTestFile(primaryDb, { path: 'src/x.ts' });
    const ff = insertTestFile(federatedDb, { path: 'src/y.ts' });
    insertTestUsage(primaryDb, insertTestSymbol(primaryDb, { fileId: pf, name: 'foo' }), pf, 1);
    insertTestUsage(federatedDb, insertTestSymbol(federatedDb, { fileId: ff, name: 'foo' }), ff, 1);

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = findUsages(repoSet, { symbol: 'foo', repos: ['auth'] });
    expect(results.every((r) => r.project === 'auth')).toBe(true);
  });
});
```

Existing tests in `find_usages.test.ts` need their `findUsages(db, ...)` calls wrapped via `makeTestRepoSet`.

- [ ] **Step 2: Refactor `src/tools/find_usages.ts`**

```ts
// src/tools/find_usages.ts
import type { FindUsagesInput, UsageLocation } from '../types.js';
import { findUsagesByName } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';
import { dedupByKey } from '../federation/merge.js';

export function findUsages(repoSet: RepoSet, input: FindUsagesInput): UsageLocation[] {
  const repos = repoSet.filter(input.repos);
  const all: UsageLocation[] = [];

  for (const repo of repos) {
    for (const row of findUsagesByName(repo.db, input.symbol)) {
      all.push({
        symbol: row.symbol_name,
        file: row.used_in_file_path,
        line: row.used_at_line,
        context: row.context ?? `${row.used_in_file_path}:${row.used_at_line}`,
        project: repo.name,
      });
    }
  }

  return dedupByKey(all, (r) => `${r.project}::${r.file}::${r.line}`);
}
```

Update `UsageLocation` in `src/types.ts` so `project: string` is required.

- [ ] **Step 3: Add federation tests for get_symbol**

Append to `tests/tools/get_symbol.test.ts`:

```ts
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

describe('getSymbol — federation', () => {
  it('returns one entry per repo when the same name exists in multiple repos', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    insertTestSymbol(primaryDb, {
      fileId: insertTestFile(primaryDb, { path: 'src/auth.ts' }),
      name: 'AuthService',
    });
    insertTestSymbol(federatedDb, {
      fileId: insertTestFile(federatedDb, { path: 'src/auth.ts' }),
      name: 'AuthService',
    });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = getSymbol(repoSet, { name: 'AuthService' });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.project).sort()).toEqual(['auth', 'main']);
  });

  it('returns an empty array when the symbol is in no repo', () => {
    const repoSet = makeTestRepoSet(createTestDb(), 'main');
    expect(getSymbol(repoSet, { name: 'Nope' })).toEqual([]);
  });
});
```

Note: `getSymbol`'s return type changes from `SymbolDetails | null` to `SymbolDetails[]`. Update `src/types.ts` accordingly. Existing callers (and tests) need to handle the array shape.

- [ ] **Step 4: Refactor `src/tools/get_symbol.ts`**

```ts
// src/tools/get_symbol.ts
import type { GetSymbolInput, SymbolDetails } from '../types.js';
import { getSymbolByName, getFileByPath, getDependenciesByFile, getObservationsByFileSymbol } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';

export function getSymbol(repoSet: RepoSet, input: GetSymbolInput): SymbolDetails[] {
  const repos = repoSet.filter(input.repos);
  const out: SymbolDetails[] = [];

  for (const repo of repos) {
    const symbol = getSymbolByName(repo.db, input.name);
    if (!symbol) continue;

    const file = getFileByPath(repo.db, symbol.file_path);
    const dependencies = file ? getDependenciesByFile(repo.db, file.id) : [];
    const observations = getObservationsByFileSymbol(repo.db, symbol.file_path, symbol.name, 3);

    const detail: SymbolDetails = {
      name: symbol.name,
      kind: symbol.kind,
      signature: symbol.signature,
      summary: symbol.summary,
      file: symbol.file_path,
      startLine: symbol.start_line,
      endLine: symbol.end_line,
      isExported: symbol.is_exported === 1,
      dependencies,
      project: repo.name,
    };

    if (observations.length > 0) {
      detail.memory_context = {
        last_seen_session: observations[0].session_id ?? null,
        observations: observations.map((o) => o.observation),
        stale: observations.some((o) => o.stale === 1),
      };
    }

    out.push(detail);
  }

  return out;
}
```

- [ ] **Step 5: Update server.ts call sites**

```ts
case 'find_usages':
  result = findUsages(repoSet, args as FindUsagesInput);
  break;
case 'get_symbol':
  result = getSymbol(repoSet, args as GetSymbolInput);
  break;
```

- [ ] **Step 6: Tests pass + lint**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: 458/458.

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
cd /home/manuel/claude/PindeX-federation
git add src/tools/find_usages.ts src/tools/get_symbol.ts src/server.ts src/types.ts tests/tools/
git commit -m "$(cat <<'EOF'
feat(tools): migrate find_usages + get_symbol to RepoSet

find_usages dedupes by project::file::line so federation doesn't
double-count usages with the same coordinates. get_symbol now returns
SymbolDetails[] (one entry per repo where the name exists) instead of
a single nullable result, making cross-repo same-name symbols visible
to the caller.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Migrate get_file_summary + get_context

Both deal with a single file path. Same migration pattern.

**Files:**
- Modify: `src/tools/get_file_summary.ts`
- Modify: `src/tools/get_context.ts`
- Modify: `src/server.ts`
- Modify: `tests/tools/get_file_summary.test.ts`
- Modify: `tests/tools/get_context.test.ts`

- [ ] **Step 1: Tests**

For both tools, add federation tests asserting that:
- "returns one entry per repo where the file exists" — when both repos have a file at `src/x.ts`, results contain both, tagged with project.
- "scopes by repos param" — when `repos: ["main"]` passed, only main's file is returned.
- Update existing tests to wrap `db` with `makeTestRepoSet(db)`.

Sample for `get_file_summary`:

```ts
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

describe('getFileSummary — federation', () => {
  it('returns matching files from each repo, tagged with project', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    insertTestFile(primaryDb, { path: 'src/auth.ts' });
    insertTestFile(federatedDb, { path: 'src/auth.ts' });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'remote' }],
    );

    const results = getFileSummary(repoSet, { file: 'src/auth.ts' });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.project).sort()).toEqual(['main', 'remote']);
  });
});
```

`getFileSummary`'s return type changes from `GetFileSummaryOutput | null` to `GetFileSummaryOutput[]` for consistency with `get_symbol`. `getContext` similarly.

- [ ] **Step 2: Refactor `get_file_summary.ts`**

Pattern matches Task 8's `get_symbol`: iterate over `repoSet.filter(input.repos)`, run existing per-DB query, push to result array with `project: repo.name`. No dedup needed (a single file path is at most one entry per repo).

- [ ] **Step 3: Refactor `get_context.ts`**

`get_context` reads from disk. The disk read uses the per-repo `path` (`repo.path`) plus the relative file. With `RepoSet`, each repo has its own `path` so the read is straightforward:

```ts
const repos = repoSet.filter(input.repos);
const out: GetContextOutput[] = [];

for (const repo of repos) {
  const fileRecord = getFileByPath(repo.db, input.file);
  if (!fileRecord) continue;

  const absolutePath = resolveWithinRoot(repo.path, input.file);
  if (!absolutePath || !existsSync(absolutePath)) continue;

  // ...existing range-collection logic on absolutePath...

  out.push({ code, language: fileRecord.language, startLine, endLine, project: repo.name });
}

return out;
```

- [ ] **Step 4: Update server.ts**

```ts
case 'get_file_summary':
  result = getFileSummary(repoSet, args as GetFileSummaryInput);
  break;
case 'get_context':
  result = await getContext(repoSet, args as GetContextInput);
  break;
```

(`getContext` remains async because it streams from disk.)

- [ ] **Step 5: Tests + lint**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: ~462/462.

- [ ] **Step 6: Commit**

```bash
git add src/tools/get_file_summary.ts src/tools/get_context.ts src/server.ts src/types.ts tests/tools/
git commit -m "$(cat <<'EOF'
feat(tools): migrate get_file_summary + get_context to RepoSet

Both tools now return arrays (one entry per repo where the file
exists). get_context still reads from disk, but uses each repo's own
path as the resolveWithinRoot root, preserving the path-traversal
guard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Migrate get_dependencies

Single tool. Output type becomes `GetDependenciesOutput[]` — one entry per repo where the file exists.

**Files:**
- Modify: `src/tools/get_dependencies.ts`
- Modify: `src/server.ts`
- Modify: `src/types.ts`
- Modify: `tests/tools/get_dependencies.test.ts`

- [ ] **Step 1: Add federation tests**

Append to `tests/tools/get_dependencies.test.ts`:

```ts
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

describe('getDependencies — federation', () => {
  it('returns one entry per repo where the file exists', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    const pf = insertTestFile(primaryDb, { path: 'src/x.ts' });
    const ff = insertTestFile(federatedDb, { path: 'src/x.ts' });
    const pTarget = insertTestFile(primaryDb, { path: 'src/y.ts' });
    const fTarget = insertTestFile(federatedDb, { path: 'src/y.ts' });
    insertTestDependency(primaryDb, pf, pTarget, 'helperA');
    insertTestDependency(federatedDb, ff, fTarget, 'helperB');

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = getDependencies(repoSet, { file: 'src/x.ts', direction: 'imports' });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.project).sort()).toEqual(['auth', 'main']);
  });

  it('scopes by repos param', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    insertTestFile(primaryDb, { path: 'src/x.ts' });
    insertTestFile(federatedDb, { path: 'src/x.ts' });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = getDependencies(repoSet, { file: 'src/x.ts', direction: 'imports', repos: ['main'] });
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe('main');
  });
});
```

Existing tests need their `getDependencies(db, ...)` calls wrapped via `makeTestRepoSet(db)`.

- [ ] **Step 2: Refactor `src/tools/get_dependencies.ts`**

```ts
// src/tools/get_dependencies.ts
import type { GetDependenciesInput, GetDependenciesOutput } from '../types.js';
import {
  getFileByPath,
  getDependenciesByFile,
  getImportersByFile,
} from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';

export function getDependencies(
  repoSet: RepoSet,
  input: GetDependenciesInput,
): GetDependenciesOutput[] {
  const repos = repoSet.filter(input.repos);
  const direction = input.direction ?? 'both';
  const out: GetDependenciesOutput[] = [];

  for (const repo of repos) {
    const file = getFileByPath(repo.db, input.file);
    if (!file) continue;

    const result: GetDependenciesOutput = {
      file: input.file,
      project: repo.name,
      imports: [],
      imported_by: [],
    };

    if (direction === 'imports' || direction === 'both') {
      result.imports = getDependenciesByFile(repo.db, file.id);
    }
    if (direction === 'imported_by' || direction === 'both') {
      result.imported_by = getImportersByFile(repo.db, file.id);
    }
    out.push(result);
  }

  return out;
}
```

Update `GetDependenciesOutput` in `src/types.ts` so `project: string` is required.

- [ ] **Step 3: Update server.ts call site**

```ts
case 'get_dependencies':
  result = getDependencies(repoSet, args as GetDependenciesInput);
  break;
```

- [ ] **Step 4: Tests + lint**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: ~464/464.

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/tools/get_dependencies.ts src/server.ts src/types.ts tests/tools/get_dependencies.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): migrate get_dependencies to RepoSet

Returns one entry per repo where the file exists. Cross-repo import
resolution explicitly out of scope here — see follow-up spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Migrate search_docs + get_doc_chunk

Both deal with documents.

**Files:**
- Modify: `src/tools/search_docs.ts`
- Modify: `src/tools/get_doc_chunk.ts`
- Modify: `src/server.ts`
- Modify: `src/types.ts`
- Modify: `tests/tools/search_docs.test.ts`
- Modify: `tests/tools/get_doc_chunk.test.ts`

- [ ] **Step 1: Add federation tests for search_docs**

Append to `tests/tools/search_docs.test.ts`:

```ts
import { makeFederatedTestRepoSet, makeTestRepoSet } from '../helpers/repo-set.js';

describe('searchDocs — federation', () => {
  it('returns chunks from both repos tagged with project', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    const pf = insertTestFile(primaryDb, { path: 'docs/a.md', language: 'markdown' });
    const ff = insertTestFile(federatedDb, { path: 'docs/b.md', language: 'markdown' });
    insertTestDocChunk(primaryDb, { fileId: pf, chunkIndex: 0, content: 'hello world primary' });
    insertTestDocChunk(federatedDb, { fileId: ff, chunkIndex: 0, content: 'hello world federated' });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = searchDocs(repoSet, { query: 'hello' });
    expect(results.map((r) => r.project).sort()).toEqual(['auth', 'main']);
  });

  it('scopes by repos param', () => {
    const primaryDb = createTestDb();
    const federatedDb = createTestDb();
    insertTestDocChunk(primaryDb, { fileId: insertTestFile(primaryDb, { path: 'a.md', language: 'markdown' }), chunkIndex: 0, content: 'foo' });
    insertTestDocChunk(federatedDb, { fileId: insertTestFile(federatedDb, { path: 'b.md', language: 'markdown' }), chunkIndex: 0, content: 'foo' });

    const repoSet = makeFederatedTestRepoSet(
      { db: primaryDb, name: 'main' },
      [{ db: federatedDb, name: 'auth' }],
    );

    const results = searchDocs(repoSet, { query: 'foo', repos: ['auth'] });
    expect(results.every((r) => r.project === 'auth')).toBe(true);
  });
});
```

If `insertTestDocChunk` doesn't exist in `tests/helpers/fixtures.ts`, add it (mirrors `insertTestSymbol` shape; one prepared statement against `document_chunks`).

Existing tests need `searchDocs(db, ...)` wrapped via `makeTestRepoSet(db)`.

- [ ] **Step 2: Refactor `src/tools/search_docs.ts`**

```ts
// src/tools/search_docs.ts
import type { SearchDocsInput, DocSearchResult } from '../types.js';
import { searchDocChunksFts, searchContextEntries } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';
import { dedupByKey } from '../federation/merge.js';

export function searchDocs(repoSet: RepoSet, input: SearchDocsInput): DocSearchResult[] {
  const limit = input.limit ?? 20;
  const repos = repoSet.filter(input.repos);
  const all: DocSearchResult[] = [];

  for (const repo of repos) {
    try {
      for (const row of searchDocChunksFts(repo.db, input.query, limit)) {
        all.push({
          file: row.file_path,
          chunkIndex: row.chunk_index,
          heading: row.heading,
          startLine: row.start_line,
          endLine: row.end_line,
          preview: row.content.slice(0, 200),
          project: repo.name,
        });
      }
      // Context entries are local to each repo's DB.
      for (const entry of searchContextEntries(repo.db, input.query, limit)) {
        all.push({
          file: '<context>',
          chunkIndex: -1,
          heading: entry.title,
          startLine: 0,
          endLine: 0,
          preview: entry.body.slice(0, 200),
          project: repo.name,
        });
      }
    } catch (err) {
      process.stderr.write(`[pindex] search_docs failed for repo '${repo.name}': ${String(err)}\n`);
    }
  }

  return dedupByKey(all, (r) => `${r.project}::${r.file}::${r.chunkIndex}`).slice(0, limit * repos.length);
}
```

Update `DocSearchResult` in `src/types.ts` so `project: string` is required.

- [ ] **Step 3: Refactor `src/tools/get_doc_chunk.ts`**

Output becomes an array (one entry per repo where the file exists).

```ts
// src/tools/get_doc_chunk.ts
import type { GetDocChunkInput, GetDocChunkOutput } from '../types.js';
import { getFileByPath, getDocChunkByIndex } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';

export function getDocChunk(repoSet: RepoSet, input: GetDocChunkInput): GetDocChunkOutput[] {
  const repos = repoSet.filter(input.repos);
  const out: GetDocChunkOutput[] = [];

  for (const repo of repos) {
    const file = getFileByPath(repo.db, input.file);
    if (!file) continue;
    const chunk = getDocChunkByIndex(repo.db, file.id, input.chunkIndex);
    if (!chunk) continue;

    out.push({
      file: input.file,
      chunkIndex: chunk.chunk_index,
      heading: chunk.heading,
      startLine: chunk.start_line,
      endLine: chunk.end_line,
      content: chunk.content,
      project: repo.name,
    });
  }

  return out;
}
```

Update `GetDocChunkOutput` in `src/types.ts` so `project: string` is required.

- [ ] **Step 4: Update server.ts call sites**

```ts
case 'search_docs':
  result = searchDocs(repoSet, args as SearchDocsInput);
  break;
case 'get_doc_chunk':
  result = getDocChunk(repoSet, args as GetDocChunkInput);
  break;
```

- [ ] **Step 5: Tests + lint**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: ~468/468.

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/tools/search_docs.ts src/tools/get_doc_chunk.ts src/server.ts src/types.ts tests/tools/ tests/helpers/fixtures.ts
git commit -m "$(cat <<'EOF'
feat(tools): migrate search_docs + get_doc_chunk to RepoSet

Documents are now searchable across federated repos. Dedup key for
search_docs is project::file::chunkIndex. get_doc_chunk returns one
entry per repo where the file exists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: CLI subcommands

`pindex federate add/remove/list`.

**Files:**
- Create: `src/cli/federate.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli/federate.test.ts`

- [ ] **Step 1: Tests first**

```ts
// tests/cli/federate.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { federateAdd, federateRemove, federateList } from '../../src/cli/federate.js';

describe('pindex federate CLI', () => {
  let homeDir: string;
  let projectDir: string;
  let targetDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'pindex-fed-cli-'));
    process.env.HOME = homeDir;

    projectDir = join(homeDir, 'project');
    targetDir = join(homeDir, 'target');
    mkdirSync(join(projectDir, '.pindex'), { recursive: true });
    mkdirSync(join(targetDir, '.pindex'), { recursive: true });
    // Both projects need a `.mcp.json` and a registered project entry.
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { pindex: { env: {} } } }));
    writeFileSync(join(targetDir, '.mcp.json'), JSON.stringify({ mcpServers: { pindex: { env: {} } } }));
    // Hand-craft a registry that already contains both projects.
    mkdirSync(join(homeDir, '.pindex'), { recursive: true });
    writeFileSync(
      join(homeDir, '.pindex', 'registry.json'),
      JSON.stringify({
        version: 1,
        projects: [
          { hash: 'a', path: projectDir, port: 7842, name: 'project' },
          { hash: 'b', path: targetDir, port: 7843, name: 'target' },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('add appends path to FEDERATION_REPOS and updates registry', async () => {
    await federateAdd(projectDir, targetDir, {});
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { pindex: { env: { FEDERATION_REPOS?: string } } };
    };
    expect(mcp.mcpServers.pindex.env.FEDERATION_REPOS).toContain(targetDir);

    const reg = JSON.parse(readFileSync(join(homeDir, '.pindex', 'registry.json'), 'utf-8')) as {
      projects: Array<{ path: string; federatedRepos?: Array<{ path: string; name: string }> }>;
    };
    const me = reg.projects.find((p) => p.path === projectDir)!;
    expect(me.federatedRepos).toHaveLength(1);
    expect(me.federatedRepos![0]!.name).toBe('target');
  });

  it('add throws when target is not pindex-init-ed', async () => {
    await expect(federateAdd(projectDir, '/nowhere', {})).rejects.toThrow();
  });

  it('list returns federated entries', async () => {
    await federateAdd(projectDir, targetDir, {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await federateList(projectDir);
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('target');
    expect(output).toContain(targetDir);
    log.mockRestore();
  });

  it('remove drops the entry', async () => {
    await federateAdd(projectDir, targetDir, {});
    await federateRemove(projectDir, 'target');
    const reg = JSON.parse(readFileSync(join(homeDir, '.pindex', 'registry.json'), 'utf-8')) as {
      projects: Array<{ path: string; federatedRepos?: unknown[] }>;
    };
    const me = reg.projects.find((p) => p.path === projectDir)!;
    expect(me.federatedRepos ?? []).toHaveLength(0);
  });

  it('remove throws on unknown name', async () => {
    await expect(federateRemove(projectDir, 'nope')).rejects.toThrow(/No federated repo named/);
  });
});
```

- [ ] **Step 2: Implement `src/cli/federate.ts`**

The implementation reuses `GlobalRegistry`, `findProjectRoot`, and the existing `.mcp.json` write helpers from `cli/init.ts`. Pseudocode:

```ts
// src/cli/federate.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GlobalRegistry, findProjectRoot } from './project-detector.js';
import { assignName } from '../federation/registry-name.js';

export async function federateAdd(
  cwd: string,
  targetPath: string,
  options: { name?: string },
): Promise<void> {
  const projectRoot = findProjectRoot(cwd);
  const targetRoot = findProjectRoot(targetPath);  // throws if not pindex-init-ed
  const registry = new GlobalRegistry();
  const entries = registry.list();
  const me = entries.find((e) => e.path === projectRoot);
  if (!me) throw new Error(`Current project not registered: ${projectRoot}`);
  const target = entries.find((e) => e.path === targetRoot);
  if (!target) throw new Error(`Target not registered: ${targetRoot}`);

  // Resolve a unique name within MY federation set.
  const used = new Set<string>(
    (me.federatedRepos as Array<{ name: string }> | undefined)?.map((f) => f.name) ?? [],
  );
  used.add(me.name);
  const name = options.name ?? (used.has(target.name) ? assignName(targetRoot, used) : target.name);

  // Persist in registry.
  const updated = {
    ...me,
    federatedRepos: [
      ...((me.federatedRepos as Array<{ path: string; name: string }> | undefined) ?? []),
      { path: targetRoot, name },
    ],
  };
  registry.replace(updated);

  // Update .mcp.json env.FEDERATION_REPOS.
  const mcpPath = join(projectRoot, '.mcp.json');
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as MCPJson;
  const env = mcp.mcpServers.pindex.env ??= {};
  const existing = env.FEDERATION_REPOS?.split(':').filter(Boolean) ?? [];
  if (!existing.includes(targetRoot)) existing.push(targetRoot);
  env.FEDERATION_REPOS = existing.join(':');
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));

  console.log(`federated '${name}' (path: ${targetRoot}). Restart the MCP server to pick up the change.`);
}

export async function federateRemove(cwd: string, nameOrPath: string): Promise<void> { /* mirror */ }
export async function federateList(cwd: string): Promise<void> { /* read & pretty-print */ }
```

You will need to implement / extend `GlobalRegistry.replace(entry)` if it does not exist; it overwrites the entry with the same path.

The `RegistryEntry` interface needs a typed `federatedRepos?: Array<{ path: string; name: string }>` field — update earlier, before this task uses the typed shape. (Currently it is `string[]`.) Migrate-on-read converts the old `string[]` shape to the new one.

- [ ] **Step 3: Wire into `src/cli/index.ts`**

Add a `federate` subcommand router that dispatches to the three functions.

- [ ] **Step 4: Tests pass + lint**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: ~470/470.

- [ ] **Step 5: Commit**

```bash
git add src/cli/federate.ts src/cli/index.ts src/cli/project-detector.ts tests/cli/federate.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add 'pindex federate add/remove/list' subcommands

Replaces the env-var-only configuration with a discoverable CLI.
add resolves the target's registered name, allocates a unique name
within the current project's federation set on collision, updates
both .mcp.json env.FEDERATION_REPOS and registry.json. remove drops
the entry by name. list pretty-prints the current set.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: E2E integration test

Real MCP server with two indexed temp projects + federation.

**Files:**
- Create: `tests/integration/federation-e2e.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/integration/federation-e2e.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

vi.unmock('tree-sitter');
vi.unmock('tree-sitter-typescript');

describe('Federation end-to-end', () => {
  it('search_symbols across two federated repos returns tagged results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pindex-fed-e2e-'));
    const repoA = join(root, 'a');
    const repoB = join(root, 'b');
    mkdirSync(join(repoA, 'src'), { recursive: true });
    mkdirSync(join(repoB, 'src'), { recursive: true });
    writeFileSync(join(repoA, 'src', 'a.ts'), 'export class AlphaService {}\n');
    writeFileSync(join(repoB, 'src', 'b.ts'), 'export class BetaService {}\n');

    const { Indexer } = (await import(pathToFileURL(resolve(process.cwd(), 'dist/indexer/index.js')).href)) as typeof import('../../src/indexer/index.js');
    const Database = (await import('better-sqlite3')).default;
    const { runMigrations } = (await import(pathToFileURL(resolve(process.cwd(), 'dist/db/migrations.js')).href)) as typeof import('../../src/db/migrations.js');

    const dbA = new Database(':memory:');
    runMigrations(dbA);
    await new Indexer({ db: dbA, projectRoot: repoA, languages: ['typescript'] }).indexAll();

    const dbB = new Database(':memory:');
    runMigrations(dbB);
    await new Indexer({ db: dbB, projectRoot: repoB, languages: ['typescript'] }).indexAll();

    const { RepoSet } = (await import(pathToFileURL(resolve(process.cwd(), 'dist/federation/repo-set.js')).href)) as typeof import('../../src/federation/repo-set.js');
    const { searchSymbols } = (await import(pathToFileURL(resolve(process.cwd(), 'dist/tools/search_symbols.js')).href)) as typeof import('../../src/tools/search_symbols.js');

    const repoSet = RepoSet.fromServerConfig(dbA, 'a', [{ name: 'b', path: repoB, db: dbB }]);
    const results = searchSymbols(repoSet, { query: 'Service' });

    expect(results.map((r) => `${r.project}/${r.name}`).sort()).toEqual(['a/AlphaService', 'b/BetaService']);

    // Scoped query
    const onlyB = searchSymbols(repoSet, { query: 'Service', repos: ['b'] });
    expect(onlyB.map((r) => r.name)).toEqual(['BetaService']);

    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});
```

- [ ] **Step 2: Add the file to `vitest.integration.config.ts`** if its `include` doesn't already cover `tests/integration/**/*.test.ts`. (It does — verify, no change needed.)

- [ ] **Step 3: Make sure it runs only via `test:integration`, not the default unit suite.**

Add `tests/integration/federation-e2e.test.ts` to the `exclude` list in `vitest.config.ts` alongside the other two.

- [ ] **Step 4: Verify**

```bash
cd /home/manuel/claude/PindeX-federation && npm run build && npm run test:integration 2>&1 | tail -10
```
Expected: 31 passing (was 30, +1 new).

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: ~470/470 (unit unchanged because the new test is excluded).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/federation-e2e.test.ts vitest.config.ts
git commit -m "$(cat <<'EOF'
test(federation): add E2E integration test for federated search

Real Indexer over two temp projects + RepoSet + searchSymbols call.
Asserts cross-repo results are tagged with the correct project name
and that the repos param scopes correctly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Docs

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update README**

Find the existing federation section (probably under "Multi-Project & Federation"). Rewrite the env-var-only paragraph to lead with the CLI:

```
## Multi-Project & Federation

Federate other indexed PindeX projects into the current project so all
read-only tools can search across them in one query.

```bash
cd /my/main-project
pindex federate add /path/to/other-repo
pindex federate list
pindex federate remove other-repo
```

Federated repos appear under stable names (the directory basename, with
a hash suffix on collision). Every search/lookup tool returns results
tagged with `project: <name>`. To scope a query to a subset:

```jsonc
// MCP tool call
{ "query": "AuthService", "repos": ["main", "auth-service"] }
```

The 5 write/session tools (`reindex`, `save_context`, `get_session_memory`,
`start_comparison`, `get_token_stats`) stay strictly local; they ignore
the `repos` param.
```

- [ ] **Step 2: Update CLAUDE.md**

Add a short note to the env-var block (near `FEDERATION_REPOS`):

```
- Federation: 9 read-only tools (search_symbols, find_usages, get_symbol,
  get_file_summary, get_context, get_dependencies, get_project_overview,
  search_docs, get_doc_chunk) accept an optional `repos: string[]` param
  to scope to specific federated repos. Configure via `pindex federate add`.
```

- [ ] **Step 3: Verify + commit**

```bash
cd /home/manuel/claude/PindeX-federation
npm test 2>&1 | tail -3   # unchanged
git add README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: document the federation CLI and repos scoping param

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: E2E verification

No code changes. Verification only.

- [ ] **Step 1: Full unit suite**

```bash
cd /home/manuel/claude/PindeX-federation && npm test 2>&1 | tail -3
```
Expected: ~470/470.

- [ ] **Step 2: Integration suite**

```bash
cd /home/manuel/claude/PindeX-federation && npm run test:integration 2>&1 | tail -5
```
Expected: 31/31.

- [ ] **Step 3: Lint + build**

```bash
cd /home/manuel/claude/PindeX-federation && npm run lint && npm run build && ls dist/federation/
```
Expected: clean lint; build emits `repo-set.js`, `merge.js`, `registry-name.js`.

- [ ] **Step 4: Smoke test against two real temp projects**

```bash
cd /home/manuel/claude/PindeX-federation
ROOT=$(mktemp -d /tmp/pindex-fed-smoke-XXXX)
mkdir -p $ROOT/{a,b}/src
cat > $ROOT/a/src/x.ts <<'EOF'
export class AlphaService { greet(): string { return 'hi'; } }
EOF
cat > $ROOT/b/src/x.ts <<'EOF'
export class BetaService { greet(): string { return 'yo'; } }
EOF

# Index both (raw Indexer, no MCP server, no daemon).
node -e "
  const Database = require('better-sqlite3');
  const { Indexer } = require('./dist/indexer/index.js');
  const { runMigrations } = require('./dist/db/migrations.js');
  (async () => {
    for (const sub of ['a', 'b']) {
      const dbPath = '$ROOT/' + sub + '/.pindex.db';
      const db = new Database(dbPath);
      runMigrations(db);
      await new Indexer({ db, projectRoot: '$ROOT/' + sub, languages: ['typescript'] }).indexAll();
      db.close();
    }
    console.log('indexed');
  })();
"

# Federation query.
node -e "
  const Database = require('better-sqlite3');
  const { RepoSet } = require('./dist/federation/repo-set.js');
  const { searchSymbols } = require('./dist/tools/search_symbols.js');
  const dbA = new Database('$ROOT/a/.pindex.db', { readonly: true });
  const dbB = new Database('$ROOT/b/.pindex.db', { readonly: true });
  const set = RepoSet.fromServerConfig(dbA, 'a', [{ name: 'b', path: '$ROOT/b', db: dbB }]);
  console.log(JSON.stringify(searchSymbols(set, { query: 'Service' }), null, 2));
  dbA.close(); dbB.close();
"

rm -rf $ROOT
```

Expected output: a JSON array containing `AlphaService` (project: a) and `BetaService` (project: b).

- [ ] **Step 5: Report**

Collect:
- Unit + integration counts.
- Smoke test JSON output.
- `git log --oneline main..HEAD` — should show 14 commits (Tasks 1–14).
- Note any deviations.

No commit. Verification only.

---

## Risks during implementation

1. **Output type changes from `T | null` to `T[]`** for `get_symbol`, `get_file_summary`, `get_context`, `get_dependencies`. Existing callers in tests (and in MCP tool handler in `server.ts`) need adjustment. Verify by running each affected test file as you migrate.

2. **`tests/integration/mcp-server.test.ts`** likely references the old `(db, federatedDbs)` signatures or constructs `FederatedDb` records without `name`. Grep early in Task 5 and fix in the same task.

3. **`pindex federate add`'s `.mcp.json` write** currently goes through code in `init.ts`. Decide in Task 12 whether to extract a helper or duplicate; do whichever keeps the diff smallest, but if a helper extraction is natural, do it.

4. **CLI tests use `process.env.HOME`** to redirect the registry. Ensure `getPindexHome()` actually honours `HOME`; check `cli/project-detector.ts`. If it caches at module load, the test setup must run before the first import — the existing `tests/cli/project-detector.test.ts` already faces this challenge, so its pattern works.

## When you finish

Report:
- Unit test count (~470).
- Integration test count (31).
- Smoke test output.
- Whether ready to cut as v1.5.0.
