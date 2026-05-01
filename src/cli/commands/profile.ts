import { apiFetch, AuthError } from '../../api/client.js';
import { getSessionToken } from '../../auth/session.js';

type ProfileData = { user: { email: string; username: string | null; name: string | null } };

export async function profile(args: Record<string, unknown>): Promise<void> {
  const subcommand = (args._ as string[])?.[0];
  const token = await getSessionToken();
  if (!token) {
    console.error('Not logged in. Run: munchfile login <email>');
    process.exit(1);
  }

  if (!subcommand) {
    const data = await apiFetch('/auth/me', { token }) as ProfileData;
    const { email, username, name } = data.user;
    console.log(`Email:    ${email}`);
    console.log(`Name:     ${name ?? '(not set)'}`);
    console.log(`Username: ${username ? `munchfile.com/${username}` : '(not set)'}`);
    return;
  }

  if (subcommand === 'set-username') {
    const username = (args._ as string[])?.[1] ?? (args.username as string | undefined);
    if (!username) {
      console.error('Usage: munchfile profile set-username <username>');
      process.exit(1);
    }
    if (!/^[a-z0-9-]{3,30}$/.test(username)) {
      console.error('Username must be 3–30 lowercase alphanumeric or hyphen characters');
      process.exit(1);
    }
    try {
      await apiFetch('/auth/profile', { method: 'PUT', body: { username }, token });
      console.log(`✅ Username set: munchfile.com/${username}`);
    } catch (err) {
      console.error(`Failed: ${err instanceof AuthError || err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'set-name') {
    const nameParts = (args._ as string[])?.slice(1);
    const name = nameParts?.length ? nameParts.join(' ') : (args.name as string | undefined);
    if (!name) {
      console.error('Usage: munchfile profile set-name <display name>');
      process.exit(1);
    }
    try {
      await apiFetch('/auth/profile', { method: 'PUT', body: { name }, token });
      console.log(`✅ Name updated: ${name}`);
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  console.log('Usage:');
  console.log('  munchfile profile                        Show your profile');
  console.log('  munchfile profile set-username <handle>  Set your public username');
  console.log('  munchfile profile set-name <name>        Set your display name');
  process.exit(1);
}
