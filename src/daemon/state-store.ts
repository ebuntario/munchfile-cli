/**
 * StateStore — persistent local cache of FileRecord across daemon restarts.
 *
 * Storage: ~/.munchfile/state.json (mode 0600).
 * Concurrency: writes serialized through `writeChain` promise; tmp file uses
 *   pid-suffix to avoid cross-writer clobber. Single-writer invariant is
 *   enforced by the spawn-lock in process.ts (acquireSpawnLock); StateStore
 *   does NOT add a second on-disk lock.
 * Security: load uses O_RDONLY | O_NOFOLLOW; tmp create uses
 *   O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW with mode 0o600. Mirrors
 *   process.ts:writePidFile pattern (NOT failure-log.ts which lacks NOFOLLOW).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureConfigDir } from './process.js';

export const STATE_VERSION = 1;
export const MTIME_TOLERANCE_MS = 1;
export const DEBOUNCE_MS = 500;

const CONFIG_DIR = path.join(os.homedir(), '.munchfile');
const STATE_PATH = path.join(CONFIG_DIR, 'state.json');
const TMP_PATH = path.join(CONFIG_DIR, `state.json.${process.pid}.tmp`);

export interface FileRecord {
  slug: string;
  hash: string | null;
  size: number;
  mtimeMs: number;
  isActive: boolean;
  stale: boolean;
  staleSince: number | null;
  needsUpload: boolean;
  visibility: 'private' | 'unlisted' | 'public';
}

interface SerializedRecord {
  path: string;
  slug: string;
  hash: string | null;
  size: number;
  mtimeMs: number;
  isActive: boolean;
  stale: boolean;
  staleSince: number | null;
  visibility: 'private' | 'unlisted' | 'public';
}

interface SerializedState {
  version: number;
  updatedAt: number;
  files: SerializedRecord[];
}

const VALID_VISIBILITY = new Set(['private', 'unlisted', 'public']);

function isValidPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (!path.isAbsolute(p)) return false;
  if (path.resolve(p) !== p) return false;
  if (p.split(path.sep).includes('..')) return false;
  return true;
}

function isValidRecord(r: unknown): r is SerializedRecord {
  if (typeof r !== 'object' || r === null) return false;
  const x = r as Record<string, unknown>;
  return (
    isValidPath(x.path) &&
    typeof x.slug === 'string' &&
    (x.hash === null || typeof x.hash === 'string') &&
    typeof x.size === 'number' &&
    typeof x.mtimeMs === 'number' &&
    typeof x.isActive === 'boolean' &&
    typeof x.stale === 'boolean' &&
    (x.staleSince === null || typeof x.staleSince === 'number') &&
    typeof x.visibility === 'string' &&
    VALID_VISIBILITY.has(x.visibility)
  );
}

function isUnderAnyDir(filePath: string, dirs: string[]): boolean {
  return dirs.some(dir => filePath === dir || filePath.startsWith(dir + path.sep));
}

export class StateStore {
  private map = new Map<string, FileRecord>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  static async load(activeWatchedDirs: string[]): Promise<StateStore> {
    const store = new StateStore();
    let raw: string;

    try {
      // Reject symlink at the file via O_NOFOLLOW (process.ts pattern).
      const fd = fs.openSync(STATE_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        raw = fs.readFileSync(fd, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return store; // cold load — no state.json yet
      if (code === 'ELOOP') {
        console.warn(
          'state-store: refusing to follow symlink at ~/.munchfile/state.json — starting cold.'
        );
        return store;
      }
      console.warn(`state-store: could not read state.json (${code ?? err}) — starting cold.`);
      return store;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('state-store: state.json is corrupt — starting cold.');
      return store;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { version?: unknown }).version !== 'number'
    ) {
      console.warn('state-store: state.json missing version — starting cold.');
      return store;
    }

    const version = (parsed as SerializedState).version;
    if (version !== STATE_VERSION) {
      // Forward compat: rename to .bak rather than overwriting (W4).
      const bakPath = `${STATE_PATH}.v${version}.bak`;
      try {
        fs.renameSync(STATE_PATH, bakPath);
        console.warn(
          `state-store: state.json version ${version} != ${STATE_VERSION}; ` +
            `renamed to ${path.basename(bakPath)} — starting cold.`
        );
      } catch (err) {
        console.warn(
          `state-store: state.json version mismatch and could not rename to .bak: ${err}`
        );
      }
      return store;
    }

    const files = (parsed as SerializedState).files;
    if (!Array.isArray(files)) {
      console.warn('state-store: state.json.files is not an array — starting cold.');
      return store;
    }

    const normalizedDirs = activeWatchedDirs.map(d => path.resolve(d));

    let dropped = 0;
    for (const r of files) {
      if (!isValidRecord(r)) {
        dropped += 1;
        continue;
      }
      if (!isUnderAnyDir(r.path, normalizedDirs)) {
        dropped += 1;
        continue; // prune entries no longer under any active watched dir
      }
      const record: FileRecord = {
        slug: r.slug,
        hash: r.hash,
        size: r.size,
        mtimeMs: r.mtimeMs,
        isActive: r.isActive,
        stale: r.stale,
        staleSince: r.staleSince,
        needsUpload: false, // runtime-only; never persisted
        visibility: r.visibility,
      };
      store.map.set(r.path, record);
    }

    if (dropped > 0) {
      console.log(
        `📦 Loaded ${store.map.size} record(s) from state.json (${dropped} pruned/invalid).`
      );
    } else if (store.map.size > 0) {
      console.log(`📦 Loaded ${store.map.size} record(s) from state.json.`);
    }

    return store;
  }

  get size(): number {
    return this.map.size;
  }

  get(filePath: string): FileRecord | undefined {
    return this.map.get(filePath);
  }

  has(filePath: string): boolean {
    return this.map.has(filePath);
  }

  entries(): IterableIterator<[string, FileRecord]> {
    return this.map.entries();
  }

  set(filePath: string, record: FileRecord, opts?: { immediate?: boolean }): void {
    this.map.set(filePath, record);
    this.markDirty(opts?.immediate ?? false);
  }

  delete(filePath: string): boolean {
    const existed = this.map.delete(filePath);
    if (existed) this.markDirty(false);
    return existed;
  }

  /** Notify the store that a record's fields were mutated in-place. */
  touch(filePath: string): void {
    if (this.map.has(filePath)) this.markDirty(false);
  }

  private markDirty(immediate: boolean): void {
    if (this.closed) return;
    if (immediate) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      void this.flushNow();
      return;
    }
    if (this.debounceTimer) return; // already scheduled — debounce window reused
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushNow();
    }, DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /**
   * Flush current state to disk. Serialized through writeChain so concurrent
   * callers (debounced timer + explicit flushNow during shutdown) can't race.
   * Snapshots the map at the start of each write so further mutations don't
   * tear the in-flight write.
   */
  flushNow(): Promise<void> {
    const snapshot = this.snapshot();
    this.writeChain = this.writeChain
      .catch(() => {
        /* swallow prior errors so chain continues */
      })
      .then(() => writeAtomic(snapshot));
    return this.writeChain;
  }

  /**
   * Cancel any pending debounced flush, perform a final write, mark closed.
   * Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) {
      // Still wait for any in-flight write before returning.
      await this.writeChain.catch(() => undefined);
      return;
    }
    this.closed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.flushNow().catch(() => undefined);
  }

  private snapshot(): SerializedState {
    const files: SerializedRecord[] = [];
    for (const [filePath, r] of this.map) {
      files.push({
        path: filePath,
        slug: r.slug,
        hash: r.hash,
        size: r.size,
        mtimeMs: r.mtimeMs,
        isActive: r.isActive,
        stale: r.stale,
        staleSince: r.staleSince,
        visibility: r.visibility,
      });
    }
    // Sort for deterministic output (helps snapshot tests + diffs).
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      version: STATE_VERSION,
      updatedAt: Date.now(),
      files,
    };
  }
}

async function writeAtomic(snapshot: SerializedState): Promise<void> {
  ensureConfigDir(); // symlink-safe (process.ts:ensureConfigDir lstat-checks ~/.munchfile)
  const json = JSON.stringify(snapshot, null, 2);

  let fd: number;
  try {
    fd = fs.openSync(
      TMP_PATH,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Stale tmp from a crashed prior writer (same pid — unusual but possible
      // after pid recycle). Unlink and retry once.
      try {
        fs.unlinkSync(TMP_PATH);
      } catch {
        /* ignore */
      }
      fd = fs.openSync(
        TMP_PATH,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      );
    } else {
      console.warn(`state-store: could not open tmp file for write: ${err}`);
      throw err;
    }
  }

  try {
    fs.writeSync(fd, json);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync best-effort */
    }
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(TMP_PATH, STATE_PATH);
  } catch (err) {
    // Cleanup tmp on rename failure to avoid stale tmp accumulation.
    try {
      fs.unlinkSync(TMP_PATH);
    } catch {
      /* ignore */
    }
    console.warn(`state-store: rename to state.json failed: ${err}`);
    throw err;
  }

  // Belt-and-suspenders: re-chmod after rename in case umask leaked or
  // filesystem reset the mode (W2).
  try {
    fs.chmodSync(STATE_PATH, 0o600);
  } catch {
    /* ignore */
  }
}
