import { describe, it, expect } from 'vitest';
import { messageForEnsureResult } from '../../daemon/lifecycle.js';

describe('messageForEnsureResult (P-N1: exhaustive dispatch)', () => {
  it('login + spawned + priorDaemon=true → "restarted with new credentials"', () => {
    const msg = messageForEnsureResult(
      { kind: 'spawned' },
      { pathsCount: 2, mode: 'login', priorDaemon: true }
    );
    expect(msg).toContain('restarted with new credentials');
  });

  it('login + restarted + priorDaemon=true → "restarted with new credentials"', () => {
    const msg = messageForEnsureResult(
      { kind: 'restarted' },
      { pathsCount: 2, mode: 'login', priorDaemon: true }
    );
    expect(msg).toContain('restarted with new credentials');
  });

  it('login + restarted + priorDaemon=false → falls into login branch (P-N1)', () => {
    // The non-priorDaemon login restart case must NOT return undefined.
    const msg = messageForEnsureResult(
      { kind: 'restarted' },
      { pathsCount: 2, mode: 'login', priorDaemon: false }
    );
    expect(msg).toBeTruthy();
    expect(msg).not.toBe('undefined');
    expect(msg).toContain('syncing in the background');
  });

  it('login + spawned + priorDaemon=false → "now syncing in the background"', () => {
    const msg = messageForEnsureResult(
      { kind: 'spawned' },
      { pathsCount: 1, mode: 'login', priorDaemon: false }
    );
    expect(msg).toContain('now syncing in the background');
  });

  it('watch + restarted + created=true → "restarted with new path" (P3)', () => {
    const msg = messageForEnsureResult(
      { kind: 'restarted' },
      { pathsCount: 3, mode: 'watch', created: true }
    );
    expect(msg).toContain('restarted with new path');
    expect(msg).toContain('3 paths');
  });

  it('watch + restarted + created=false → "restarted (now syncing" without "with new path" (P3)', () => {
    const msg = messageForEnsureResult(
      { kind: 'restarted' },
      { pathsCount: 2, mode: 'watch', created: false }
    );
    expect(msg).toContain('restarted (now syncing');
    expect(msg).not.toContain('with new path');
  });

  it('watch + spawned (cold) → "now syncing in the background"', () => {
    const msg = messageForEnsureResult(
      { kind: 'spawned' },
      { pathsCount: 1, mode: 'watch', created: true }
    );
    expect(msg).toContain('now syncing in the background');
  });

  it('unwatch + spawned → "now syncing your remaining"', () => {
    const msg = messageForEnsureResult(
      { kind: 'spawned' },
      { pathsCount: 2, mode: 'unwatch' }
    );
    expect(msg).toContain('now syncing your remaining 2 paths');
  });

  it('unwatch + restarted → "restarted (now syncing N paths)"', () => {
    const msg = messageForEnsureResult(
      { kind: 'restarted' },
      { pathsCount: 2, mode: 'unwatch', created: false }
    );
    expect(msg).toContain('restarted (now syncing 2 paths)');
  });

  it('no-token → "Run `munchfile login`"', () => {
    const msg = messageForEnsureResult(
      { kind: 'no-token' },
      { pathsCount: 1, mode: 'watch', created: true }
    );
    expect(msg).toContain('munchfile login');
  });

  it('unsupported-platform → contains WINDOWS_UNSUPPORTED_MESSAGE (P1)', () => {
    const msg = messageForEnsureResult(
      { kind: 'unsupported-platform' },
      { pathsCount: 1, mode: 'watch', created: true }
    );
    expect(msg).toContain('not supported on Windows');
    expect(msg).toContain('munchfile start');
  });

  it('foreign-pid → actionable error (B18)', () => {
    const msg = messageForEnsureResult(
      { kind: 'foreign-pid' },
      { pathsCount: 1, mode: 'watch', created: true }
    );
    expect(msg).toContain('owned by another user');
    expect(msg).toContain('ls -la');
  });

  it('spawn-failed → wraps the error message', () => {
    const msg = messageForEnsureResult(
      { kind: 'spawn-failed', error: new Error('lock contention') },
      { pathsCount: 1, mode: 'watch', created: true }
    );
    expect(msg).toContain('Failed to start');
    expect(msg).toContain('lock contention');
  });

  it('singular path label for pathsCount === 1', () => {
    const msg = messageForEnsureResult(
      { kind: 'restarted' },
      { pathsCount: 1, mode: 'watch', created: true }
    );
    expect(msg).toContain('1 path)');
  });

  it('does NOT contain "reloaded" anywhere in the dispatch (B15)', () => {
    const cases: Array<[Parameters<typeof messageForEnsureResult>[0], Parameters<typeof messageForEnsureResult>[1]]> = [
      [{ kind: 'restarted' }, { pathsCount: 1, mode: 'watch', created: true }],
      [{ kind: 'restarted' }, { pathsCount: 1, mode: 'watch', created: false }],
      [{ kind: 'restarted' }, { pathsCount: 1, mode: 'login', priorDaemon: true }],
      [{ kind: 'spawned' }, { pathsCount: 1, mode: 'login', priorDaemon: true }],
    ];
    for (const [r, ctx] of cases) {
      expect(messageForEnsureResult(r, ctx)).not.toContain('reloaded');
    }
  });
});
