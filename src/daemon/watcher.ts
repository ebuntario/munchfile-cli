/**
 * WatchManager — wraps chokidar and dispatches events to ChangeDetectors.
 */

import fs from 'fs';
import chokidar, { FSWatcher } from 'chokidar';
import { ChangeDetector } from './change-detector.js';
import { shouldUpload } from '../utils/filter.js';
import type { WatchedPath } from '../config/store.js';

export interface WatchEvent {
  type: 'add' | 'change' | 'unlink';
  filePath: string;
  watchedPath: WatchedPath;
}

export class WatchManager {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly detectors = new Map<string, ChangeDetector>();
  private readonly onWatchEvent: (event: WatchEvent) => void;
  private retryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(onWatchEvent: (event: WatchEvent) => void) {
    this.onWatchEvent = onWatchEvent;
  }

  async watch(watchedPath: WatchedPath): Promise<void> {
    const { id, path: targetPath, recursive } = watchedPath;
    const stat = await fs.promises.stat(targetPath).catch(() => null);
    if (!stat) return;

    const watchTarget = stat.isFile()
      ? targetPath
      : (recursive ? `${targetPath}/**/*` : `${targetPath}/*`);

    const watcher = chokidar.watch(watchTarget, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
      ignored: (filePath: string, stats?: fs.Stats) => {
        if (!stats || stats.isDirectory()) return false;
        return !shouldUpload(filePath, {
          allowedExtensions: new Set(watchedPath.allowedExtensions),
          excludedPatterns: new Set(watchedPath.excludePatterns),
        }).allowed;
      },
    });

    watcher.on('add',    (fp) => this.handleEvent('add', fp, watchedPath));
    watcher.on('change', (fp) => this.handleEvent('change', fp, watchedPath));
    watcher.on('unlink', (fp) => this.handleEvent('unlink', fp, watchedPath));
    watcher.on('error',  (err) => this.handleError(id, err));

    this.watchers.set(id, watcher);
  }

  private handleEvent(type: 'add' | 'change' | 'unlink', filePath: string, watchedPath: WatchedPath) {
    if (type === 'unlink') {
      const detector = this.detectors.get(filePath);
      detector?.signalUnlink();
      this.detectors.delete(filePath);
      this.onWatchEvent({ type, filePath, watchedPath });
    } else {
      if (!this.detectors.has(filePath)) {
        this.detectors.set(filePath, new ChangeDetector(filePath));
      }
      this.detectors.get(filePath)!.onFileChange().then(result => {
        if (result.hash) {
          this.onWatchEvent({ type, filePath, watchedPath });
        }
      });
    }
  }

  private handleError(watchedPathId: string, err: Error) {
    console.error(`Watcher error for ${watchedPathId}: ${err.message}`);
    this.unwatch(watchedPathId);
    this.scheduleRetry(watchedPathId);
  }

  private scheduleRetry(watchedPathId: string) {
    const existing = this.retryTimeouts.get(watchedPathId);
    if (existing) clearTimeout(existing);
    // Re-watch is re-triggered by the daemon loading the watchlist — just log
    console.warn(`Will retry watching path ${watchedPathId} on next daemon start.`);
  }

  /**
   * Seed a ChangeDetector for a file with its current hash.
   * Called by initialScan to close the FSEvents race window: if chokidar
   * later fires `add` or `change` for this file with the same hash, the
   * detector's `lastHash` matches and the event is a no-op.
   */
  seedDetector(filePath: string, hash: string): void {
    if (!this.detectors.has(filePath)) {
      this.detectors.set(filePath, new ChangeDetector(filePath));
    }
    this.detectors.get(filePath)!.seedHash(hash);
  }

  unwatch(watchedPathId: string): void {
    const watcher = this.watchers.get(watchedPathId);
    if (watcher) { watcher.close(); this.watchers.delete(watchedPathId); }
  }

  close(): void {
    for (const id of this.watchers.keys()) this.unwatch(id);
    this.retryTimeouts.forEach(t => clearTimeout(t));
  }
}
