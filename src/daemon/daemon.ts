import path from 'path';
import fs from 'fs';
import { WatchManager, type WatchEvent } from './watcher.js';
import { UploadQueue } from './upload-queue.js';
import { uploadFile } from './file-processor.js';
import { loadConfig, type Config, type WatchedPath } from '../config/store.js';
import { getSessionToken } from '../auth/session.js';
import { generateSlug } from '../utils/slug.js';
import { apiFetch, listFiles, AuthError } from '../api/client.js';
import { hashFile } from '../utils/hash.js';
import { shouldUpload } from '../utils/filter.js';
import { viewerUrl } from '../utils/urls.js';
import { recordFailure } from './failure-log.js';
import { StateStore, MTIME_TOLERANCE_MS, type FileRecord } from './state-store.js';

const REHYDRATE_STALE_CUTOFF_MS = 90 * 24 * 60 * 60 * 1000;
const PROGRESS_INTERVAL = 25;

export class MunchFileDaemon {
  private readonly watchManager: WatchManager;
  private readonly uploadQueue: UploadQueue;
  private readonly apiBaseUrl: string;
  private token: string | null = null;
  private config: Config | null = null;
  private state: StateStore = new StateStore();
  private shuttingDown = false;
  private tornDown = false;

  constructor(options: { apiBaseUrl: string; state?: StateStore }) {
    this.apiBaseUrl = options.apiBaseUrl;
    this.watchManager = new WatchManager(this.onWatchEvent.bind(this));
    this.uploadQueue = new UploadQueue();
    if (options.state) this.state = options.state;
  }

