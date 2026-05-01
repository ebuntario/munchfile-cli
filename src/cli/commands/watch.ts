/**
 * Command: watch — add a file or folder to the watch list.
 * Usage: munchfile watch <file-or-folder> [--recursive] [--public|--unlisted|--private]
 *
 * Files: any of `.md`, `.markdown`, `.html`, `.htm` (Phase-1 viewer support).
 * Folders: top-level Phase-1 files only unless `--recursive`.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { addWatchedPath, loadConfig, type Config, type WatchedPath } from '../../config/store.js';
import { ensureDaemonRunning, messageForEnsureResult } from '../../daemon/lifecycle.js';
import { getAutostartStatus } from '../../daemon/autostart.js';

export type OverlapResult =
  | { ok: true }
  | { ok: false; conflict: WatchedPath; reason: 'covered_by' | 'covers' };

export function isAllowedExtension(filePath: string, allowedExtensions: string[]): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return allowedExtensions.includes(ext);
}

export async function checkOverlap(
  targetPath: string,
  targetKind: 'file' | 'directory',
  config: Config,
): Promise<OverlapResult> {
  const targetResolved = path.resolve(targetPath);

  for (const wp of config.paths) {
    const wpResolved = path.resolve(wp.path);

    // Exact match — defer to addWatchedPath's "Already watching" path.
    if (targetResolved === wpResolved) continue;

    const wpStat = await fs.promises.stat(wpResolved).catch(() => null);
    if (!wpStat) continue; // stale config entry; don't block new watch

    // covered_by: target is inside an existing watched directory.
    if (wpStat.isDirectory() && targetResolved.startsWith(wpResolved + path.sep)) {
      return { ok: false, conflict: wp, reason: 'covered_by' };
    }

    // covers: target is a directory that would absorb an existing watched entry.
    if (targetKind === 'directory' && wpResolved.startsWith(targetResolved + path.sep)) {
      return { ok: false, conflict: wp, reason: 'covers' };
    }
  }

  return { ok: true };
}

export async function watch(args: Record<string, unknown>): Promise<void> {
  const targetPath = (args._ as string[])?.[0] ?? (args.path as string);
  if (!targetPath) {
    console.error('Usage: munchfile watch <file-or-folder> [--recursive] [--public|--unlisted|--private]');
    process.exit(1);
  }

  // Resolve ~ and relative paths
  const resolved = targetPath.replace(/^~/, os.homedir());
  const absolute = path.isAbsolute(resolved) ? resolved : path.resolve(resolved);

  // Verify path exists and determine kind
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolute);
  } catch {
    console.error(`Error: Path does not exist: ${absolute}`);
    process.exit(1);
  }
  const kind: 'file' | 'directory' = stat.isFile() ? 'file' : 'directory';

  const config = await loadConfig();

  // Phase-1 allowlist enforcement for single-file watches.
  // Folder watches apply the allowlist per-file via shouldUpload at upload time.
  if (kind === 'file' && !isAllowedExtension(absolute, config.watchDefaults.allowedExtensions)) {
    console.error('Error: munchfile currently supports markdown (.md/.markdown) and HTML (.html/.htm) files only.');
    console.error('       To watch a different file type, wait for Phase 2 or convert to markdown.');
    process.exit(1);
  }

  const overlap = await checkOverlap(absolute, kind, config);
  if (!overlap.ok) {
    if (overlap.reason === 'covered_by') {
      console.error(`Error: ${absolute} is already covered by watched folder ${overlap.conflict.path}.`);
      console.error(`       To watch this ${kind} with different settings:`);
      console.error(`         1. munchfile unwatch ${overlap.conflict.path}`);
      console.error(`         2. munchfile watch ${absolute} --<visibility>`);
      console.error(`       Note: existing URLs from ${overlap.conflict.path} are preserved across`);
      console.error(`       unwatch/rewatch (the daemon matches by file path on next start).`);
    } else {
      console.error(`Error: ${absolute} would cover the already-watched file ${overlap.conflict.path}.`);
      console.error(`       To watch this folder, first remove the file watch:`);
      console.error(`         1. munchfile unwatch ${overlap.conflict.path}`);
      console.error(`         2. munchfile watch ${absolute}`);
      console.error(`       Note: ${overlap.conflict.path}'s URL is preserved across`);
      console.error(`       unwatch/rewatch (the daemon matches by file path on next start).`);
    }
    process.exit(1);
  }

  const visibility = (
    args.public ? 'public'
    : args.unlisted ? 'unlisted'
    : args.private ? 'private'
    : undefined
  ) ?? config.watchDefaults.visibility;

  const recursive = (args.recursive as boolean | undefined) ?? config.watchDefaults.recursive;

  const { entry, created } = await addWatchedPath({
    path: absolute,
    visibility,
    recursive,
    allowedExtensions: config.watchDefaults.allowedExtensions,
    excludePatterns: config.watchDefaults.excludePatterns,
    maxFileSizeMb: config.daemon.maxFileSizeMb,
  });

  if (!created) {
    const settingsDiffer = entry.visibility !== visibility || entry.recursive !== recursive;
    console.log(`Already watching: ${absolute}`);
    console.log(`   Visibility: ${entry.visibility}`);
    console.log(`   Recursive: ${entry.recursive ? 'yes' : 'no'}`);
    console.log(`   ID: ${entry.id}`);
    if (settingsDiffer) {
      console.log('');
      console.log(`⚠️  Requested visibility=${visibility} / recursive=${recursive ? 'yes' : 'no'} ignored.`);
      console.log(`   To change settings, unwatch first:`);
      console.log(`     munchfile unwatch ${absolute}`);
      console.log(`     munchfile watch ${absolute} --${visibility}${recursive ? ' --recursive' : ''}`);
    }
  } else {
    const kindLabel = kind === 'file' ? 'file' : 'folder';
    console.log(`✅ Now watching ${kindLabel}: ${absolute}`);
    console.log(`   Visibility: ${visibility}`);
    if (kind === 'directory') {
      console.log(`   Recursive: ${recursive ? 'yes' : 'no'}`);
    }
    console.log(`   ID: ${entry.id}`);
  }

  console.log('');

  // Ensure the daemon is running with the latest config — runs regardless of
  // `created`, so re-watching an existing path still respawns if needed (B10
  // from v1 review).
  const updatedConfig = await loadConfig();
  const result = await ensureDaemonRunning(updatedConfig);
  console.log(
    messageForEnsureResult(result, {
      pathsCount: updatedConfig.paths.length,
      mode: 'watch',
      created,
    })
  );

  if (result.kind === 'spawned') {
    try {
      const as = getAutostartStatus();
      if (!as.enabled && as.platform !== 'unsupported') {
        console.log('   Tip: Run `munchfile autostart enable` so munchfile starts automatically on login.');
      }
    } catch { /* non-critical */ }
  }
}
