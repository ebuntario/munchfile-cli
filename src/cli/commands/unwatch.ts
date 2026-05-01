/** Command: unwatch — remove a watched path by id or by absolute path. */
import path from 'path';
import os from 'os';
import { removeWatchedPath, loadConfig } from '../../config/store.js';
import { ensureDaemonRunning, messageForEnsureResult } from '../../daemon/lifecycle.js';
import { stopDaemonIfRunning } from '../../daemon/process.js';

function resolvePath(input: string): string {
  const expanded = input.replace(/^~/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

export async function unwatch(args: Record<string, unknown>): Promise<void> {
  const input = (args._ as string[])?.[0] ?? (args.id as string) ?? (args.path as string);
  if (!input) {
    console.error('Usage: munchfile unwatch <path-or-id>');
    const config = await loadConfig();
    console.log('\nWatched paths:');
    for (const p of config.paths) {
      console.log(`  ${p.id}  ${p.path}`);
    }
    process.exit(1);
  }

  // Try literal first (covers UUID and absolute path), then fall back to a
  // path-style resolution if that didn't hit anything.
  let removed = await removeWatchedPath(input);
  if (!removed) {
    const resolved = resolvePath(input);
    if (resolved !== input) {
      removed = await removeWatchedPath(resolved);
    }
  }

  if (!removed) {
    console.error(`Error: no watched path matched '${input}'`);
    const config = await loadConfig();
    if (config.paths.length === 0) {
      console.error('  (watch list is empty)');
    } else {
      console.error('  Try one of:');
      for (const p of config.paths) {
        console.error(`    ${p.id}  ${p.path}`);
      }
    }
    process.exit(1);
  }

  console.log(`✅ Removed watched path: ${removed.path}`);
  console.log(`   (id: ${removed.id})`);

  if (process.platform === 'win32') {
    return;
  }

  const config = await loadConfig();
  if (config.paths.length === 0) {
    try {
      const r = await stopDaemonIfRunning();
      if (r.hadDaemon) {
        console.log('   All paths removed. munchfile has stopped. Run `munchfile watch <path>` to start syncing again.');
      } else {
        console.log('   All paths removed.');
      }
    } catch (err) {
      console.error('   ⚠️ Failed to stop munchfile: ' + (err instanceof Error ? err.message : String(err)));
    }
    return;
  }

  try {
    const result = await ensureDaemonRunning(config);
    console.log(
      messageForEnsureResult(result, {
        pathsCount: config.paths.length,
        mode: 'unwatch',
        created: false,
      })
    );
  } catch (err) {
    console.error('   ⚠️ Failed to restart munchfile: ' + (err instanceof Error ? err.message : String(err)));
  }
}
