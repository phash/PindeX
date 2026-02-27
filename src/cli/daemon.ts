import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPindexHome, getProjectsDir, hashProjectPath } from './project-detector.js';

/** Returns the PID file path for a given project (or the global fallback). */
function getPidFilePath(projectHash?: string): string {
  if (projectHash) {
    const dir = join(getProjectsDir(), projectHash);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'daemon.pid');
  }
  return join(getPindexHome(), 'daemon.pid');
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

/** Writes the PID file for the given project. */
export function writePidFile(pid: number, projectHash?: string): void {
  writeFileSync(getPidFilePath(projectHash), String(pid), 'utf-8');
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
