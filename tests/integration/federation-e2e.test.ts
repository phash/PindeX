import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

vi.unmock('tree-sitter');
vi.unmock('tree-sitter-typescript');

describe('Federation end-to-end', () => {
  it('search_symbols across two federated repos returns tagged results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pindex-fed-e2e-'));
    const repoA = join(root, 'a');
    const repoB = join(root, 'b');
    mkdirSync(join(repoA, 'src'), { recursive: true });
    mkdirSync(join(repoB, 'src'), { recursive: true });
    // Use a shared camelCase prefix (Fed*) so FTS5's unicode61 tokenizer can
    // match both symbols with a single prefix query.
    writeFileSync(join(repoA, 'src', 'a.ts'), 'export class FedAlpha {}\n');
    writeFileSync(join(repoB, 'src', 'b.ts'), 'export class FedBeta {}\n');

    const { Indexer } = (await import(
      pathToFileURL(resolve(process.cwd(), 'dist/indexer/index.js')).href
    )) as typeof import('../../src/indexer/index.js');
    const { runMigrations } = (await import(
      pathToFileURL(resolve(process.cwd(), 'dist/db/migrations.js')).href
    )) as typeof import('../../src/db/migrations.js');
    const { RepoSet } = (await import(
      pathToFileURL(resolve(process.cwd(), 'dist/federation/repo-set.js')).href
    )) as typeof import('../../src/federation/repo-set.js');
    const { searchSymbols } = (await import(
      pathToFileURL(resolve(process.cwd(), 'dist/tools/search_symbols.js')).href
    )) as typeof import('../../src/tools/search_symbols.js');

    const dbA = new Database(':memory:');
    runMigrations(dbA);
    await new Indexer({ db: dbA, projectRoot: repoA, languages: ['typescript'] }).indexAll();

    const dbB = new Database(':memory:');
    runMigrations(dbB);
    await new Indexer({ db: dbB, projectRoot: repoB, languages: ['typescript'] }).indexAll();

    const repoSet = RepoSet.fromServerConfig(
      dbA,
      'a',
      [{ name: 'b', path: repoB, db: dbB }],
      repoA,
    );

    // Unscoped: results from both repos.
    const all = searchSymbols(repoSet, { query: 'Fed*' });
    const seen = all.map((r) => `${r.project}/${r.name}`).sort();
    expect(seen).toContain('a/FedAlpha');
    expect(seen).toContain('b/FedBeta');

    // Scoped to b: only FedBeta.
    const onlyB = searchSymbols(repoSet, { query: 'Fed*', repos: ['b'] });
    expect(onlyB.map((r) => r.name)).toEqual(['FedBeta']);
    expect(onlyB.every((r) => r.project === 'b')).toBe(true);

    // Unknown repo: throws.
    expect(() => searchSymbols(repoSet, { query: 'Fed*', repos: ['nope'] })).toThrow(
      /Unknown repo name: 'nope'/,
    );

    dbA.close();
    dbB.close();
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});