  async start(): Promise<void> {
    this.token = await getSessionToken();
    if (!this.token) throw new Error('Not logged in. Run `munchfile login` first.');

    this.config = await loadConfig();
    console.log(`📂 Watching ${this.config.paths.length} path(s)`);

    const activeDirs = this.config.paths.map(p => path.resolve(p.path));
    // Only load if not already injected (tests inject their own).
    if (this.state.size === 0) {
      this.state = await StateStore.load(activeDirs);
    }

    let rehydrated = false;
    try {
      await this.rehydrate();
      rehydrated = true;
    } catch (err) {
      if (err instanceof AuthError) {
        await this.handleAuthError(err);
        throw err;
      }
      console.warn(`⚠️  Could not rehydrate from server: ${err}.`);
    }

    // AC9b: if state.json was empty (cold load) AND rehydrate failed (server
    // unreachable) AND we have watched paths, refuse to scan rather than
    // silently mint new slugs and break shared URLs.
    if (!rehydrated && this.state.size === 0 && this.config.paths.length > 0) {
      console.error(
        '❌ state.json is missing AND server is unreachable. Refusing to scan ' +
          'to avoid minting new slugs that would break shared URLs. ' +
          'Restore network and restart to reconcile.'
      );
      process.exitCode = 1;
      throw new Error('state-cold-and-server-offline');
    }

    for (const wp of this.config.paths) {
      console.log(`   ✓ ${wp.path} (${wp.visibility})`);
      try {
        await this.initialScan(wp);
      } catch (err) {
        if (err instanceof AuthError) {
          await this.handleAuthError(err);
          throw err;
        }
        console.warn(`⚠️  Initial scan failed for ${wp.path}: ${err}`);
      }
      await this.watchManager.watch(wp);
    }

    console.log('✅ Daemon running. Press Ctrl+C to stop.\n');
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) {
      // Wait for any in-flight teardown to complete.
      while (!this.tornDown) await new Promise(r => setTimeout(r, 50));
      return;
    }
    this.shuttingDown = true;
    await this.teardown();
  }

  /**
   * Single shutdown path called from BOTH stop() (SIGTERM/SIGINT) and
   * handleAuthError() (401 from API). Order: drain uploads → flush state →
   * close watchers. Idempotent via tornDown guard.
   */
  private async teardown(): Promise<void> {
    if (this.tornDown) return;
    try {
      await this.uploadQueue.drain();
    } catch (err) {
      console.warn(`teardown: upload-queue drain failed: ${err}`);
    }
    try {
      await this.state.close();
    } catch (err) {
      console.warn(`teardown: state-store close failed: ${err}`);
    }
    try {
      this.watchManager.close();
    } catch (err) {
      console.warn(`teardown: watch-manager close failed: ${err}`);
    }
    this.tornDown = true;
  }

  private async rehydrate(): Promise<void> {
    if (!this.token || !this.config) return;
    const remote = await listFiles(this.token, this.apiBaseUrl);
    const watchedDirs = this.config.paths.map(p => path.resolve(p.path));
    const staleCutoff = Date.now() - REHYDRATE_STALE_CUTOFF_MS;

    const candidates = remote.filter(row => {
      if (!row.originalPath) return false;
      if (row.staleSince) {
        const ts = Date.parse(row.staleSince);
        if (!isNaN(ts) && ts < staleCutoff) return false;
      }
      const resolved = path.resolve(row.originalPath);
      return watchedDirs.some(dir => resolved === dir || resolved.startsWith(dir + path.sep));
    });

    let merged = 0;
    let diverged = 0;
    let added = 0;

    for (const row of candidates) {
      const filePath = path.resolve(row.originalPath!);
      const local = this.state.get(filePath);
      const visibility = this.visibilityForPath(filePath) ?? 'private';

      if (local && row.contentHash && local.hash === row.contentHash) {
        // Match: server agrees with local. Ensure isActive reflects server.
        if (local.isActive !== row.isActive) {
          local.isActive = row.isActive;
          local.stale = !row.isActive;
          local.staleSince = row.staleSince ? Date.parse(row.staleSince) : null;
          local.needsUpload = !row.isActive;
          this.state.touch(filePath);
        } else if (!row.isActive && !local.needsUpload) {
          local.needsUpload = true;
        }
        merged += 1;
        continue;
      }

      if (local && row.contentHash && local.hash !== row.contentHash) {
        // Divergence: server is authoritative for the (slug, hash) mapping.
        // Clear mtime/size so initialScan's cheap-gate misses → re-hash → reconcile.
        local.slug = row.slug;
        local.hash = row.contentHash;
        local.size = 0;
        local.mtimeMs = 0;
        local.isActive = row.isActive;
        local.stale = !row.isActive;
        local.staleSince = row.staleSince ? Date.parse(row.staleSince) : null;
        local.needsUpload = !row.isActive;
        this.state.touch(filePath);
        diverged += 1;
        continue;
      }

      // No local record — create from server (no mtime/size; gate will miss).
      const record: FileRecord = {
        slug: row.slug,
        hash: row.contentHash ?? null,
        size: 0,
        mtimeMs: 0,
        isActive: row.isActive,
        stale: !row.isActive,
        staleSince: row.staleSince ? Date.parse(row.staleSince) : null,
        needsUpload: !row.isActive,
        visibility,
      };
      this.state.set(filePath, record);
      added += 1;
    }

    console.log(
      `♻️  Rehydrated: ${merged} matched, ${diverged} diverged, ${added} new. ` +
        `Local cache size: ${this.state.size}.`
    );
  }

  private async initialScan(wp: WatchedPath): Promise<void> {
    console.log(`📂 Scanning ${wp.path}...`);
    const allowedExtensions = new Set(wp.allowedExtensions);
    const excludedPatterns = new Set(wp.excludePatterns);

    let files: string[] = [];
    try {
      files = await this.walkDir(wp.path, wp.recursive, allowedExtensions, excludedPatterns);
    } catch (err) {
      console.warn(`⚠️  Could not walk ${wp.path}: ${err}`);
      return;
    }

    let uploaded = 0;
    let inSync = 0;
    let hashed = 0;
    const total = files.length;
    let i = 0;

    for (const filePath of files) {
      i += 1;
      if (this.shuttingDown) break;

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err) {
        console.warn(`   skip ${filePath}: ${err}`);
        continue;
      }

      const record = this.state.get(filePath);
      const gateHit =
        record !== undefined &&
        record.hash !== null &&
        record.size === stat.size &&
        Math.abs(record.mtimeMs - stat.mtimeMs) <= MTIME_TOLERANCE_MS &&
        !record.needsUpload;

      if (gateHit) {
        // record is non-undefined here (gateHit checks it).
        const r = record!;
        console.log(
          `   gate=hit action=skip path=${path.basename(filePath)} (${i}/${total})`
        );
        inSync += 1;
        if (r.hash) this.watchManager.seedDetector(filePath, r.hash);
        continue;
      }

      const gateReason = !record
        ? 'miss-norecord'
        : record.size !== stat.size
          ? 'miss-size'
          : record.hash === null
            ? 'miss-norecord'
            : record.needsUpload
              ? 'miss-needsupload'
              : 'miss-mtime';

      try {
        const fh = await hashFile(filePath);
        hashed += 1;
        if (i % PROGRESS_INTERVAL === 0) {
          console.log(`   gate=${gateReason} action=hash (${i}/${total})`);
        } else {
          console.log(`   gate=${gateReason} action=hash path=${path.basename(filePath)}`);
        }

        if (record && record.hash === fh.hash && !record.needsUpload) {
          // Hash unchanged after gate miss — refresh stat fields, no upload.
          record.size = fh.size;
          record.mtimeMs = fh.mtimeMs;
          this.state.touch(filePath);
          inSync += 1;
          this.watchManager.seedDetector(filePath, fh.hash);
        } else {
          const slug = this.findOrCreateSlug(filePath, fh);
          this.watchManager.seedDetector(filePath, fh.hash);
          await this.enqueueUpload(filePath, slug);
          uploaded += 1;
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
        console.warn(`   skip ${filePath}: ${err}`);
      }
    }

    console.log(
      `✅ Scanned ${total} files (${uploaded} uploaded, ${inSync} in sync, ${hashed} hashed)`
    );
  }

  private async walkDir(
    dir: string,
    recursive: boolean,
    allowedExtensions: Set<string>,
    excludedPatterns: Set<string>,
  ): Promise<string[]> {
    const resolved = path.resolve(dir);
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (!stat) return [];

    if (stat.isFile()) {
      const decision = shouldUpload(resolved, { allowedExtensions, excludedPatterns });
      return decision.allowed ? [resolved] : [];
    }

    const out: string[] = [];
    const stack: string[] = [resolved];

    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (recursive && shouldUpload(full, { allowedExtensions: new Set(), excludedPatterns }).allowed !== false) {
            // Walk recursively only if directory itself is not excluded.
            const dirCheck = shouldUpload(entry.name, { allowedExtensions: new Set(), excludedPatterns });
            if (dirCheck.allowed) stack.push(full);
          }
        } else if (entry.isFile()) {
          const decision = shouldUpload(full, { allowedExtensions, excludedPatterns });
          if (decision.allowed) out.push(full);
        }
      }
    }

    return out;
  }

  private async onWatchEvent(event: WatchEvent): Promise<void> {
    const { type, filePath } = event;
    if (this.shuttingDown) return;

    if (type === 'unlink') {
      await this.handleUnlink(filePath);
      return;
    }

    try {
      let fh: { hash: string; size: number; mtimeMs: number };
      try {
        fh = await hashFile(filePath);
      } catch (err) {
        console.warn(`   skip ${filePath}: ${err}`);
        return;
      }
      const slug = this.findOrCreateSlug(filePath, fh);
      await this.enqueueUpload(filePath, slug);
    } catch (err) {
      if (err instanceof AuthError) {
        await this.handleAuthError(err);
      } else {
        console.error(`❌ Failed to handle ${filePath}: ${err}`);
      }
    }
  }

  private findOrCreateSlug(
    filePath: string,
    fh: { hash: string; size: number; mtimeMs: number },
  ): string {
    const existing = this.state.get(filePath);
    if (existing) {
      let touched = false;
      if (!existing.isActive && this.isUnderActiveWatchedDir(filePath)) {
        existing.isActive = true;
        existing.stale = false;
        existing.staleSince = null;
        touched = true;
        console.log(`🔄 Re-activating slug ${existing.slug} for ${filePath}`);
      }
      // Refresh stat fields if hash matches; otherwise let enqueueUpload fix them.
      if (existing.hash === fh.hash) {
        if (existing.size !== fh.size || existing.mtimeMs !== fh.mtimeMs) {
          existing.size = fh.size;
          existing.mtimeMs = fh.mtimeMs;
          touched = true;
        }
      }
      if (touched) this.state.touch(filePath);
      return existing.slug;
    }

    const filename = path.basename(filePath);
    const dir = path.dirname(filePath);
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

    for (const [oldPath, record] of this.state.entries()) {
      if (
        path.basename(oldPath) === filename &&
        path.dirname(oldPath) === dir &&
        record.stale &&
        (record.staleSince ?? 0) > fiveMinutesAgo
      ) {
        // B3 fix: mutate fields BEFORE the set/delete pair so a flush
        // triggered between operations sees the post-mutation state.
        record.stale = false;
        record.staleSince = null;
        record.isActive = true;
        record.size = fh.size;
        record.mtimeMs = fh.mtimeMs;
        this.state.set(filePath, record);
        this.state.delete(oldPath);
        console.log(`🔄 Detected atomic replace: ${oldPath} → ${filePath}`);
        return record.slug;
      }
    }

    const slug = generateSlug();
    const visibility = this.visibilityForPath(filePath) ?? 'private';
    this.state.set(
      filePath,
      {
        slug,
        hash: null,
        size: fh.size,
        mtimeMs: fh.mtimeMs,
        isActive: true,
        stale: false,
        staleSince: null,
        needsUpload: false,
        visibility,
      },
      { immediate: true } // W1: flush slug-mint at once to minimize URL-loss window
    );
    return slug;
  }

  private isUnderActiveWatchedDir(filePath: string): boolean {
    if (!this.config) return false;
    const resolved = path.resolve(filePath);
    return this.config.paths.some(wp => {
      const dir = path.resolve(wp.path);
      return resolved === dir || resolved.startsWith(dir + path.sep);
    });
  }

  private visibilityForPath(filePath: string): 'private' | 'unlisted' | 'public' | undefined {
    if (!this.config) return undefined;
    const resolved = path.resolve(filePath);
    for (const wp of this.config.paths) {
      const dir = path.resolve(wp.path);
      if (resolved === dir || resolved.startsWith(dir + path.sep)) {
        return wp.visibility;
      }
    }
    return undefined;
  }

  private async enqueueUpload(filePath: string, slug: string): Promise<void> {
    if (!this.token) throw new Error('No session token');
    const maxSizeBytes = (this.config?.daemon.maxFileSizeMb ?? 100) * 1024 * 1024;
    const visibility = this.visibilityForPath(filePath);

    await this.uploadQueue.enqueue(filePath, async () => {
      console.log(`📤 Uploading ${filePath} → ${viewerUrl(slug)}...`);
      try {
        const result = await uploadFile(filePath, {
          apiBaseUrl: this.apiBaseUrl,
          token: this.token!,
          slug,
          maxSizeBytes,
          visibility,
        });

        const record = this.state.get(filePath);
        if (record) {
          record.hash = result.hash;
          // Refresh stat fields from disk after upload so the cheap-gate
          // matches on next restart. Best-effort; don't fail upload if stat fails.
          try {
            const st = fs.statSync(filePath);
            record.size = st.size;
            record.mtimeMs = st.mtimeMs;
          } catch {
            /* leave existing values */
          }
          record.isActive = true;
          record.stale = false;
          record.staleSince = null;
          record.needsUpload = false;
          this.state.touch(filePath);
        }
        console.log(`✅ Live: ${viewerUrl(slug)}`);
      } catch (err) {
        if (err instanceof AuthError) {
          throw err;
        }
        console.error(`❌ Upload failed: ${err}`);
        await recordFailure({ filePath, error: err as Error, attempts: 3 });
        throw err;
      }
    });
  }

  private async handleUnlink(filePath: string): Promise<void> {
    const record = this.state.get(filePath);
    if (!record) return;

    record.stale = true;
    record.staleSince = Date.now();
    record.isActive = false;
    this.state.touch(filePath);

    console.warn(`⚠️ ${filePath} — FILE MOVED OR DELETED`);
    console.warn(`   Run \`munchfile relink ${record.slug} <new-path>\` to resume.`);

    try {
      await apiFetch(`/files/${record.slug}/stale`, {
        method: 'POST',
        token: this.token ?? '',
        baseUrl: this.apiBaseUrl,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        await this.handleAuthError(err);
      }
      // otherwise ignore — server may be unreachable
    }
  }

  private async handleAuthError(err: AuthError): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    // N1 fix: set exitCode FIRST so a SIGTERM arriving mid-teardown still
    // exits with the right code (the SIGTERM handler reads `process.exitCode ?? 0`
    // and process.exit aborts our await before exitCode would otherwise be set).
    process.exitCode = 1;
    console.error(`❌ Session expired. Run \`munchfile login\` to re-authenticate.`);
    console.error(`   (${err.message})`);
    await this.teardown();
  }
}
