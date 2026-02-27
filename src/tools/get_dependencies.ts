import type Database from 'better-sqlite3';
import type { GetDependenciesInput, GetDependenciesOutput } from '../types.js';
import { getFileByPath, getDependenciesByFile, getImportedByFile } from '../db/queries.js';

export function getDependencies(
  db: Database.Database,
  input: GetDependenciesInput,
): GetDependenciesOutput {
  const direction = input.direction ?? 'both';

  const file = getFileByPath(db, input.target);
  if (!file) {
    return { imports: [], importedBy: [] };
  }

  const imports =
    direction === 'imports' || direction === 'both'
      ? getDependenciesByFile(db, file.id)
      : [];

  const importedBy =
    direction === 'imported_by' || direction === 'both'
      ? getImportedByFile(db, file.id)
      : [];

  return { imports, importedBy };
}
