import type { GetDependenciesInput, GetDependenciesOutput } from '../types.js';
import { getFileByPath, getDependenciesByFile, getImportedByFile } from '../db/queries.js';
import type { RepoSet } from '../federation/repo-set.js';
import { resolveWithinRoot } from '../util/paths.js';

export function getDependencies(
  repoSet: RepoSet,
  input: GetDependenciesInput,
): GetDependenciesOutput[] {
  const repos = repoSet.filter(input.repos);
  const direction = input.direction ?? 'both';
  const out: GetDependenciesOutput[] = [];

  for (const repo of repos) {
    if (repo.path && !resolveWithinRoot(repo.path, input.target)) continue;

    const file = getFileByPath(repo.db, input.target);
    if (!file) continue;

    const result: GetDependenciesOutput = {
      file: input.target,
      project: repo.name,
      imports: [],
      importedBy: [],
    };

    if (direction === 'imports' || direction === 'both') {
      result.imports = getDependenciesByFile(repo.db, file.id);
    }
    if (direction === 'imported_by' || direction === 'both') {
      result.importedBy = getImportedByFile(repo.db, file.id);
    }
    out.push(result);
  }

  return out;
}
