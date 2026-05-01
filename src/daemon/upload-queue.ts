/**
 * Per-file serial upload queue with exponential backoff.
 * Uploads for the same file are ordered; different files are parallel.
 */

import { AuthError, RateLimitError } from '../api/client.js';

interface QueueEntry {
  task: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class UploadQueue {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly fileQueues = new Map<string, QueueEntry[]>();
  private readonly processing = new Map<string, boolean>();
  private readonly activeTasks = new Set<Promise<unknown>>();
  private shuttingDown = false;

  constructor(maxRetries = 3, baseDelayMs = 1000) {
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
  }

  enqueue(filePath: string, task: () => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.shuttingDown) {
        reject(new Error('Daemon shutting down'));
        return;
      }
      if (!this.fileQueues.has(filePath)) {
        this.fileQueues.set(filePath, []);
      }
      this.fileQueues.get(filePath)!.push({ task, resolve, reject });
      if (!this.processing.get(filePath)) {
        this.processQueue(filePath);
      }
    });
  }

  /**
   * Synchronously reject all queued tasks. In-flight tasks are NOT awaited.
   * Used as a fast-shutdown placeholder; for graceful shutdown use `drain()`.
   * @deprecated prefer `drain()` for graceful shutdown
   */
  shutdown(): void {
    this.shuttingDown = true;
    for (const queue of this.fileQueues.values()) {
      for (const entry of queue) {
        entry.reject(new Error('Daemon shutting down'));
      }
      queue.length = 0;
    }
  }

  /**
   * Reject queued tasks and AWAIT in-flight tasks (up to timeoutMs).
   * Used for graceful shutdown.
   */
  async drain(timeoutMs = 30000): Promise<void> {
    this.shuttingDown = true;
    for (const queue of this.fileQueues.values()) {
      for (const entry of queue) {
        entry.reject(new Error('Daemon shutting down'));
      }
      queue.length = 0;
    }
    if (this.activeTasks.size === 0) return;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<void>(resolve => {
      timeoutHandle = setTimeout(resolve, timeoutMs);
      timeoutHandle.unref();
    });
    try {
      await Promise.race([
        Promise.allSettled([...this.activeTasks]).then(() => undefined),
        timeout,
      ]);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  }

  private async processQueue(filePath: string) {
    const queue = this.fileQueues.get(filePath);
    if (!queue || queue.length === 0 || this.shuttingDown) {
      this.processing.set(filePath, false);
      return;
    }
    this.processing.set(filePath, true);
    const { task, resolve, reject } = queue.shift()!;
    // Critical ordering: add to activeTasks BEFORE awaiting, remove in finally.
    // This closes the drain-miss race where a task is between shift() and the
    // await — drain would otherwise see empty activeTasks and return early.
    const p = this.withRetry(task);
    this.activeTasks.add(p);
    try {
      resolve(await p);
    } catch (err) {
      reject(err);
    } finally {
      this.activeTasks.delete(p);
    }
    this.processQueue(filePath);
  }

  private async withRetry(task: () => Promise<unknown>, attempt = 1): Promise<unknown> {
    try {
      return await task();
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (attempt >= this.maxRetries) throw err;
      const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt - 1);
      // Step 21: respect server's Retry-After when 429'd. Without this the
      // exponential backoff burns the retry budget in seconds against a server
      // that's still in a longer rate-limit window.
      const delay = err instanceof RateLimitError && err.retryAfter > 0
        ? Math.max(err.retryAfter * 1000, exponentialDelay)
        : exponentialDelay;
      console.warn(`Upload failed (${attempt}/${this.maxRetries}): ${err}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return this.withRetry(task, attempt + 1);
    }
  }
}
