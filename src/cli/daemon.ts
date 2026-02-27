import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getMcpIndexerHome } from './project-detector.js';

const PID_FILE = join(getMcpIndexerHome(), 'daemon.pid');

/** Returns the PID of the running daemon, or null if not running. */
export function getDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    // Check if the process is still running
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Returns true if the daemon is currently running. */
export function isDaemonRunning(): boolean {
  return getDaemonPid() !== null;
}

/** Writes the PID file. */
export function writePidFile(pid: number): void {
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

/** Removes the PID file. */
export function removePidFile(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

/** Stops the daemon gracefully. */
export async function stopDaemon(): Promise<void> {
  const pid = getDaemonPid();
  if (!pid) {
    console.log('Daemon is not running.');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    removePidFile();
    console.log(`Daemon stopped (PID ${pid}).`);
  } catch (err) {
    console.error(`Failed to stop daemon: ${String(err)}`);
    removePidFile();
  }
}

/** Prints daemon and project status to stdout. */
export async function showStatus(): Promise<void> {
  const pid = getDaemonPid();
  if (pid) {
    console.log(`Daemon running (PID ${pid})`);
  } else {
    console.log('Daemon not running');
  }
}
