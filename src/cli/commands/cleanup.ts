/** Command: cleanup — remove stale records (server) or clear local failure log. */
import { apiFetch } from '../../api/client.js';
import { clearFailures } from '../../daemon/failure-log.js';

export async function cleanup(args: Record<string, unknown>): Promise<void> {
  if (args.failures) {
    const cleared = await clearFailures();
    console.log(`✅ Cleared ${cleared} failure log entr${cleared === 1 ? 'y' : 'ies'}.`);
    return;
  }

  const days = parseInt((args.days ?? '90') as string, 10);
  console.log(`🧹 Cleaning up stale files older than ${days} days...`);

  try {
    const result = await apiFetch('/files/cleanup', {
      method: 'POST',
      body: { days },
    }) as { deleted: number };
    console.log(`✅ Deleted ${result.deleted} stale file(s).`);
  } catch (err) {
    console.error(`Cleanup failed: ${err}`);
    process.exit(1);
  }
}
