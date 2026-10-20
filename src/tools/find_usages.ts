import type { FindUsagesInput, UsageResult } from '../types.js';
import type { RepoSet } from '../federation/repo-set.js';

// TODO(Task 4): replaced by a symbol_refs based implementation. The usages
// table was never populated, so returning [] preserves the real behaviour.
export function findUsages(_repoSet: RepoSet, _input: FindUsagesInput): UsageResult[] {
  return [];
}
