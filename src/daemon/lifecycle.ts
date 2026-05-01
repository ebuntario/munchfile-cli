/**
 * Daemon lifecycle orchestration — wraps process.ts helpers with the
 * cold-start vs restart vs no-token vs foreign-pid decision logic.
 *
 * Used by `watch`, `unwatch`, and `login` commands.
 */

import { getSessionToken } from '../auth/session.js';
import type { Config } from '../config/store.js';
import {
  acquireSpawnLock,
  isOurDaemon,
  peekForeignPid,
  spawnDetachedDaemon,
  stopDaemonIfRunning,
  WINDOWS_UNSUPPORTED_MESSAGE,
} from './process.js';

export type EnsureResult =
  | { kind: 'spawned' }
  | { kind: 'restarted' }
  | { kind: 'no-token' }
  | { kind: 'unsupported-platform' }
  | { kind: 'foreign-pid' }
  | { kind: 'spawn-failed'; error: Error };

export interface MessageContext {
  pathsCount: number;
  mode: 'watch' | 'login' | 'unwatch';
  created?: boolean;
  priorDaemon?: boolean;
}

export async function ensureDaemonRunning(_config: Config): Promise<EnsureResult> {
  if (process.platform === 'win32') {
    return { kind: 'unsupported-platform' };
  }
  const token = await getSessionToken();
  if (!token) {
    return { kind: 'no-token' };
  }
  let release: (() => void) | null = null;
  try {
    release = await acquireSpawnLock();
  } catch (err) {
    return { kind: 'spawn-failed', error: err instanceof Error ? err : new Error(String(err)) };
  }
  try {
    const fp = isOurDaemon();
    if (fp) {
      await stopDaemonIfRunning();
      await spawnDetachedDaemon();
      return { kind: 'restarted' };
    }
    // No live daemon — check for a foreign PID file (B18).
    if (peekForeignPid()) {
      return { kind: 'foreign-pid' };
    }
    await spawnDetachedDaemon();
    return { kind: 'spawned' };
  } catch (err) {
    return { kind: 'spawn-failed', error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    release();
  }
}

/**
 * Maps an EnsureResult + caller context to the user-facing message.
 * Implemented as ordered if/else, MOST-SPECIFIC FIRST.
 * All messages prefixed with 3-space indent for visual coherence.
 */
export function messageForEnsureResult(
  result: EnsureResult,
  ctx: MessageContext
): string {
  const plural = ctx.pathsCount === 1 ? '' : 's';

  // (1) Login spawn or restart — single unified clause covers BOTH spawn and
  // restart kinds and BOTH priorDaemon=true/false (closes P-N1 dispatch gap).
  if (
    ctx.mode === 'login' &&
    (result.kind === 'spawned' || result.kind === 'restarted')
  ) {
    if (ctx.priorDaemon) {
      return '   munchfile restarted with new credentials.';
    }
    return '   munchfile is now syncing in the background.';
  }

  // (2) Restart from `watch <new-path>` (created=true).
  if (result.kind === 'restarted' && ctx.created === true) {
    return `   munchfile restarted with new path (now syncing ${ctx.pathsCount} path${plural}).`;
  }

  // (3) Restart for any other reason (already-watching, unwatch, settings change).
  if (result.kind === 'restarted') {
    return `   munchfile restarted (now syncing ${ctx.pathsCount} path${plural}).`;
  }

  // (4) Cold spawn after unwatch (e.g., daemon was stopped, last unwatch left
  // paths AND the daemon needs to come back up).
  if (result.kind === 'spawned' && ctx.mode === 'unwatch') {
    return `   munchfile is now syncing your remaining ${ctx.pathsCount} path${plural}.`;
  }

  // (5) Default cold spawn from watch.
  if (result.kind === 'spawned') {
    return '   munchfile is now syncing in the background.';
  }

  if (result.kind === 'no-token') {
    return '   Run `munchfile login` to start syncing.';
  }

  if (result.kind === 'unsupported-platform') {
    return `   ${WINDOWS_UNSUPPORTED_MESSAGE}\n   Run \`munchfile start\` in foreground (works on Windows) for now.`;
  }

  if (result.kind === 'foreign-pid') {
    return (
      '   ⚠️ ~/.munchfile/daemon.pid points at a process owned by another user.\n' +
      '   Inspect with `ls -la ~/.munchfile/` and remove manually if it\'s stale.'
    );
  }

  if (result.kind === 'spawn-failed') {
    return (
      `   ⚠️ Failed to start munchfile in the background: ${result.error.message}\n` +
      '   Run `munchfile start` to start manually.'
    );
  }

  // Exhaustiveness check — TypeScript will error if a new kind is added
  // without a dispatch clause.
  const _exhaustive: never = result;
  void _exhaustive;
  return '';
}
