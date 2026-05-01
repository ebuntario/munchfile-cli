/** Command: relink — recover a stale file after a move. */
import { apiFetch } from '../../api/client.js';
import { viewerUrl } from '../../utils/urls.js';

export async function relink(args: Record<string, unknown>): Promise<void> {
  const positional = (args._ as string[] ?? []);
  const slug = positional[0] ?? (args.slug as string);
  const newPath = positional[1] ?? (args.newPath as string);

  if (!slug || !newPath) {
    console.error('Usage: munchfile relink <slug> <new-path>');
    process.exit(1);
  }

  try {
    await apiFetch(`/files/${slug}/relink`, {
      method: 'POST',
      body: { newPath },
    });
    console.log(`✅ File relinked: ${viewerUrl(slug)}`);
  } catch (err) {
    console.error(`Failed to relink: ${err}`);
    process.exit(1);
  }
}
