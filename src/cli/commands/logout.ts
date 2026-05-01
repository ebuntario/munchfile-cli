/** Command: logout — revoke session. */
import { revokeSession } from '../../auth/session.js';
import { apiFetch } from '../../api/client.js';
import { getAutostartStatus } from '../../daemon/autostart.js';

export async function logout(_args: Record<string, unknown>): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch {
    // Ignore server errors — revoke local token regardless
  }
  await revokeSession();
  console.log('✅ Logged out. All session tokens revoked.');

  try {
    const as = getAutostartStatus();
    if (as.enabled) {
      console.log('');
      console.log('⚠️  Autostart is still enabled. The daemon will start on next login but won\'t sync without a token.');
      console.log('   Run `munchfile autostart disable` to prevent this, or `munchfile login` to re-authenticate.');
    }
  } catch { /* non-critical */ }
}
