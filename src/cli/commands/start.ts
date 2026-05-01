/** Command: start — run daemon in foreground, or as detached child when --detached-child is set. */
import fs from 'fs';
import { Console } from 'node:console';
import { loadConfig } from '../../config/store.js';
import { getSessionToken } from '../../auth/session.js';
import { MunchFileDaemon } from '../../daemon/daemon.js';
import { AuthError } from '../../api/client.js';
import {
  ensureConfigDir,
  isOurDaemon,
  writePidFile,
  readPidFile,
  removePidFile,
  verifyFingerprint,
  formatTime,
  LOG_PATH,
  WINDOWS_UNSUPPORTED_MESSAGE,
} from '../../daemon/process.js';

export async function startDaemon(args: Record<string, unknown>): Promise<void> {
  const config = await loadConfig();

  if (config.paths.length === 0) {
    if (args.detachedChild) {
      try {
        const msg = `[${new Date().toISOString()}] No paths watched. Run \`munchfile watch <path>\` to add a path.\n`;
        const fd = fs.openSync(LOG_PATH, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeSync(fd, msg); } finally { fs.closeSync(fd); }
      } catch { /* best-effort */ }
    }
    console.error('No paths watched. Run `munchfile watch <path>` first.');
    process.exit(1);
  }

  const token = await getSessionToken();
  if (!token) {
    console.error('Error: Not logged in. Run `munchfile login` first.');
    process.exit(1);
  }

  const detachedChild = args.detachedChild === true;

  if (detachedChild) {
    if (process.platform === 'win32') {
      console.error(WINDOWS_UNSUPPORTED_MESSAGE);
      process.exit(1);
    }
    await runAsDetachedChild(config.apiBaseUrl);
    return;
  }

  // Foreground mode — works on all platforms (chokidar is cross-platform).
  // Refuse to start if a detached daemon is already running on non-Windows.
  if (process.platform !== 'win32') {
    const fp = isOurDaemon();
    if (fp) {
      console.error(
        `munchfile is already running (pid ${fp.pid}, since ${formatTime(fp.startedAt)}).`
      );
      console.error('  Use `munchfile logs -f` to tail logs, or `munchfile stop` first.');
      process.exit(1);
    }
  }

  console.log(`🚀 Starting munchfile daemon...`);
  console.log(`   Watching ${config.paths.length} path(s)`);
  console.log(`   API: ${config.apiBaseUrl}`);

  const daemon = new MunchFileDaemon({ apiBaseUrl: config.apiBaseUrl });

  process.on('unhandledRejection', (reason) => {
    if (reason instanceof AuthError) return; // daemon's own handler is responsible
    const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    console.error(`⚠️  unhandledRejection: ${msg}`);
  });

  process.on('uncaughtException', (err) => {
    if (err instanceof AuthError) return;
    console.error(`⚠️  uncaughtException: ${err.name}: ${err.message}`);
  });

  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    await daemon.stop();
    process.exit(0);
  });

  await daemon.start();
}

async function runAsDetachedChild(apiBaseUrl: string): Promise<void> {
  ensureConfigDir();

  const token = await getSessionToken();
  if (!token) {
    try {
      const msg = `[${new Date().toISOString()}] No session token found. Run \`munchfile login\` to authenticate.\n`;
      const fd = fs.openSync(LOG_PATH, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeSync(fd, msg); } finally { fs.closeSync(fd); }
    } catch { /* best-effort */ }
    console.error('No session token. Run `munchfile login` first.');
    process.exit(1);
  }

  const MAX_PID_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_PID_RETRIES; attempt++) {
    try {
      writePidFile({
        pid: process.pid,
        startedAt: Date.now(),
        execPath: process.execPath,
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === MAX_PID_RETRIES) {
        console.error(`Failed to write PID file: ${err}`);
        process.exit(1);
      }
      let existingFp = readPidFile();
      if (!existingFp) {
        await new Promise(r => setTimeout(r, 50));
        existingFp = readPidFile();
      }
      if (!existingFp) {
        removePidFile();
        continue;
      }
      const verdict = verifyFingerprint(existingFp);
      if (verdict === 'ours') {
        console.error(`Another munchfile daemon is already running (pid ${existingFp.pid}).`);
        process.exit(1);
      }
      if (verdict === 'foreign') {
        console.error('PID file points at a process owned by another user. Refusing to start.');
        process.exit(1);
      }
      removePidFile();
    }
  }

  ensureLogFile();

  const daemon = new MunchFileDaemon({ apiBaseUrl });

  const shutdownHandler = async () => {
    try {
      await daemon.stop();
    } catch (err) {
      console.error('Shutdown error:', err);
      process.exitCode = process.exitCode ?? 1;
    } finally {
      removePidFile();
      process.exit(process.exitCode ?? 0);
    }
  };

  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);

  process.on('unhandledRejection', (reason) => {
    if (reason instanceof AuthError) return;
    const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    console.error(`⚠️  unhandledRejection: ${msg}`);
  });

  process.on('uncaughtException', (err) => {
    if (err instanceof AuthError) return;
    console.error(`⚠️  uncaughtException: ${err.name}: ${err.message}`);
  });

  console.log(`🚀 munchfile daemon started (pid ${process.pid})`);
  await daemon.start();
}

function ensureLogFile(): void {
  let logFd: number | undefined;
  try {
    logFd = fs.openSync(
      LOG_PATH,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600
    );
    const logStream = fs.createWriteStream('', { fd: logFd });
    globalThis.console = new Console(logStream, logStream);
    fs.fchmodSync(logFd, 0o600);
    logFd = undefined;
  } catch {
    if (logFd !== undefined) {
      try { fs.closeSync(logFd); } catch { /* best-effort */ }
    }
  }
}
