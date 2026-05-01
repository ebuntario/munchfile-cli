/**
 * Command: login — authenticate via magic link.
 *
 * Default flow (auto-redirect):
 *   1. CLI starts an ephemeral HTTP server on a random localhost port.
 *   2. CLI POSTs /auth/magic-link with a `redirectUri` pointing at that port.
 *   3. User clicks the magic link → server callback redirects browser to localhost.
 *   4. CLI's local listener receives the token, validates it, saves it.
 *
 * Fallback (--manual or auto-redirect timeout):
 *   User pastes the token from the success page.
 */

import http from 'http';
import readline from 'readline';
import { apiFetch, AuthError } from '../../api/client.js';
import { saveSessionToken } from '../../auth/session.js';
import { loadConfig } from '../../config/store.js';
import { ensureDaemonRunning, messageForEnsureResult } from '../../daemon/lifecycle.js';
import { isOurDaemon } from '../../daemon/process.js';
import { getAutostartStatus } from '../../daemon/autostart.js';

const REDIRECT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — matches magic-link expiry headroom

export async function login(args: Record<string, unknown>): Promise<void> {
  const email = (args._ as string[])?.[0] ?? (args.email as string);
  if (!email) {
    console.error('Usage: munchfile login <email> [--manual]');
    process.exit(1);
  }

  const manual = Boolean(args.manual);

  let listener: http.Server | null = null;
  let redirectUri: string | undefined;
  let waitForToken: Promise<string> | null = null;

  if (!manual) {
    try {
      const result = await startLocalListener();
      listener = result.server;
      redirectUri = result.url;
      waitForToken = result.tokenPromise;
    } catch (err) {
      console.warn(`⚠️  Could not start local listener (${err instanceof Error ? err.message : err}). Falling back to manual paste.`);
    }
  }

  console.log(`📧 Sending magic link to ${email}...`);

  try {
    await apiFetch('/auth/magic-link', {
      method: 'POST',
      body: redirectUri ? { email, redirectUri } : { email },
    });
  } catch (err) {
    listener?.close();
    console.error(`Failed to send magic link: ${err}`);
    process.exit(1);
  }

  console.log('✅ Magic link sent! Check your inbox (expires in 15 minutes).');
  console.log('');

  let token: string | null = null;

  if (waitForToken) {
    console.log('   Waiting for you to click the link... (Ctrl+C to cancel)');
    try {
      token = await waitForToken;
    } catch (err) {
      console.warn(`⚠️  Auto-redirect failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      listener?.close();
    }
  }

  if (!token) {
    console.log('   Or paste the token from the success page below.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const pasted = await new Promise<string>(resolve => {
      rl.question('   Paste token (or press Enter to cancel): ', resolve);
    });
    rl.close();
    if (!pasted.trim()) {
      console.log('Login cancelled.');
      return;
    }
    token = pasted.trim();
  }

  try {
    await apiFetch('/auth/validate', { method: 'POST', token });
    await saveSessionToken(token);
  } catch (err) {
    if (err instanceof AuthError) {
      console.error(`Invalid token: ${err.message}`);
    } else {
      console.error(`Login failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }

  // P-N2: confirmation prints FIRST, unconditionally.
  console.log('✅ Logged in!');

  // Auto-spawn or restart the daemon if there are paths to watch.
  // Token-saved is the user's primary intent, so a spawn failure here is a
  // warning, not an error (B3).
  try {
    const config = await loadConfig();
    if (config.paths.length === 0) {
      console.log('   Run `munchfile watch ~/Desktop` to get started.');
      return;
    }
    // Snapshot whether a daemon was running BEFORE the lock-guarded restart so
    // the post-restart message can say "restarted with new credentials" rather
    // than the generic "now syncing in the background".
    const priorDaemon = isOurDaemon() !== null;
    const result = await ensureDaemonRunning(config);
    console.log(
      messageForEnsureResult(result, {
        pathsCount: config.paths.length,
        mode: 'login',
        priorDaemon,
      })
    );
  } catch (err) {
    console.error('   ⚠️ Failed to start munchfile in the background:');
    console.error('   ' + (err instanceof Error ? err.message : String(err)));
    console.error('   Run `munchfile start` to start manually.');
    // exit 0 — the login itself succeeded
  }

  try {
    const as = getAutostartStatus();
    if (!as.enabled && as.platform !== 'unsupported') {
      console.log('');
      console.log('   Tip: Run `munchfile autostart enable` so munchfile starts automatically on login.');
    }
  } catch { /* non-critical */ }
}

interface ListenerResult {
  server: http.Server;
  url: string;
  tokenPromise: Promise<string>;
}

function startLocalListener(): Promise<ListenerResult> {
  return new Promise((resolveStart, rejectStart) => {
    let resolveToken!: (t: string) => void;
    let rejectToken!: (e: Error) => void;
    const tokenPromise = new Promise<string>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/cli-callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      const token = url.searchParams.get('token');
      if (!token) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('missing token');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>munchfile — Logged in</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:6em auto;padding:0 1em;}</style></head>
<body><h1>✅ Logged in</h1><p>You can close this tab and return to your terminal.</p></body></html>`);
      resolveToken(token);
    });

    const timer = setTimeout(() => {
      rejectToken(new Error(`timed out after ${REDIRECT_TIMEOUT_MS / 1000}s`));
      server.close();
    }, REDIRECT_TIMEOUT_MS);
    timer.unref();
    tokenPromise.finally(() => clearTimeout(timer)).catch(() => {});

    server.on('error', err => {
      rejectStart(err);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        rejectStart(new Error('failed to bind local listener'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}/cli-callback`;
      resolveStart({ server, url, tokenPromise });
    });
  });
}
