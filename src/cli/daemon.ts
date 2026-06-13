import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getPindexHome,
  getProjectsDir,
  hashProjectPath,
  ensurePindexHome,
  writeFileSecure,
} from './project-detector.js';

/** Returns the PID file path for a given project (or the global fallback). */
function getPidFilePath(projectHash?: string): string {
  if (projectHash) {
    const dir = join(getProjectsDir(), projectHash);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, 'daemon.pid');
  }
  return join(ensurePindexHome(), 'daemon.pid');
}

/** Returns the PID of the running daemon for the given project, or null. */
export function getDaemonPid(projectHash?: string): number | null {
  const pidFile = getPidFilePath(projectHash);
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    process.kill(pid, 0); // throws if process doesn't exist
    return pid;
  } catch {
    return null;
  }
}

/** Returns true if the daemon is currently running for the given project. */
export function isDaemonRunning(projectHash?: string): boolean {
  return getDaemonPid(projectHash) !== null;
}

/** Best-effort check that a PID belongs to a pindex/node process before we signal
 *  it, guarding against PID reuse killing an unrelated process (SEC-14). On
 *  platforms without /proc (macOS/Windows) the check is skipped (returns true). */
function isLikelyPindexProcess(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    if (!cmdline) return true; // empty — cannot tell, do not block
    return /pindex|node/i.test(cmdline);
  } catch {
    return true; // /proc unavailable or unreadable — do not block stop
  }
}

/** Writes the PID file for the given project (owner-only, SEC-14). */
export function writePidFile(pid: number, projectHash?: string): void {
  writeFileSecure(getPidFilePath(projectHash), String(pid));
}

/** Removes the PID file. */
export function removePidFile(projectHash?: string): void {
  const pidFile = getPidFilePath(projectHash);
  if (existsSync(pidFile)) unlinkSync(pidFile);
}

/** Stops the daemon for the given project gracefully. */
export async function stopDaemon(projectHash?: string): Promise<void> {
  const pid = getDaemonPid(projectHash);
  if (!pid) {
    console.log('No running daemon found.');
    return;
  }

  if (!isLikelyPindexProcess(pid)) {
    console.error('Refusing to stop: PID does not look like a pindex daemon (stale PID file?).');
    removePidFile(projectHash);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    removePidFile(projectHash);
    console.log(`Daemon stopped (PID ${pid}).`);
  } catch (err) {
    console.error(`Failed to stop daemon: ${String(err)}`);
    removePidFile(projectHash);
  }
}

/** Prints daemon status for the given project (or global). */
export async function showStatus(projectPath?: string): Promise<void> {
  const hash = projectPath ? hashProjectPath(projectPath) : undefined;
  const pid = getDaemonPid(hash);
  if (pid) {
    console.log(`Daemon running (PID ${pid})`);
  } else {
    console.log('No daemon running');
  }
}
