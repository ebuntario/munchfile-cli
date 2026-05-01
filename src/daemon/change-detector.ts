/**
 * ChangeDetector — debounces rapid file saves and skips re-uploads
 * when content hasn't actually changed (stable hash).
 */

import { hashFile } from '../utils/hash.js';

export interface ChangeEvent {
  type: 'change' | 'unlink';
  filePath: string;
  hash?: string;
  error?: string;
}

export class ChangeDetector {
  private readonly filePath: string;
  private readonly debounceMs: number;
  private lastHash: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Array<(result: ChangeEvent) => void> = [];

  constructor(filePath: string, debounceMs = 500) {
    this.filePath = filePath;
    this.debounceMs = debounceMs;
  }

  /** Called by the watcher on every file change event. */
  async onFileChange(): Promise<ChangeEvent> {
    return new Promise<ChangeEvent>(resolve => {
      this.queue.push(resolve);
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => { this.fire(); }, this.debounceMs);
    });
  }

  private async fire() {
    try {
      const { hash } = await hashFile(this.filePath);
      if (hash === this.lastHash) {
        // Content unchanged — no-op
        this.resolveAll({ type: 'change', filePath: this.filePath });
        return;
      }
      this.lastHash = hash;
      this.resolveAll({ type: 'change', filePath: this.filePath, hash });
    } catch (err) {
      this.resolveAll({ type: 'change', filePath: this.filePath, error: String(err) });
    }
  }

  private resolveAll(result: ChangeEvent) {
    const q = this.queue;
    this.queue = [];
    q.forEach(r => r(result));
  }

  /** Mark the file as deleted/moved away. */
  signalUnlink(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.resolveAll({ type: 'unlink', filePath: this.filePath });
  }

  /** Seed lastHash from a known-good hash so the next change event can short-circuit. */
  seedHash(hash: string): void {
    this.lastHash = hash;
  }
}
