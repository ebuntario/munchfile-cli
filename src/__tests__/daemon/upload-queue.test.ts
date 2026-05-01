import { describe, it, expect } from 'vitest';
import { UploadQueue } from '../../daemon/upload-queue.js';

describe('UploadQueue', () => {
  it('executes tasks for same file in order', async () => {
    const queue = new UploadQueue(1, 10);
    const order: number[] = [];

    await Promise.all([
      queue.enqueue('/a.md', async () => { order.push(1); return 1; }),
      queue.enqueue('/a.md', async () => { order.push(2); return 2; }),
      queue.enqueue('/a.md', async () => { order.push(3); return 3; }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('executes tasks for different files in parallel', async () => {
    const queue = new UploadQueue(1, 10);
    const results: string[] = [];

    await Promise.all([
      queue.enqueue('/a.md', async () => { results.push('a'); }),
      queue.enqueue('/b.md', async () => { results.push('b'); }),
    ]);

    expect(results).toHaveLength(2);
    expect(results).toContain('a');
    expect(results).toContain('b');
  });

  it('retries failed tasks with exponential backoff', async () => {
    const queue = new UploadQueue(3, 10);
    let attempts = 0;

    const result = await queue.enqueue('/a.md', async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('rejects after max retries exceeded', async () => {
    const queue = new UploadQueue(2, 10);

    await expect(
      queue.enqueue('/a.md', async () => { throw new Error('permanent fail'); })
    ).rejects.toThrow('permanent fail');
  });
});
