import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let autostartModule: typeof import('../../daemon/autostart.js');

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

// Mock child_process.execFileSync for launchctl/systemctl calls
let mockExecFileSync: ((...args: unknown[]) => string) | null = null;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    default: {
      ...actual,
      execFileSync: (...args: unknown[]) => {
        if (mockExecFileSync) return mockExecFileSync(...args);
        return actual.execFileSync(args[0] as string, args[1] as string[]);
      },
    },
    execFileSync: (...args: unknown[]) => {
      if (mockExecFileSync) return mockExecFileSync(...args);
      return actual.execFileSync(args[0] as string, args[1] as string[]);
    },
  };
});

// Mock buildSpawnArgs and buildChildEnv from process.ts
vi.mock('../../daemon/process.js', () => ({
  buildSpawnArgs: () => ({
    execPath: '/usr/local/bin/munchfile',
    args: ['start', '--detached-child'],
  }),
  buildChildEnv: () => ({
    HOME: tmpHome,
    PATH: '/usr/local/bin:/usr/bin',
    NODE_ENV: 'production',
  }),
}));

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'munchfile-autostart-test-'));
  mockExecFileSync = null;
  vi.resetModules();
  autostartModule = await import('../../daemon/autostart.js');
});

afterEach(() => {
  mockExecFileSync = null;
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ── Plist generation ────────────────────────────────────────────────────────

describe('generatePlist', () => {
  it('generates valid plist with correct structure', () => {
    const plist = autostartModule.generatePlist(
      ['/usr/local/bin/munchfile', 'start', '--detached-child'],
      { NODE_ENV: 'production', HOME: '/Users/test' }
    );

    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>dev.munchfile.daemon</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<false/>');
    expect(plist).toContain('<string>/usr/local/bin/munchfile</string>');
    expect(plist).toContain('<key>ProcessType</key>');
    expect(plist).toContain('<string>Background</string>');
  });

  it('escapes XML special characters in paths', () => {
    const plist = autostartModule.generatePlist(
      ['/path/with&special<chars>'],
      { KEY: 'value&with<special>' }
    );

    expect(plist).toContain('&amp;special&lt;chars&gt;');
    expect(plist).toContain('value&amp;with&lt;special&gt;');
    expect(plist).not.toContain('&special<chars>');
  });
});

// ── Systemd unit generation ─────────────────────────────────────────────────

describe('generateSystemdUnit', () => {
  it('generates valid unit file', () => {
    const unit = autostartModule.generateSystemdUnit(
      ['/usr/local/bin/node', '/opt/lib/index.js', 'start', '--detached-child'],
      { NODE_ENV: 'production' }
    );

    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/lib/index.js" "start" "--detached-child"');
    expect(unit).toContain('Restart=no');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('Environment="NODE_ENV=production"');
  });

  it('escapes % in ExecStart and Environment values', () => {
    const unit = autostartModule.generateSystemdUnit(
      ['/home/%user/bin/munchfile'],
      { HOME: '/home/%user' }
    );

    expect(unit).toContain('"/home/%%user/bin/munchfile"');
    expect(unit).toContain('Environment="HOME=/home/%%user"');
  });
});

// ── Platform detection ──────────────────────────────────────────────────────

describe('detectPlatform', () => {
  it('returns launchd on darwin', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      expect(autostartModule.detectPlatform()).toBe('launchd');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('returns unsupported on win32', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(autostartModule.detectPlatform()).toBe('unsupported');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });
});

// ── Dev mode detection ──────────────────────────────────────────────────────

describe('isDevMode', () => {
  it('returns true when tsx is in execArgv', () => {
    const orig = process.execArgv;
    process.execArgv = ['--import', 'tsx/esm'];
    try {
      expect(autostartModule.isDevMode()).toBe(true);
    } finally {
      process.execArgv = orig;
    }
  });

  it('returns true when argv[1] ends with .ts', () => {
    const orig = process.argv;
    process.argv = ['node', 'src/index.ts'];
    try {
      expect(autostartModule.isDevMode()).toBe(true);
    } finally {
      process.argv = orig;
    }
  });

  it('returns false when argv[1] ends with .js', () => {
    const orig = { execArgv: process.execArgv, argv: process.argv };
    process.execArgv = [];
    process.argv = ['node', 'dist/index.js'];
    try {
      expect(autostartModule.isDevMode()).toBe(false);
    } finally {
      process.execArgv = orig.execArgv;
      process.argv = orig.argv;
    }
  });

  it('returns false when running under Bun', () => {
    const _orig = { ...process.versions };
    Object.defineProperty(process.versions, 'bun', { value: '1.0.0', configurable: true });
    const origArgv = process.argv;
    process.argv = ['bun', 'src/index.ts'];
    try {
      expect(autostartModule.isDevMode()).toBe(false);
    } finally {
      delete (process.versions as Record<string, unknown>).bun;
      process.argv = origArgv;
    }
  });
});

// ── escapeXml ───────────────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('escapes all XML entities', () => {
    expect(autostartModule.escapeXml('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('strips control characters', () => {
    expect(autostartModule.escapeXml('hello\x00\x01\x08world')).toBe('helloworld');
  });

  it('preserves tab, newline, carriage return', () => {
    expect(autostartModule.escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });
});

// ── captureServiceEnv ───────────────────────────────────────────────────────

describe('captureServiceEnv', () => {
  it('returns env from buildChildEnv', () => {
    const env = autostartModule.captureServiceEnv();
    expect(env.HOME).toBe(tmpHome);
    expect(env.NODE_ENV).toBe('production');
  });
});

// ── atomicWriteFile ─────────────────────────────────────────────────────────

describe('atomicWriteFile', () => {
  it('writes file atomically', () => {
    const targetDir = path.join(tmpHome, 'test-dir');
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, 'test.txt');

    autostartModule.atomicWriteFile(target, 'hello world', 0o644);

    expect(fs.readFileSync(target, 'utf8')).toBe('hello world');
    const stat = fs.statSync(target);
    expect(stat.mode & 0o777).toBe(0o644);
  });

  it('cleans up tmp file on error', () => {
    const target = '/nonexistent/dir/file.txt';
    expect(() => autostartModule.atomicWriteFile(target, 'test', 0o644)).toThrow();
  });

  it('overwrites symlink target safely', () => {
    const targetDir = path.join(tmpHome, 'test-dir');
    fs.mkdirSync(targetDir, { recursive: true });
    const realFile = path.join(targetDir, 'real.txt');
    const symlink = path.join(targetDir, 'link.txt');
    fs.writeFileSync(realFile, 'original');
    fs.symlinkSync(realFile, symlink);

    autostartModule.atomicWriteFile(symlink, 'replaced', 0o644);

    expect(fs.readFileSync(symlink, 'utf8')).toBe('replaced');
    expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(false);
  });
});

