import { describe, it, expect } from 'vitest';
import { UploadQueue } from '../../daemon/upload-queue.js';

describe('UploadQueue.drain (B1: activeTasks add-before-await)', () => {
  it('awaits in-flight task that is mid-await', async () => {
    const queue = new UploadQueue(1, 10);
    let resolveTask!: () => void;
    const taskPromise = new Promise<void>(r => { resolveTask = r; });
    let taskCompleted = false;

    // Enqueue a task that blocks on a deferred promise.
    queue.enqueue('/a.md', async () => {
      await taskPromise;
      taskCompleted = true;
    }).catch(() => {});

    // Yield once so processQueue runs and adds the task to activeTasks.
    await new Promise(r => setTimeout(r, 5));

    // Begin drain — must wait for the in-flight task.
    const drainPromise = queue.drain(1000);

    // At this point drain must NOT have resolved yet.
    let drainResolved = false;
    drainPromise.then(() => { drainResolved = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(drainResolved).toBe(false);

    // Complete the in-flight task.
    resolveTask();
    await drainPromise;
    expect(taskCompleted).toBe(true);
  });

  it('drain timeout escapes after timeoutMs even if task hangs forever', async () => {
    const queue = new UploadQueue(1, 10);

    // Enqueue a task that never resolves.
    queue.enqueue('/a.md', () => new Promise<void>(() => {})).catch(() => {});
    await new Promise(r => setTimeout(r, 5));

    const start = Date.now();
    await queue.drain(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  it('drain rejects new enqueues', async () => {
    const queue = new UploadQueue(1, 10);
    await queue.drain(10);
    await expect(
      queue.enqueue('/a.md', async () => 'x')
    ).rejects.toThrow('Daemon shutting down');
  });

  it('drain returns immediately when no active tasks', async () => {
    const queue = new UploadQueue(1, 10);
    const start = Date.now();
    await queue.drain(5000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
