// src/indexer/parse-worker.ts
import { readFileSync, statSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { parseFile, hashContent } from './parser.js';
import type { ParseJobInput, ParseJobResult } from './parse-types.js';

if (!parentPort) {
  throw new Error('parse-worker.ts must be loaded as a worker_threads script');
}

interface WorkerMessage {
  jobId: number;
  job: ParseJobInput;
  maxFileSize: number;
}

parentPort.on('message', (msg: WorkerMessage) => {
  const result = runJob(msg.job, msg.maxFileSize);
  parentPort!.postMessage({ jobId: msg.jobId, result });
});

function runJob(job: ParseJobInput, maxFileSize: number): ParseJobResult {
  try {
    const st = statSync(job.absolutePath);
    if (st.size > maxFileSize) {
      return { status: 'skipped', relativePath: job.relativePath, reason: 'too_large' };
    }
  } catch (err) {
    process.stderr.write(`[pindex] parse-worker: stat failed for ${job.relativePath}: ${String(err)}\n`);
    return { status: 'skipped', relativePath: job.relativePath, reason: 'not_found' };
  }

  let content: string;
  try {
    content = readFileSync(job.absolutePath, 'utf-8');
  } catch (err) {
    return { status: 'error', relativePath: job.relativePath, error: String(err) };
  }

  try {
    const parsed = parseFile(job.absolutePath, content);
    const hash = hashContent(content);
    return { status: 'ok', relativePath: job.relativePath, parsed, hash, content };
  } catch (err) {
    return { status: 'error', relativePath: job.relativePath, error: String(err) };
  }
}
