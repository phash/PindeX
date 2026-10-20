import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getProjectsDir,
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

/** True only if a process command line belongs to a pindex server/CLI
 *  (contains `pindex` or `dist/index.js`). A bare `node` is NOT enough. */
export function isPindexProcess(cmdline: string): boolean {
  return /pindex|dist[\\/]index\.js/i.test(cmdline);
}

/** Best-effort check that a PID belongs to a pindex process before we signal
 *  it, guarding against PID reuse killing an unrelated process (SEC-14). On
 *  platforms without /proc (macOS/Windows) the check is skipped (returns true). */
function isLikelyPindexProcess(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
    if (!cmdline) return true; // empty — cannot tell, do not block
    return isPindexProcess(cmdline);
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
