// src/indexer/parse-types.ts
import type { ParsedFile, ParsedImport } from '../types.js';

export type { ParsedFile, ParsedImport };

/** Job submitted to the pool. Paths are absolute for the worker's readFile,
 *  and project-relative for the main thread's DB lookups. */
export interface ParseJobInput {
  absolutePath: string;
  relativePath: string;
}

export type ParseJobResult =
  | {
      status: 'ok';
      relativePath: string;
      parsed: ParsedFile;
      hash: string;
      /** File content, sent back so the main thread can slice snippets /
       *  summarise without a second disk read. */
      content: string;
    }
  | {
      status: 'skipped';
      relativePath: string;
      reason: 'too_large' | 'not_found';
    }
  | {
      status: 'error';
      relativePath: string;
      error: string;
    };

export interface ParsePoolOptions {
  /** 0 = run synchronously in the calling thread (test mode).
   *  N > 0 = spawn N worker_threads. */
  maxWorkers: number;
  /** Max file size in bytes; larger files are returned as 'skipped'. Defaults to 1 MB. */
  maxFileSize?: number;
}
