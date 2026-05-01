/**
 * Process lifecycle helpers for detached daemon spawning.
 *
 * Manages PID file, log file, and spawn lock under ~/.munchfile/.
 * All on-disk artifacts use O_NOFOLLOW + mode 0o600. Directory is 0o700.
 *
 * Env whitelist for spawned children (see buildChildEnv):
 *   - HOME / USER / LOGNAME / PATH — basic identity + exec lookup
 *   - LANG / LC_ALL / LC_CTYPE / LC_MESSAGES / LC_TIME / TZ — locale
 *   - TMPDIR — per-user tmp dir (matters on macOS)
 *   - SSL_CERT_FILE / SSL_CERT_DIR / NODE_EXTRA_CA_CERTS — corp TLS
 *   - HTTPS_PROXY / HTTP_PROXY / NO_PROXY (+ lowercase) — corporate proxies
 *   - MUNCHFILE_API_BASE — staging vs prod API override
 * Excluded by design: NODE_OPTIONS, LD_LIBRARY_PATH, DYLD_LIBRARY_PATH
 * (security — prevents debugger attach + library injection).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

const CONFIG_DIR = path.join(os.homedir(), '.munchfile');

export const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');
export const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');
export const LOCK_PATH = path.join(CONFIG_DIR, 'spawn.lock');

export const WINDOWS_UNSUPPORTED_MESSAGE =
  'munchfile is not supported on Windows yet. Track progress: https://github.com/ebuntario/munchfile/issues.';

export interface PidFingerprint {
  pid: number;
  startedAt: number;
  execPath: string;
}

interface LockFingerprint {
  pid: number;
  startedAt: number;
}

export class UnsupportedPlatformError extends Error {
  constructor(message = WINDOWS_UNSUPPORTED_MESSAGE) {
    super(message);
    this.name = 'UnsupportedPlatformError';
  }
}

export class LockContentionError extends Error {
  constructor(message = 'Could not acquire spawn lock within timeout.') {
    super(message);
    this.name = 'LockContentionError';
  }
}

export class SpawnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnFailedError';
  }
}

export class SpawnTimeoutError extends Error {
  constructor(message = 'Daemon failed to become ready within 5s. See ~/.munchfile/daemon.log for details.') {
    super(message);
    this.name = 'SpawnTimeoutError';
  }
}

// Cached at module init. On Linux this is needed to convert /proc/<pid>/stat
// field 22 (clock ticks since boot) to seconds. Wrapped in try/catch so missing
// getconf (Windows, sandboxed env) silently falls back to 100 (POSIX standard).
const CLK_TCK: number = (() => {
  if (process.platform === 'win32') return 100;
  try {
    const raw = execFileSync('/usr/bin/getconf', ['CLK_TCK'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 100;
  } catch {
    return 100;
  }
})();

function assertNotWindows(): void {
  if (process.platform === 'win32') {
    throw new UnsupportedPlatformError();
  }
}

export function ensureConfigDir(): void {
  assertNotWindows();
  // W17: refuse to follow a symlink at ~/.munchfile/. chmodSync follows
  // symlinks, and intermediate-component O_NOFOLLOW does NOT protect us if
  // the directory itself is a symlink.
  try {
    const st = fs.lstatSync(CONFIG_DIR);
    if (st.isSymbolicLink()) {
      throw new Error(
        '~/.munchfile is a symlink — refusing to operate. ' +
          'Resolve manually: `rm ~/.munchfile && munchfile <command>`.'
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // mkdir's mode is umask-masked AND a no-op when the dir already exists.
  // chmod is idempotent and ensures upgrades from older 0o755 dirs land at 0o700.
  fs.chmodSync(CONFIG_DIR, 0o700);
}

export function readPidFile(): PidFingerprint | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(PID_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const data = fs.readFileSync(fd, 'utf8');
    const parsed = JSON.parse(data);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.execPath !== 'string'
    ) {
      return null;
    }
    return { pid: parsed.pid, startedAt: parsed.startedAt, execPath: parsed.execPath };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function writePidFile(fp: PidFingerprint): void {
  assertNotWindows();
  const fd = fs.openSync(
    PID_PATH,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    fs.writeSync(fd, JSON.stringify(fp));
  } finally {
    fs.closeSync(fd);
  }
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(PID_PATH);
  } catch {
    // ENOENT or already removed
  }
}

/**
 * Returns the kernel-recorded process start time in epoch milliseconds, or
 * null if it can't be determined. Used to detect PID recycling.
 *
 * darwin: parses `ps -o lstart=` (LC_ALL=C forces English month/day names).
 * linux: reads /proc/<pid>/stat field 22 (start time in clock ticks since boot)
 *   plus /proc/stat btime (boot time epoch seconds).
 */
