import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// TST-12: daemon PID-file lifecycle tests.
//
// Strategy: redirect ~/.pindex to a temp dir by mocking node:os homedir. This
// keeps the REAL getPindexHome/getProjectsDir/ensurePindexHome/writeFileSecure
// (and their internal cross-calls) intact while pointing all file I/O at TMP,
// so both getPidFilePath branches (project-hash + global) work cleanly.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

const HASH = 'abcd1234';

describe('daemon (TST-12)', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `pindex-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });

    const { homedir } = await import('node:os');
    vi.mocked(homedir).mockReturnValue(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writePidFile then getDaemonPid returns own (alive) pid and isDaemonRunning is true', async () => {
    const { writePidFile, getDaemonPid, isDaemonRunning } = await import('../../src/cli/daemon.js');

    writePidFile(process.pid, HASH);

    // process.kill(ownPid, 0) succeeds (signal 0 = liveness probe, no kill).
    expect(getDaemonPid(HASH)).toBe(process.pid);
    expect(isDaemonRunning(HASH)).toBe(true);
  });

  it('getDaemonPid returns null for a bogus (dead) pid (ESRCH caught)', async () => {
    const { getProjectsDir } = await import('../../src/cli/project-detector.js');
    const { getDaemonPid } = await import('../../src/cli/daemon.js');

    // Manually plant a PID file with a pid that does not exist.
    const dir = join(getProjectsDir(), HASH);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.pid'), '999999999', 'utf-8');

    expect(getDaemonPid(HASH)).toBeNull();
  });

  it('getDaemonPid returns null for a non-numeric pid file (NaN path)', async () => {
    const { getProjectsDir } = await import('../../src/cli/project-detector.js');
    const { getDaemonPid } = await import('../../src/cli/daemon.js');

    const dir = join(getProjectsDir(), HASH);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.pid'), 'not-a-pid', 'utf-8');

    // parseInt('not-a-pid') -> NaN -> process.kill(NaN, 0) throws -> caught -> null.
    expect(getDaemonPid(HASH)).toBeNull();
  });

  it('no PID file: getDaemonPid is null and stopDaemon logs "No running daemon" without throwing', async () => {
    const { getDaemonPid, stopDaemon } = await import('../../src/cli/daemon.js');

    expect(getDaemonPid(HASH)).toBeNull();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(stopDaemon(HASH)).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith('No running daemon found.');
  });

  it('stopDaemon with a live pid sends SIGTERM and removes the PID file', async () => {
    const { writePidFile, stopDaemon } = await import('../../src/cli/daemon.js');
    const { getProjectsDir } = await import('../../src/cli/project-detector.js');

    writePidFile(process.pid, HASH);
    const pidFile = join(getProjectsDir(), HASH, 'daemon.pid');
    expect(existsSync(pidFile)).toBe(true);

    // CRITICAL: never actually signal a real process. Stub process.kill to a no-op.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await stopDaemon(HASH);

    // getDaemonPid (liveness probe, signal 0) + the SIGTERM stop call.
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(existsSync(pidFile)).toBe(false);
  });

  it('SEC-14: stopDaemon removes the PID file even when process.kill throws', async () => {
    const { writePidFile, stopDaemon } = await import('../../src/cli/daemon.js');
    const { getProjectsDir } = await import('../../src/cli/project-detector.js');

    writePidFile(process.pid, HASH);
    const pidFile = join(getProjectsDir(), HASH, 'daemon.pid');
    expect(existsSync(pidFile)).toBe(true);

    // First call is getDaemonPid's signal-0 liveness probe (must succeed so we get
    // a live pid); the SIGTERM stop call then throws.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 'SIGTERM') throw new Error('boom');
      return true;
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(stopDaemon(HASH)).resolves.toBeUndefined();

    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(existsSync(pidFile)).toBe(false);
  });

  it('covers the global (no-hash) getPidFilePath branch', async () => {
    const { writePidFile, getDaemonPid, removePidFile } = await import('../../src/cli/daemon.js');
    const { getPindexHome } = await import('../../src/cli/project-detector.js');

    writePidFile(process.pid);

    const globalPidFile = join(getPindexHome(), 'daemon.pid');
    expect(existsSync(globalPidFile)).toBe(true);
    expect(getDaemonPid()).toBe(process.pid);

    removePidFile();
    expect(existsSync(globalPidFile)).toBe(false);
    expect(getDaemonPid()).toBeNull();
  });

  it('getPidFilePath creates the projects/<hash> dir when it does not exist yet', async () => {
    const { writePidFile } = await import('../../src/cli/daemon.js');
    const { getProjectsDir } = await import('../../src/cli/project-detector.js');

    const dir = join(getProjectsDir(), HASH);
    expect(existsSync(dir)).toBe(false); // fresh temp home — not created yet

    writePidFile(process.pid, HASH); // triggers the mkdirSync branch

    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(true);
  });

  it('removePidFile is a no-op when the PID file is absent (existsSync false branch)', async () => {
    const { removePidFile } = await import('../../src/cli/daemon.js');
    const { getProjectsDir } = await import('../../src/cli/project-detector.js');

    const pidFile = join(getProjectsDir(), HASH, 'daemon.pid');
    expect(existsSync(pidFile)).toBe(false);

    // Must not throw even though there's nothing to unlink.
    expect(() => removePidFile(HASH)).not.toThrow();
    expect(existsSync(pidFile)).toBe(false);
  });

  // POSIX-only: the SEC-14 guard verifies the PID via /proc/<pid>/cmdline and
  // deliberately fails open on platforms without /proc (see daemon.ts). On
  // Windows isLikelyPindexProcess() returns true, so there is no refusal to assert.
  it.skipIf(process.platform === 'win32')('SEC-14: stopDaemon refuses to SIGTERM a PID that is not a pindex/node process', async () => {
    const { writePidFile, stopDaemon } = await import('../../src/cli/daemon.js');
    const { getProjectsDir } = await import('../../src/cli/project-detector.js');

    // PID 1 (systemd/init) exists but /proc/1/cmdline does not match /pindex|node/i,
    // so isLikelyPindexProcess() returns false and stopDaemon must refuse.
    writePidFile(1, HASH);
    const pidFile = join(getProjectsDir(), HASH, 'daemon.pid');
    expect(existsSync(pidFile)).toBe(true);

    // Never signal a real process: stub kill so the signal-0 liveness probe in
    // getDaemonPid succeeds, and assert SIGTERM is NEVER attempted.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await stopDaemon(HASH);

    expect(errSpy).toHaveBeenCalledWith(
      'Refusing to stop: PID does not look like a pindex daemon (stale PID file?).',
    );
    expect(killSpy).not.toHaveBeenCalledWith(1, 'SIGTERM');
    // Stale PID file is cleaned up on refusal.
    expect(existsSync(pidFile)).toBe(false);
  });

  it('showStatus prints the running PID when a live daemon exists (with projectPath)', async () => {
    const { writePidFile, showStatus } = await import('../../src/cli/daemon.js');
    const { hashProjectPath } = await import('../../src/cli/project-detector.js');

    const projectPath = '/some/project/path';
    writePidFile(process.pid, hashProjectPath(projectPath));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await showStatus(projectPath);

    expect(logSpy).toHaveBeenCalledWith(`Daemon running (PID ${process.pid})`);
  });

  it('showStatus prints "No daemon running" when no PID file exists (global, no projectPath)', async () => {
    const { showStatus } = await import('../../src/cli/daemon.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await showStatus(); // hash undefined → global path

    expect(logSpy).toHaveBeenCalledWith('No daemon running');
  });
});
