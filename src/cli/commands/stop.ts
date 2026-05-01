/** Command: stop — gracefully stop the detached daemon. */
import { loadConfig } from '../../config/store.js';
import { stopDaemonIfRunning, WINDOWS_UNSUPPORTED_MESSAGE } from '../../daemon/process.js';
import { getAutostartStatus } from '../../daemon/autostart.js';

export async function stop(_args: Record<string, unknown>): Promise<void> {
  if (process.platform === 'win32') {
    console.error(WINDOWS_UNSUPPORTED_MESSAGE);
    process.exit(1);
  }

  const result = await stopDaemonIfRunning();

  if (!result.hadDaemon) {
    console.log('munchfile is not running.');
    return;
  }

  if (result.escalated) {
    console.warn('⚠️ munchfile did not stop gracefully within 30s; forced shutdown via SIGKILL.');
    console.warn('   Some in-flight uploads may have been interrupted. They will retry on next save.');
    return;
  }

  const config = await loadConfig();
  const n = config.paths.length;
  const plural = n === 1 ? '' : 's';

  try {
    const as = getAutostartStatus();
    if (as.enabled) {
      console.log('✅ munchfile daemon stopped.');
      console.log('');
      console.log('Note: Autostart is enabled — munchfile will start again on next login.');
      console.log('      Run `munchfile autostart disable` to prevent this.');
      return;
    }
  } catch { /* fall through to original message */ }

  console.log(
    `munchfile stopped. ${n} path${plural} still in your watch list — next \`munchfile watch <path>\` or \`munchfile login\` will resume sync.`
  );
}