export function psStartedAt(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = Date.parse(out.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Task name (in parens) can contain spaces and parens. Split on the
      // LAST `)` to skip past it.
      const lastParen = stat.lastIndexOf(')');
      if (lastParen < 0) return null;
      const after = stat.slice(lastParen + 1).trim();
      const fields = after.split(/\s+/);
      // fields[0] = state (field 3 of original line), fields[19] = starttime (field 22).
      const ticksRaw = fields[19];
      if (!ticksRaw) return null;
      const ticks = parseInt(ticksRaw, 10);
      if (!Number.isFinite(ticks)) return null;
      const procStat = fs.readFileSync('/proc/stat', 'utf8');
      const btimeMatch = procStat.match(/^btime (\d+)/m);
      if (!btimeMatch) return null;
      const btime = parseInt(btimeMatch[1], 10);
      return (btime + ticks / CLK_TCK) * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): 'alive' | 'dead' | 'foreign' {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'foreign';
    // Conservative: refuse to act on uncertain state.
    return 'dead';
  }
}

export function verifyFingerprint(
  fp: PidFingerprint
): 'ours' | 'recycled' | 'foreign' | 'dead' {
  const alive = isProcessAlive(fp.pid);
  if (alive === 'dead') return 'dead';
  if (alive === 'foreign') return 'foreign';
  // alive
  const kernelStart = psStartedAt(fp.pid);
  if (kernelStart === null) {
    // ps/proc unreadable — fall back per platform.
    // darwin: best-effort 'ours' (sandboxed `ps` is rare for user-launched CLIs).
    // linux: defensive 'foreign' (we couldn't confirm).
    return process.platform === 'darwin' ? 'ours' : 'foreign';
  }
  return Math.abs(fp.startedAt - kernelStart) <= 2000 ? 'ours' : 'recycled';
}

/**
 * Returns the fingerprint iff the PID file points at our daemon (live, with
 * matching kernel-recorded start time). On 'dead'/'recycled', housekeeps the
 * stale file. On 'foreign', leaves the file alone (B9).
 */
export function isOurDaemon(): PidFingerprint | null {
  const fp = readPidFile();
  if (!fp) return null;
  const verdict = verifyFingerprint(fp);
  if (verdict === 'ours') return fp;
  if (verdict === 'dead' || verdict === 'recycled') {
    removePidFile();
    return null;
  }
  // foreign — leave alone
  return null;
}

/** B18: returns true iff PID file exists AND verifyFingerprint == 'foreign'. */
export function peekForeignPid(): boolean {
  const fp = readPidFile();
  if (!fp) return false;
  return verifyFingerprint(fp) === 'foreign';
}

const LOCK_TIMEOUT_MS_DEFAULT = 8000;
const LOCK_RETRY_MS = 200;
const LOCK_STALENESS_MS = 120000;
const EMPTY_READ_THRESHOLD = 5; // 5 × 200ms = 1s before assuming crashed-writer-stale

