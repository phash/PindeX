#!/usr/bin/env node
/**
 * Lean entry for the Claude Code PreToolUse hook. Imports only what the hook needs (no Indexer /
 * CLI graph) to keep per-Read startup low. Always exits 0 and never prints errors.
 */
import { runPreToolUseHook } from './hook.js';

async function main(): Promise<void> {
  let out = '';
  try {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    out = runPreToolUseHook({ stdin: Buffer.concat(chunks).toString('utf-8'), env: process.env });
  } catch {
    out = '';
  }
  process.stdout.write(out, () => process.exit(0));
}

void main();
