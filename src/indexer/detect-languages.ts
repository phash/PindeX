import { glob } from 'glob';
import { LANGUAGE_PATTERNS, DEFAULT_IGNORE, DEFAULT_LANGUAGES } from './index.js';

// Reverse map: file extension -> language key, derived from LANGUAGE_PATTERNS so
// the two stay in sync (e.g. .tsx -> typescript, .jsx -> javascript).
const EXT_TO_LANG: Record<string, string> = {};
for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS)) {
  for (const p of patterns) {
    EXT_TO_LANG[p.slice(p.lastIndexOf('.'))] = lang;
  }
}

/**
 * Detects which supported code languages actually have files in the project.
 * Used to auto-configure LANGUAGES when the env var is not set — so a Python or
 * Go project is indexed correctly instead of silently defaulting to TS/JS.
 * Reuses the indexer's ignore patterns so build/vendor dirs don't skew the
 * result. Falls back to the TS/JS default when nothing is found or the scan
 * fails.
 */
export async function detectProjectLanguages(projectRoot: string): Promise<string[]> {
  const patterns = [...new Set(Object.values(LANGUAGE_PATTERNS).flat())];
  let files: string[];
  try {
    files = await glob(patterns, { cwd: projectRoot, ignore: DEFAULT_IGNORE, absolute: false });
  } catch {
    return [...DEFAULT_LANGUAGES];
  }
  const langs = new Set<string>();
  for (const f of files) {
    const lang = EXT_TO_LANG[f.slice(f.lastIndexOf('.'))];
    if (lang) langs.add(lang);
  }
  return langs.size > 0 ? [...langs].sort() : [...DEFAULT_LANGUAGES];
}