export async function acquireSpawnLock(
  timeoutMs = LOCK_TIMEOUT_MS_DEFAULT
): Promise<() => void> {
  assertNotWindows();
  ensureConfigDir();
  const release = () => {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // already gone
    }
  };
  const deadline = Date.now() + timeoutMs;
  let emptyReadCount = 0;
  while (true) {
    try {
      const fd = fs.openSync(
        LOCK_PATH,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      try {
        const lockFp: LockFingerprint = { pid: process.pid, startedAt: Date.now() };
        fs.writeSync(fd, JSON.stringify(lockFp));
      } finally {
        fs.closeSync(fd);
      }
      return release;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Lock exists — inspect.
      let existing: LockFingerprint | null = null;
      let isEmpty = false;
      try {
        const rfd = fs.openSync(LOCK_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const data = fs.readFileSync(rfd, 'utf8');
          if (data.length === 0) {
            isEmpty = true;
          } else {
            const parsed = JSON.parse(data);
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              typeof parsed.pid === 'number' &&
              parsed.pid > 0 &&
              typeof parsed.startedAt === 'number'
            ) {
              existing = { pid: parsed.pid, startedAt: parsed.startedAt };
            } else {
              isEmpty = true; // treat malformed shape as empty
            }
          }
        } finally {
          fs.closeSync(rfd);
        }
      } catch {
        isEmpty = true; // read error / parse error — treat as empty
      }

      if (existing) {
        emptyReadCount = 0;
        const stale =
          Date.now() - existing.startedAt > LOCK_STALENESS_MS ||
          isProcessAlive(existing.pid) !== 'alive';
        if (stale) {
          try {
            fs.unlinkSync(LOCK_PATH);
          } catch {
            // someone else got to it
          }
          continue; // retry immediately
        }
      } else if (isEmpty) {
        emptyReadCount++;
        if (emptyReadCount >= EMPTY_READ_THRESHOLD) {
          // W18: writer crashed between openSync and writeSync. Unlink and retry.
          try {
            fs.unlinkSync(LOCK_PATH);
          } catch {
            // already gone
          }
          emptyReadCount = 0;
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new LockContentionError();
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

/**
 * Detects how this CLI was invoked and constructs spawn args for re-launching
 * the daemon as a detached child. Three runtime shapes:
 *   - Bun-compiled standalone binary (process.versions.bun is set)
 *   - tsx dev mode (loader registered via execArgv, OR argv[1] is a .ts file)
 *   - node default (npm-installed dist build)
 */
export function buildSpawnArgs(): { execPath: string; args: string[] } {
  // (1) Bun-compiled binary: process.versions.bun is the canonical signal.
  if (process.versions.bun !== undefined) {
    return {
      execPath: process.execPath,
      args: ['start', '--detached-child'],
    };
  }
  // (2) tsx mode: loader registered via execArgv OR argv[1] is .ts/.tsx.
  const argv1 = process.argv[1] ?? '';
  const tsxLoader = process.execArgv.some(a => a.includes('tsx'));
  const tsSource = argv1.endsWith('.ts') || argv1.endsWith('.tsx');
  if (tsxLoader || tsSource) {
    return {
      execPath: process.execPath,
      args: [...process.execArgv, argv1, 'start', '--detached-child'],
    };
  }
  // (3) node default (npm-installed dist).
  return {
    execPath: process.execPath,
    args: [argv1, 'start', '--detached-child'],
  };
}

export function buildChildEnv(): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LC_MESSAGES',
    'LC_TIME',
    'TZ',
    'TMPDIR',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'MUNCHFILE_API_BASE',
  ];
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const key of allowed) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

const SPAWN_READINESS_TIMEOUT_MS = 5000;
const SPAWN_POLL_MS = 100;

export async function spawnDetachedDaemon(): Promise<PidFingerprint> {
  assertNotWindows();
  ensureConfigDir();
  const existing = readPidFile();
  if (existing) {
    throw new SpawnFailedError(
      'Cannot spawn: ~/.munchfile/daemon.pid already exists. Caller must clear it first.'
    );
  }
  // readPidFile returned null — no valid daemon claims the file. Remove any
  // stale/corrupt PID file so the child's O_EXCL writePidFile succeeds.
  removePidFile();
  const { execPath, args } = buildSpawnArgs();
  const logFd = fs.openSync(
    LOG_PATH,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      fs.constants.O_NOFOLLOW,
    0o600
  );
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: os.homedir(),
      env: buildChildEnv(),
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  const expectedPid = child.pid;
  if (!expectedPid) {
    throw new SpawnFailedError('Failed to spawn detached daemon (no pid).');
  }
  const deadline = Date.now() + SPAWN_READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const fp = readPidFile();
    if (fp && fp.pid === expectedPid && isProcessAlive(fp.pid) === 'alive') {
      return fp;
    }
    if (isProcessAlive(expectedPid) === 'dead' && !fp) {
      throw new SpawnFailedError(
        'Daemon exited before becoming ready. See ~/.munchfile/daemon.log for details.'
      );
    }
    await new Promise(r => setTimeout(r, SPAWN_POLL_MS));
  }
  // Timeout: best-effort cleanup.
  try {
    process.kill(expectedPid, 'SIGKILL');
  } catch {
    // already dead
  }
  removePidFile();
  throw new SpawnTimeoutError();
}

export interface SignalResult {
  sent: boolean;
  reason?: 'no-fingerprint' | 'foreign' | 'recycled' | 'dead';
}

export function signalDaemon(signal: NodeJS.Signals): SignalResult {
  assertNotWindows();
  const fp = readPidFile();
  if (!fp) return { sent: false, reason: 'no-fingerprint' };
  const verdict = verifyFingerprint(fp);
  if (verdict !== 'ours') {
    return { sent: false, reason: verdict };
  }
  try {
    process.kill(fp.pid, signal);
    return { sent: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return { sent: false, reason: 'foreign' };
    if (code === 'ESRCH') return { sent: false, reason: 'dead' };
    throw err;
  }
}

export interface StopResult {
  stopped: boolean;
  escalated: boolean;
  hadDaemon: boolean;
}

const STOP_TIMEOUT_MS_DEFAULT = 35000;
const STOP_POLL_MS = 200;

export async function stopDaemonIfRunning(
  timeoutMs = STOP_TIMEOUT_MS_DEFAULT
): Promise<StopResult> {
  assertNotWindows();
  const initial = readPidFile();
  const sigResult = signalDaemon('SIGTERM');
  if (!sigResult.sent) {
    return { stopped: false, escalated: false, hadDaemon: false };
  }
  const initialPid = initial?.pid;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fp = readPidFile();
    if (!fp || fp.pid !== initialPid) {
      return { stopped: true, escalated: false, hadDaemon: true };
    }
    await new Promise(r => setTimeout(r, STOP_POLL_MS));
  }
  // Escalate: SIGKILL.
  if (initialPid) {
    try {
      process.kill(initialPid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  // Wait briefly for cleanup.
  const escalateDeadline = Date.now() + 2000;
  while (Date.now() < escalateDeadline) {
    const fp = readPidFile();
    if (!fp || fp.pid !== initialPid) break;
    await new Promise(r => setTimeout(r, STOP_POLL_MS));
  }
  removePidFile();
  return { stopped: true, escalated: true, hadDaemon: true };
}

export function formatTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}
