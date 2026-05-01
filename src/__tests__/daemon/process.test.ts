import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';

// process.ts computes CONFIG_DIR from os.homedir() at module load. We mock
// os.homedir() so a fresh tmp dir is used per test.
let tmpHome: string;
let processModule: typeof import('../../daemon/process.js');

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tmpHome,
    },
    homedir: () => tmpHome,
  };
});

// Per-test spawn override. When non-null, replaces the real spawn so tests
// can capture PID-file state at spawn time without launching a real child.
let mockSpawnFn: ((...args: unknown[]) => Partial<ChildProcess>) | null = null;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const intercepted: typeof actual.spawn = (...args: Parameters<typeof actual.spawn>) => {
    if (mockSpawnFn) return mockSpawnFn(...args) as ChildProcess;
    return actual.spawn(...args);
  };
  return { ...actual, default: { ...actual, spawn: intercepted }, spawn: intercepted };
});

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'munchfile-process-test-'));
  vi.resetModules();
  processModule = await import('../../daemon/process.js');
});

afterEach(() => {
  mockSpawnFn = null;
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('readPidFile / writePidFile (W-N1: pid validation)', () => {
  it('round-trips a valid fingerprint', () => {
    processModule.ensureConfigDir();
    const fp = { pid: process.pid, startedAt: 1714700000000, execPath: '/usr/bin/node' };
    processModule.writePidFile(fp);
    expect(processModule.readPidFile()).toEqual(fp);
  });

  it('returns null for pid <= 0', () => {
    processModule.ensureConfigDir();
    fs.writeFileSync(processModule.PID_PATH, JSON.stringify({ pid: 0, startedAt: 1, execPath: '/x' }));
    expect(processModule.readPidFile()).toBeNull();
  });

  it('returns null for non-integer pid', () => {
    processModule.ensureConfigDir();
    fs.writeFileSync(processModule.PID_PATH, JSON.stringify({ pid: 1.5, startedAt: 1, execPath: '/x' }));
    expect(processModule.readPidFile()).toBeNull();
  });

  it('returns null for missing fields', () => {
    processModule.ensureConfigDir();
    fs.writeFileSync(processModule.PID_PATH, JSON.stringify({ pid: 1234 }));
    expect(processModule.readPidFile()).toBeNull();
  });

  it('returns null for unparseable content', () => {
    processModule.ensureConfigDir();
    fs.writeFileSync(processModule.PID_PATH, 'not json');
    expect(processModule.readPidFile()).toBeNull();
  });

  it('does NOT unlink on parse failure', () => {
    processModule.ensureConfigDir();
    fs.writeFileSync(processModule.PID_PATH, 'not json');
    expect(processModule.readPidFile()).toBeNull();
    expect(fs.existsSync(processModule.PID_PATH)).toBe(true);
  });
});

describe('isProcessAlive', () => {
  it('returns alive for our own pid', () => {
    expect(processModule.isProcessAlive(process.pid)).toBe('alive');
  });

  it('returns dead for impossibly large pid', () => {
    expect(processModule.isProcessAlive(9999999)).toBe('dead');
  });

  it('returns dead for pid 0 (validation)', () => {
    expect(processModule.isProcessAlive(0)).toBe('dead');
  });

  it('returns dead for negative pid (validation)', () => {
    expect(processModule.isProcessAlive(-1)).toBe('dead');
  });
});

describe('isOurDaemon (B9: foreign PID file is left alone)', () => {
  it('returns null and unlinks for dead PID', () => {
    processModule.ensureConfigDir();
    processModule.writePidFile({ pid: 9999999, startedAt: Date.now(), execPath: '/x' });
    expect(processModule.isOurDaemon()).toBeNull();
    expect(fs.existsSync(processModule.PID_PATH)).toBe(false);
  });

  it('returns fingerprint when PID file matches our own process', () => {
    processModule.ensureConfigDir();
    const fp = { pid: process.pid, startedAt: Date.now(), execPath: process.execPath };
    processModule.writePidFile(fp);
    const result = processModule.isOurDaemon();
    expect(result).not.toBeNull();
    expect(result?.pid).toBe(process.pid);
  });

  it('returns null but does NOT unlink when verifyFingerprint says foreign (EPERM mock)', () => {
    processModule.ensureConfigDir();
    processModule.writePidFile({ pid: 1, startedAt: Date.now(), execPath: '/x' });
    // mock isProcessAlive via process.kill throwing EPERM
    const origKill = process.kill;
    vi.spyOn(process, 'kill').mockImplementation((pid: number, sig?: string | number) => {
      if (pid === 1 && (sig === 0 || !sig)) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return origKill(pid, sig);
    });
    expect(processModule.isOurDaemon()).toBeNull();
    expect(fs.existsSync(processModule.PID_PATH)).toBe(true);
  });
});

describe('peekForeignPid (B18)', () => {
  it('returns false when no PID file', () => {
    processModule.ensureConfigDir();
    expect(processModule.peekForeignPid()).toBe(false);
  });

  it('returns true when PID file exists AND fingerprint is foreign', () => {
    processModule.ensureConfigDir();
    processModule.writePidFile({ pid: 1, startedAt: Date.now(), execPath: '/x' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(processModule.peekForeignPid()).toBe(true);
  });

  it('returns false when PID is dead', () => {
    processModule.ensureConfigDir();
    processModule.writePidFile({ pid: 9999999, startedAt: Date.now(), execPath: '/x' });
    expect(processModule.peekForeignPid()).toBe(false);
  });
});

describe('ensureConfigDir (B7 + W17)', () => {
  it('creates ~/.munchfile/ with mode 0700', () => {
    processModule.ensureConfigDir();
    const st = fs.statSync(path.join(tmpHome, '.munchfile'));
    expect((st.mode & 0o777).toString(8)).toBe('700');
  });

  it('upgrades existing 0o755 dir to 0o700 via chmod', () => {
    fs.mkdirSync(path.join(tmpHome, '.munchfile'), { mode: 0o755 });
    fs.chmodSync(path.join(tmpHome, '.munchfile'), 0o755);
    processModule.ensureConfigDir();
    const st = fs.statSync(path.join(tmpHome, '.munchfile'));
    expect((st.mode & 0o777).toString(8)).toBe('700');
  });

  it('refuses to operate when ~/.munchfile is a symlink (W17)', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'munchfile-symlink-target-'));
    fs.symlinkSync(target, path.join(tmpHome, '.munchfile'));
    expect(() => processModule.ensureConfigDir()).toThrow(/symlink/);
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('acquireSpawnLock (B11 + W18)', () => {
  it('acquires and releases the lock', async () => {
    processModule.ensureConfigDir();
    const release = await processModule.acquireSpawnLock(1000);
    expect(fs.existsSync(processModule.LOCK_PATH)).toBe(true);
    release();
    expect(fs.existsSync(processModule.LOCK_PATH)).toBe(false);
  });

  it('cleans up stale lock (dead pid)', async () => {
    processModule.ensureConfigDir();
    fs.writeFileSync(
      processModule.LOCK_PATH,
      JSON.stringify({ pid: 9999999, startedAt: Date.now() })
    );
    const release = await processModule.acquireSpawnLock(2000);
    expect(fs.existsSync(processModule.LOCK_PATH)).toBe(true);
    release();
  });

  it('cleans up stale lock (older than 120s)', async () => {
    processModule.ensureConfigDir();
    fs.writeFileSync(
      processModule.LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 130000 })
    );
    const release = await processModule.acquireSpawnLock(2000);
    expect(fs.existsSync(processModule.LOCK_PATH)).toBe(true);
    release();
  });

  it('recovers from empty lock file after 5 reads (W18)', async () => {
    processModule.ensureConfigDir();
    fs.writeFileSync(processModule.LOCK_PATH, '');
    const release = await processModule.acquireSpawnLock(3000);
    expect(fs.existsSync(processModule.LOCK_PATH)).toBe(true);
    release();
  });

  it('throws LockContentionError when lock is held by live, non-stale process', async () => {
    processModule.ensureConfigDir();
    // PID is our own (alive) and timestamp is recent.
    fs.writeFileSync(
      processModule.LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() })
    );
    await expect(processModule.acquireSpawnLock(300)).rejects.toThrow();
    fs.unlinkSync(processModule.LOCK_PATH);
  });
});

describe('buildSpawnArgs (B5 / N2 / W-N3)', () => {
  it('detects Bun-compiled binary via process.versions.bun', () => {
    vi.stubGlobal('process', {
      ...process,
      versions: { ...process.versions, bun: '1.0.0' },
      execPath: '/path/to/munchfile-darwin-arm64',
      execArgv: [],
      argv: ['/path/to/munchfile-darwin-arm64'],
    });
    const result = processModule.buildSpawnArgs();
    expect(result.execPath).toBe('/path/to/munchfile-darwin-arm64');
    expect(result.args).toEqual(['start', '--detached-child']);
    vi.unstubAllGlobals();
  });

  it('detects Bun-compiled even when binary is renamed (W-N3: no suffix check)', () => {
    vi.stubGlobal('process', {
      ...process,
      versions: { ...process.versions, bun: '1.0.0' },
      execPath: '/usr/local/bin/munchfile',
      execArgv: [],
      argv: ['/usr/local/bin/munchfile'],
    });
    const result = processModule.buildSpawnArgs();
    expect(result.execPath).toBe('/usr/local/bin/munchfile');
    expect(result.args).toEqual(['start', '--detached-child']);
    vi.unstubAllGlobals();
  });

  it('detects tsx via process.execArgv loader flag', () => {
    const versionsWithoutBun: Record<string, string> = { ...process.versions };
    delete versionsWithoutBun.bun;
    vi.stubGlobal('process', {
      ...process,
      versions: versionsWithoutBun,
      execPath: '/usr/local/bin/node',
      execArgv: ['--import', 'tsx/esm'],
      argv: ['/usr/local/bin/node', '/path/to/src/index.ts', 'watch', '/some/path'],
    });
    const result = processModule.buildSpawnArgs();
    expect(result.execPath).toBe('/usr/local/bin/node');
    expect(result.args).toEqual([
      '--import',
      'tsx/esm',
      '/path/to/src/index.ts',
      'start',
      '--detached-child',
    ]);
    vi.unstubAllGlobals();
  });

  it('detects tsx via .ts suffix on argv[1] (no execArgv)', () => {
    const versionsWithoutBun: Record<string, string> = { ...process.versions };
    delete versionsWithoutBun.bun;
    vi.stubGlobal('process', {
      ...process,
      versions: versionsWithoutBun,
      execPath: '/usr/local/bin/node',
      execArgv: [],
      argv: ['/usr/local/bin/node', '/path/to/src/index.ts', 'watch', '/some/path'],
    });
    const result = processModule.buildSpawnArgs();
    expect(result.args[result.args.length - 2]).toBe('start');
    expect(result.args[result.args.length - 1]).toBe('--detached-child');
    expect(result.args).toContain('/path/to/src/index.ts');
    vi.unstubAllGlobals();
  });

  it('falls through to node-default for npm-installed dist build', () => {
    const versionsWithoutBun: Record<string, string> = { ...process.versions };
    delete versionsWithoutBun.bun;
    vi.stubGlobal('process', {
      ...process,
      versions: versionsWithoutBun,
      execPath: '/usr/local/bin/node',
      execArgv: [],
      argv: ['/usr/local/bin/node', '/path/to/dist/index.js', 'watch'],
    });
    const result = processModule.buildSpawnArgs();
    expect(result.execPath).toBe('/usr/local/bin/node');
    expect(result.args).toEqual(['/path/to/dist/index.js', 'start', '--detached-child']);
    vi.unstubAllGlobals();
  });
});

describe('buildChildEnv (B12)', () => {
  it('excludes NODE_OPTIONS', () => {
    vi.stubEnv('NODE_OPTIONS', '--inspect-brk');
    const env = processModule.buildChildEnv();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('includes SSL_CERT_FILE when set', () => {
    vi.stubEnv('SSL_CERT_FILE', '/etc/ssl/cert.pem');
    const env = processModule.buildChildEnv();
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/cert.pem');
  });

  it('includes HTTPS_PROXY when set', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy:8080');
    const env = processModule.buildChildEnv();
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
  });

  it('always sets NODE_ENV=production', () => {
    const env = processModule.buildChildEnv();
    expect(env.NODE_ENV).toBe('production');
  });
});

describe('spawnDetachedDaemon — corrupt PID file (W-N4)', () => {
  it('removes a corrupt PID file before invoking the child so O_EXCL writePidFile can succeed', async () => {
    processModule.ensureConfigDir();
    // Simulate the "not json" daemon.pid left by a previous crash (the exact
    // bytes that triggered the production EEXIST bug).
    fs.writeFileSync(processModule.PID_PATH, 'not json');

    let pidFileExistedAtSpawn: boolean | null = null;
    mockSpawnFn = () => {
      pidFileExistedAtSpawn = fs.existsSync(processModule.PID_PATH);
      // Return a fake child with no pid — triggers SpawnFailedError('no pid').
      return { pid: undefined, unref: () => {} };
    };

    await expect(processModule.spawnDetachedDaemon()).rejects.toThrow(/no pid/);
    expect(pidFileExistedAtSpawn).toBe(false);
  });

  it('does not throw "already exists" for a corrupt PID file (readPidFile returns null)', async () => {
    processModule.ensureConfigDir();
    fs.writeFileSync(processModule.PID_PATH, 'not json');

    mockSpawnFn = () => ({ pid: undefined, unref: () => {} });

    const err = await processModule.spawnDetachedDaemon().catch(e => e);
    expect((err as Error).message).not.toMatch(/already exists/);
  });
});
