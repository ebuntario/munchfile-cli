/** Command: status — show daemon state, watched paths, recent failures, and stale files. */
import fs from 'fs';
import { loadConfig } from '../../config/store.js';
import { apiFetch } from '../../api/client.js';
import { getSessionToken } from '../../auth/session.js';
import { readFailures } from '../../daemon/failure-log.js';
import { viewerUrl } from '../../utils/urls.js';
import {
  LOCK_PATH,
  LOG_PATH,
  formatTime,
  readPidFile,
  removePidFile,
  verifyFingerprint,
} from '../../daemon/process.js';
import { getAutostartStatus } from '../../daemon/autostart.js';

const FAILURE_DISPLAY_LIMIT = 5;

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

interface DaemonState {
  running: boolean;
  inTransition: boolean;
}

function reportDaemonState(): DaemonState {
  // N4: read the spawn lock first so we don't race-unlink a fresh PID file
  // while another command is mid-spawn.
  const inTransition = (() => {
    try {
      return fs.existsSync(LOCK_PATH);
    } catch {
      return false;
    }
  })();
  const fp = readPidFile();
  if (!fp) {
    if (inTransition) {
      console.log('munchfile is starting…');
      return { running: false, inTransition: true };
    }
    console.log('⚠️ munchfile is not running.');
    return { running: false, inTransition: false };
  }
  const verdict = verifyFingerprint(fp);
  if (verdict === 'ours') {
    console.log(`✅ munchfile is running (pid ${fp.pid}, since ${formatTime(fp.startedAt)}).`);
    console.log(`   Logs: ${LOG_PATH}`);
    return { running: true, inTransition: false };
  }
  if (inTransition) {
    // Another command is mid-spawn; do NOT unlink — let them finish.
    console.log('munchfile is starting…');
    return { running: false, inTransition: true };
  }
  if (verdict === 'foreign') {
    console.log('⚠️ ~/.munchfile/daemon.pid points at a process owned by another user. Leaving alone.');
    return { running: false, inTransition: false };
  }
  // dead or recycled — housekeeping
  removePidFile();
  console.log('⚠️ munchfile is not running (cleaned up stale PID file).');
  return { running: false, inTransition: false };
}

function printFooter(opts: { paths: number; daemon: boolean; token: boolean }): void {
  const { paths, daemon, token } = opts;
  const plural = paths === 1 ? '' : 's';

  if (paths === 0 && !daemon && !token) {
    console.log('Run `munchfile login` to authenticate, then `munchfile watch <path>` to start.');
    return;
  }
  if (paths === 0 && !daemon && token) {
    console.log('Run `munchfile watch <path>` to start syncing.');
    return;
  }
  if (paths === 0 && daemon) {
    console.log('munchfile is running but no paths are configured — run `munchfile stop` to shut down.');
    return;
  }
  if (paths > 0 && !daemon && !token) {
    console.log(`Run \`munchfile login\` to start syncing your ${paths} path${plural}.`);
    return;
  }
  if (paths > 0 && !daemon && token) {
    console.log(`Run \`munchfile start\` to resume syncing your ${paths} path${plural}, or \`munchfile watch <new-path>\` to add another.`);
    return;
  }
  if (paths > 0 && daemon && !token) {
    console.log('⚠️ Watching paths but not authenticated. Run `munchfile login`.');
    return;
  }
  // paths > 0, daemon, token — happy state, no footer
}

export async function status(_args: Record<string, unknown>): Promise<void> {
  const config = await loadConfig();
  const token = await getSessionToken();

  // Daemon state first — never blocks on network.
  console.log('');
  const daemonState = reportDaemonState();
  try {
    const as = getAutostartStatus();
    if (as.enabled) {
      if (!token) {
        console.log('   Autostart: enabled (not syncing — no session token)');
      } else if (!as.binaryExists) {
        console.log('   Autostart: enabled (⚠️ registered binary not found — run `munchfile autostart enable` to fix)');
      } else if (as.pathMismatch) {
        console.log('   Autostart: enabled (⚠️ binary path changed — run `munchfile autostart enable` to update)');
      } else {
        console.log('   Autostart: enabled');
      }
    } else if (as.platform !== 'unsupported') {
      console.log('   Autostart: disabled (run `munchfile autostart enable` to start on login)');
    }
  } catch { /* non-critical */ }
  console.log('');

  console.log(`📂 Watched Paths (${config.paths.length})\n`);
  for (const wp of config.paths) {
    console.log(`  ${wp.path}`);
    console.log(`    visibility: ${wp.visibility}  recursive: ${wp.recursive ? 'yes' : 'no'}  ID: ${wp.id}`);
    console.log();
  }

  // Recent upload failures (local) — actionable, show first.
  const failures = await readFailures();
  if (failures.length > 0) {
    console.log(`⚠️  Recent Upload Failures (${failures.length})\n`);
    const top = failures.slice(-FAILURE_DISPLAY_LIMIT).reverse();
    for (const f of top) {
      console.log(`  ${f.filePath}`);
      console.log(`    → ${f.error}  (${formatRelative(f.timestamp)})`);
    }
    if (failures.length > FAILURE_DISPLAY_LIMIT) {
      console.log(`  (${failures.length - FAILURE_DISPLAY_LIMIT} more — see ~/.munchfile/failures.json)`);
    }
    console.log('  Run `munchfile cleanup --failures` to clear the log.\n');
  }

  if (token) {
    try {
      const result = await apiFetch('/files', { token, baseUrl: config.apiBaseUrl }) as {
        files: Array<{ slug: string; filename: string; originalPath?: string; isActive: boolean; staleSince?: string }>;
      };
      const stale = result.files.filter(f => !f.isActive);

      if (stale.length > 0) {
        console.log(`⚠️  Stale Files (${stale.length})\n`);
        for (const f of stale) {
          console.log(`  ${f.originalPath ?? f.filename}`);
          console.log(`    slug: ${f.slug}  →  ${viewerUrl(f.slug)}`);
          console.log();
        }
        console.log('  Run `munchfile relink <slug> <new-path>` to recover.\n');
      } else {
        console.log('✅ No stale files.\n');
      }
    } catch {
      console.log('⚠️  Could not fetch stale files from server.\n');
    }
  }

  printFooter({
    paths: config.paths.length,
    daemon: daemonState.running,
    token: !!token,
  });
}
