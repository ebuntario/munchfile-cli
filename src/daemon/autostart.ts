/**
 * Autostart helpers — install/uninstall/status for launchd (macOS) and systemd (Linux).
 *
 * Service is "boot starter only" (KeepAlive=false / Restart=no). All post-boot
 * lifecycle is handled by Phase 2's process.ts / lifecycle.ts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { buildSpawnArgs, buildChildEnv } from './process.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type AutostartPlatform = 'launchd' | 'systemd' | 'unsupported';

export interface AutostartStatus {
  platform: AutostartPlatform;
  enabled: boolean;
  registeredBinaryPath: string | null;
  currentBinaryPath: string;
  pathMismatch: boolean;
  binaryExists: boolean;
}

export interface AutostartInstallResult {
  kind: 'installed' | 'updated' | 'unsupported-platform' | 'dev-mode' | 'error';
  message: string;
}

export interface AutostartUninstallResult {
  kind: 'removed' | 'not-enabled' | 'unsupported-platform' | 'error';
  message: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const LAUNCHD_LABEL = 'dev.munchfile.daemon';
const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(), 'Library', 'LaunchAgents', 'dev.munchfile.daemon.plist'
);
const SYSTEMD_UNIT_NAME = 'munchfile.service';
const SYSTEMD_UNIT_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
  'systemd', 'user'
);
const SYSTEMD_UNIT_PATH = path.join(SYSTEMD_UNIT_DIR, SYSTEMD_UNIT_NAME);
const LAUNCHCTL = '/bin/launchctl';
const SYSTEMCTL = '/usr/bin/systemctl';
const DEFAULTS = '/usr/bin/defaults';
const MIN_SYSTEMD_VERSION = 240;

// ── Helpers ────────────────────────────────────────────────────────────────

export function detectPlatform(): AutostartPlatform {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') {
    try {
      if (fs.existsSync('/run/systemd/system')) return 'systemd';
    } catch { /* fall through */ }
    return 'unsupported';
  }
  return 'unsupported';
}

export function isDevMode(): boolean {
  if (process.versions.bun !== undefined) return false;
  const argv1 = process.argv[1] ?? '';
  return (
    process.execArgv.some(a => a.includes('tsx')) ||
    argv1.endsWith('.ts') ||
    argv1.endsWith('.tsx')
  );
}

export function resolveBinaryArgs(): string[] {
  const { execPath, args } = buildSpawnArgs();
  return [execPath, ...args];
}

// Values are written to world-readable plist/unit — this allowlist is security-critical.
export function captureServiceEnv(): Record<string, string> {
  const raw = buildChildEnv();
  const env: Record<string, string> = {};
  const proxyKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) continue;
    if (proxyKeys.includes(key)) {
      try {
        const url = new URL(val);
        if (url.password) {
          env[key] = val.replace(/\/\/[^@]+@/, '//');
        } else {
          env[key] = val;
        }
      } catch {
        env[key] = val;
      }
    } else {
      env[key] = val;
    }
  }
  return env;
}

