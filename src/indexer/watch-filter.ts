import { isAbsolute, relative } from 'node:path';
import { Minimatch } from 'minimatch';
import { normalizeRelPath } from '../util/paths.js';

/** Decides which paths the file watcher reports. chokidar 4 dropped glob support, so the
 *  glob semantics that `indexAll()` gets from `glob` (default `dot: false`) live here. */
export interface WatchFilter {
  /** chokidar `ignored` callback: true prunes the path (directories are not descended). */
  ignored(path: string, stats?: { isFile(): boolean; isDirectory(): boolean }): boolean;
  /** True when a project-relative file path is one the indexer handles. */
  accepts(relPath: string): boolean;
}

export interface WatchFilterOptions {
  projectRoot: string;
  /** Glob patterns of files to report, e.g. `**\/*.ts`. */
  include: readonly string[];
  /** Glob patterns to prune, e.g. `**\/node_modules/**`. */
  ignore: readonly string[];
}

/** Child segment used to ask whether every path below a directory is ignored. */
const PROBE_CHILD = '__pindex_probe__';

export function createWatchFilter(options: WatchFilterOptions): WatchFilter {
  const include = options.include.map((p) => new Minimatch(p));
  const ignore = options.ignore.map((p) => new Minimatch(p));

  const toRel = (path: string): string =>
    normalizeRelPath(isAbsolute(path) ? relative(options.projectRoot, path) : path);

  const isIgnoredPath = (rel: string): boolean => ignore.some((m) => m.match(rel));

  // A directory is pruned when an ignore pattern covers everything below it
  // (`**/node_modules/**`) or when it is a dot directory: with `dot: false` no
  // include pattern can match inside it (.git, .pindex, .venv, ...).
  const isIgnoredDir = (rel: string): boolean => {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return base.startsWith('.') || isIgnoredPath(`${rel}/${PROBE_CHILD}`);
  };

  const accepts = (relPath: string): boolean => {
    const rel = normalizeRelPath(relPath);
    if (rel === '' || rel.startsWith('../')) return false;
    if (isIgnoredPath(rel)) return false;
    const dirs = rel.split('/').slice(0, -1);
    for (let i = 1; i <= dirs.length; i++) {
      if (isIgnoredDir(dirs.slice(0, i).join('/'))) return false;
    }
    return include.some((m) => m.match(rel));
  };

  const ignored: WatchFilter['ignored'] = (path, stats) => {
    const rel = toRel(path);
    if (rel === '') return false; // the project root itself
    if (rel.startsWith('../')) return true;
    if (isIgnoredPath(rel)) return true;
    if (stats?.isDirectory()) return isIgnoredDir(rel);
    if (stats?.isFile()) return !accepts(rel);
    // No stats (chokidar asks once before stat-ing, and for unlinks): only prune what
    // is certainly ignored; unknown entries pass and accepts() filters events later.
    return false;
  };

  return { ignored, accepts };
}
