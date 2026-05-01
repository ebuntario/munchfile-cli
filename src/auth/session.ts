/**
 * Auth session management.
 * Prefers OS Keychain, falls back to JSON file (0600).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// Note: keytar is a native dependency. For now, JSON file is the default.
// Native keychain integration added once we have a working build pipeline.

const SESSION_PATH = path.join(os.homedir(), '.munchfile', 'session.json');

export async function getSessionToken(): Promise<string | null> {
  try {
    const data = JSON.parse(await fs.promises.readFile(SESSION_PATH, 'utf8'));
    return (data as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}

export async function saveSessionToken(token: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(SESSION_PATH), { recursive: true });
  await fs.promises.writeFile(SESSION_PATH, JSON.stringify({ token }), { mode: 0o600 });
}

export async function revokeSession(): Promise<void> {
  try {
    await fs.promises.unlink(SESSION_PATH);
  } catch {
    // ignore if not present
  }
}