export function escapeXml(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeSystemdPercent(s: string): string {
  return s.replace(/%/g, '%%');
}

// ── Generation ─────────────────────────────────────────────────────────────

export function generatePlist(
  binaryArgs: string[],
  env: Record<string, string>
): string {
  const argsXml = binaryArgs
    .map(a => `    <string>${escapeXml(a)}</string>`)
    .join('\n');

  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(os.homedir())}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function generateSystemdUnit(
  binaryArgs: string[],
  env: Record<string, string>
): string {
  const execStart = binaryArgs
    .map(a => `"${escapeSystemdPercent(a)}"`)
    .join(' ');

  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment="${k}=${escapeSystemdPercent(v)}"`)
    .join('\n');

  return `[Unit]
Description=munchfile daemon — local files, live URLs
Documentation=https://munchfile.com
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=%h
StandardOutput=append:%h/.munchfile/daemon.log
StandardError=append:%h/.munchfile/daemon.log
${envLines}
Restart=no

[Install]
WantedBy=default.target
`;
}

// ── File I/O ───────────────────────────────────────────────────────────────

function runCmd(cmd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: Buffer };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

export function atomicWriteFile(targetPath: string, content: string, mode: number): void {
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      mode
    );
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Defense-in-depth: if target is a symlink, remove it before rename
    try {
      const stat = fs.lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(targetPath);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

// ── Install / Uninstall ────────────────────────────────────────────────────

function installLaunchd(plistContent: string): AutostartInstallResult {
  fs.mkdirSync(path.dirname(LAUNCHD_PLIST_PATH), { recursive: true });
  const existed = fs.existsSync(LAUNCHD_PLIST_PATH);
  if (existed) {
    runCmd(LAUNCHCTL, ['bootout', `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
  }
  atomicWriteFile(LAUNCHD_PLIST_PATH, plistContent, 0o644);
  const result = runCmd(LAUNCHCTL, ['bootstrap', `gui/${process.getuid!()}`, LAUNCHD_PLIST_PATH]);
  if (result.exitCode !== 0) {
    return {
      kind: 'error',
      message: `launchctl bootstrap failed: ${result.stderr}`,
    };
  }
  return {
    kind: existed ? 'updated' : 'installed',
    message: existed
      ? 'Autostart updated. Run `munchfile start` to start now, or it will start on next login.'
      : 'Autostart enabled. Run `munchfile start` to start now, or it will start on next login.',
  };
}

function installSystemd(unitContent: string): AutostartInstallResult {
  fs.mkdirSync(SYSTEMD_UNIT_DIR, { recursive: true });
  const versionResult = runCmd(SYSTEMCTL, ['--version']);
  const match = versionResult.stdout.match(/systemd\s+(\d+)/);
  const version = match ? parseInt(match[1], 10) : 0;
  if (version < MIN_SYSTEMD_VERSION) {
    return {
      kind: 'error',
      message: `systemd ${version || 'unknown'} found; autostart requires ${MIN_SYSTEMD_VERSION}+ for StandardOutput=append: support.`,
    };
  }
  const existed = fs.existsSync(SYSTEMD_UNIT_PATH);
  atomicWriteFile(SYSTEMD_UNIT_PATH, unitContent, 0o644);
  runCmd(SYSTEMCTL, ['--user', 'daemon-reload']);
  const enableResult = runCmd(SYSTEMCTL, ['--user', 'enable', SYSTEMD_UNIT_NAME]);
  if (enableResult.exitCode !== 0) {
    let msg = `systemctl --user enable failed: ${enableResult.stderr}`;
    if (enableResult.stderr.includes('bus') || enableResult.stderr.includes('connect')) {
      msg += ' Hint: On headless/SSH systems, run `loginctl enable-linger $USER` first.';
    }
    return { kind: 'error', message: msg };
  }
  return {
    kind: existed ? 'updated' : 'installed',
    message: existed
      ? 'Autostart updated. Run `munchfile start` to start now, or it will start on next login.'
      : 'Autostart enabled. Run `munchfile start` to start now, or it will start on next login.',
  };
}

