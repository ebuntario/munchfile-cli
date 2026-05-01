/** Command: autostart — manage daemon autostart on login (launchd/systemd). */
import {
  enableAutostart,
  disableAutostart,
  getAutostartStatus,
  type AutostartPlatform,
} from '../../daemon/autostart.js';
import { getSessionToken } from '../../auth/session.js';
import { loadConfig } from '../../config/store.js';
import { isOurDaemon } from '../../daemon/process.js';

export async function autostart(args: Record<string, unknown>): Promise<void> {
  const subcommand = (args._ as string[])?.[0];

  if (subcommand === 'help' || subcommand === '--help') {
    console.log(`Usage: munchfile autostart [enable|disable|status]

  enable     Register munchfile to start on login (launchd/systemd)
  disable    Remove the login registration
  status     Show current autostart state (default)
`);
    return;
  }

  if (!subcommand || subcommand === 'status') {
    await showStatus();
    return;
  }

  if (subcommand === 'enable') {
    const token = await getSessionToken();
    if (!token) {
      console.warn('⚠️  No session token found. The daemon will start on login but won\'t sync until you run `munchfile login`.');
    }
    const config = await loadConfig();
    if (config.paths.length === 0) {
      console.warn('⚠️  No paths watched. The daemon will start on login but won\'t sync until you run `munchfile watch <path>`.');
    }
    const result = enableAutostart();
    if (result.kind === 'installed' || result.kind === 'updated') {
      console.log(`✅ ${result.message}`);
    } else if (result.kind === 'dev-mode') {
      console.error('Autostart is for installed builds. In dev, use `npm run dev` or `munchfile start` directly.');
      process.exit(1);
    } else if (result.kind === 'unsupported-platform') {
      console.error(result.message);
      process.exit(1);
    } else {
      console.error(`Error: ${result.message}`);
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'disable') {
    const result = disableAutostart();
    if (result.kind === 'removed') {
      console.log('✅ Autostart disabled. munchfile will no longer start on login.');
      try {
        const fp = isOurDaemon();
        if (fp) {
          console.log(`   Note: The daemon (pid ${fp.pid}) is still running. Run \`munchfile stop\` to stop it.`);
        }
      } catch { /* non-critical */ }
    } else if (result.kind === 'not-enabled') {
      console.log('Autostart is not enabled.');
    } else if (result.kind === 'unsupported-platform') {
      console.error(result.message);
      process.exit(1);
    } else {
      console.error(`Error: ${result.message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  console.error('Usage: munchfile autostart [enable|disable|status]');
  process.exit(1);
}

async function showStatus(): Promise<void> {
  const s = getAutostartStatus();
  const platformLabel: Record<AutostartPlatform, string> = {
    launchd: 'launchd (macOS)',
    systemd: 'systemd (Linux)',
    unsupported: 'none (unsupported platform)',
  };
  console.log(`Autostart: ${s.enabled ? 'enabled' : 'disabled'}`);
  console.log(`Platform:  ${platformLabel[s.platform]}`);
  if (s.enabled && s.registeredBinaryPath) {
    console.log(`Binary:    ${s.registeredBinaryPath}`);
    if (!s.binaryExists) {
      console.warn(`⚠️  Registered binary not found at ${s.registeredBinaryPath}.`);
      console.warn('   Autostart will fail on next login. Run `munchfile autostart enable` to update.');
      console.warn('   Check system logs (Console.app on macOS, journalctl on Linux) for launch failures.');
    } else if (s.pathMismatch) {
      console.warn(`⚠️  Registered path doesn't match current binary (${s.currentBinaryPath}).`);
      console.warn('   Run `munchfile autostart enable` to update.');
    }
  }
}