// ── getAutostartStatus ──────────────────────────────────────────────────────

describe('getAutostartStatus', () => {
  it('returns disabled when no service file exists', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const status = autostartModule.getAutostartStatus();
      expect(status.enabled).toBe(false);
      expect(status.platform).toBe('launchd');
      expect(status.registeredBinaryPath).toBeNull();
      expect(status.pathMismatch).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });
});

// ── enableAutostart ─────────────────────────────────────────────────────────

describe('enableAutostart', () => {
  it('returns dev-mode when in dev mode', () => {
    const orig = process.execArgv;
    process.execArgv = ['--import', 'tsx/esm'];
    try {
      const result = autostartModule.enableAutostart();
      expect(result.kind).toBe('dev-mode');
    } finally {
      process.execArgv = orig;
    }
  });

  it('returns unsupported-platform on win32', () => {
    const origPlatform = process.platform;
    const origExecArgv = process.execArgv;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.execArgv = [];
    try {
      const result = autostartModule.enableAutostart();
      expect(result.kind).toBe('unsupported-platform');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      process.execArgv = origExecArgv;
    }
  });
});

// ── disableAutostart ────────────────────────────────────────────────────────

describe('disableAutostart', () => {
  it('returns not-enabled when no service file exists (darwin)', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const result = autostartModule.disableAutostart();
      expect(result.kind).toBe('not-enabled');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('returns unsupported-platform on win32', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const result = autostartModule.disableAutostart();
      expect(result.kind).toBe('unsupported-platform');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });
});