function uninstallLaunchd(): AutostartUninstallResult {
  if (!fs.existsSync(LAUNCHD_PLIST_PATH)) {
    return { kind: 'not-enabled', message: 'Autostart is not enabled.' };
  }
  runCmd(LAUNCHCTL, ['bootout', `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
  fs.unlinkSync(LAUNCHD_PLIST_PATH);
  return { kind: 'removed', message: 'Autostart disabled. munchfile will no longer start on login.' };
}

function uninstallSystemd(): AutostartUninstallResult {
  if (!fs.existsSync(SYSTEMD_UNIT_PATH)) {
    return { kind: 'not-enabled', message: 'Autostart is not enabled.' };
  }
  runCmd(SYSTEMCTL, ['--user', 'disable', SYSTEMD_UNIT_NAME]);
  runCmd(SYSTEMCTL, ['--user', 'daemon-reload']);
  fs.unlinkSync(SYSTEMD_UNIT_PATH);
  return { kind: 'removed', message: 'Autostart disabled. munchfile will no longer start on login.' };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function enableAutostart(): AutostartInstallResult {
  if (isDevMode()) {
    return { kind: 'dev-mode', message: 'Autostart is for installed builds.' };
  }
  const platform = detectPlatform();
  if (platform === 'unsupported') {
    const msg = process.platform === 'linux'
      ? 'systemd user services are not available on this system. autostart requires systemd.'
      : `autostart is not supported on ${process.platform}.`;
    return { kind: 'unsupported-platform', message: msg };
  }
  try {
    const binaryArgs = resolveBinaryArgs();
    const env = captureServiceEnv();
    if (platform === 'launchd') {
      return installLaunchd(generatePlist(binaryArgs, env));
    }
    return installSystemd(generateSystemdUnit(binaryArgs, env));
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function disableAutostart(): AutostartUninstallResult {
  const platform = detectPlatform();
  if (platform === 'unsupported') {
    const msg = process.platform === 'linux'
      ? 'systemd user services are not available on this system.'
      : `autostart is not supported on ${process.platform}.`;
    return { kind: 'unsupported-platform', message: msg };
  }
  try {
    return platform === 'launchd' ? uninstallLaunchd() : uninstallSystemd();
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function getAutostartStatus(): AutostartStatus {
  const platform = detectPlatform();
  const currentBinaryPath = process.execPath;

  if (platform === 'launchd') {
    const enabled = fs.existsSync(LAUNCHD_PLIST_PATH);
    if (!enabled) {
      return { platform, enabled, registeredBinaryPath: null, currentBinaryPath, pathMismatch: false, binaryExists: true };
    }
    let registeredBinaryPath: string | null = null;
    try {
      const out = execFileSync(DEFAULTS, ['read', LAUNCHD_PLIST_PATH, 'ProgramArguments'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // defaults read outputs: (\n    "item1",\n    "item2"\n)
      // Find first line containing '/' (absolute path)
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.includes('/')) {
          registeredBinaryPath = trimmed.replace(/^"/, '').replace(/",?$/, '').replace(/,\s*$/, '');
          break;
        }
      }
    } catch { /* plist unreadable */ }
    const binaryExists = registeredBinaryPath ? fs.existsSync(registeredBinaryPath) : true;
    return {
      platform,
      enabled,
      registeredBinaryPath,
      currentBinaryPath,
      pathMismatch: registeredBinaryPath !== null && registeredBinaryPath !== currentBinaryPath,
      binaryExists,
    };
  }

  if (platform === 'systemd') {
    const enabled = fs.existsSync(SYSTEMD_UNIT_PATH);
    if (!enabled) {
      return { platform, enabled, registeredBinaryPath: null, currentBinaryPath, pathMismatch: false, binaryExists: true };
    }
    let registeredBinaryPath: string | null = null;
    try {
      const content = fs.readFileSync(SYSTEMD_UNIT_PATH, 'utf8');
      const execMatch = content.match(/^ExecStart=\s*"([^"]+)"/m);
      if (execMatch) {
        registeredBinaryPath = execMatch[1].replace(/%%/g, '%');
      }
    } catch { /* unit unreadable */ }
    const binaryExists = registeredBinaryPath ? fs.existsSync(registeredBinaryPath) : true;
    return {
      platform,
      enabled,
      registeredBinaryPath,
      currentBinaryPath,
      pathMismatch: registeredBinaryPath !== null && registeredBinaryPath !== currentBinaryPath,
      binaryExists,
    };
  }

  return { platform, enabled: false, registeredBinaryPath: null, currentBinaryPath, pathMismatch: false, binaryExists: true };
}
