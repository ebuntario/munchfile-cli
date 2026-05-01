import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DIR = path.join(os.tmpdir(), `.munchfile-state-test-${Date.now()}-${process.pid}`);
const FAKE_HOME = TEST_DIR;
const STATE_DIR = path.join(FAKE_HOME, '.munchfile');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, default: { ...actual, homedir: () => FAKE_HOME } };
});

const WATCHED = path.join(FAKE_HOME, 'notes');
const DIRS = [WATCHED];

function makeRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    path: path.join(WATCHED, 'a.md'),
    slug: 'abc123',
    hash: 'h-a',
    size: 100,
    mtimeMs: 1700000000000,
    isActive: true,
    stale: false,
    staleSince: null,
    visibility: 'private',
    ...overrides,
  };
}

describe('state-store', () => {
  beforeEach(() => {
    vi.resetModules();
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(WATCHED, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('load', () => {
    it('cold load — no state.json → empty store, no error', async () => {
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);
      expect(store.size).toBe(0);
    });

    it('warm load — valid v1 file → records populated', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(
        STATE_PATH,
        JSON.stringify({
          version: 1,
          updatedAt: 1700000000000,
          files: [makeRecord()],
        })
      );
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);
      expect(store.size).toBe(1);
      const r = store.get(path.join(WATCHED, 'a.md'));
      expect(r?.slug).toBe('abc123');
      expect(r?.hash).toBe('h-a');
      expect(r?.size).toBe(100);
      expect(r?.needsUpload).toBe(false); // runtime-only, never persisted
    });

    it('corrupt JSON → empty store, warning emitted', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_PATH, '{not json');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);
      expect(store.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
      warn.mockRestore();
    });

    it('future version → renames to .bak, returns empty store', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(
        STATE_PATH,
        JSON.stringify({ version: 999, updatedAt: 0, files: [] })
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);
      expect(store.size).toBe(0);
      expect(fs.existsSync(STATE_PATH)).toBe(false);
      expect(fs.existsSync(`${STATE_PATH}.v999.bak`)).toBe(true);
      warn.mockRestore();
    });

    it('drops entries with non-absolute paths', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(
        STATE_PATH,
        JSON.stringify({
          version: 1,
          updatedAt: 0,
          files: [
            makeRecord({ path: 'relative/path.md' }),
            makeRecord({ path: path.join(WATCHED, 'good.md'), slug: 'good' }),
          ],
        })
      );
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);
      expect(store.size).toBe(1);
      expect(store.get(path.join(WATCHED, 'good.md'))?.slug).toBe('good');
    });

    it('drops entries with `..` segments', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const sneaky = path.join(WATCHED, '..', 'escape.md');
      fs.writeFileSync(
        STATE_PATH,
        JSON.stringify({
          version: 1,
          updatedAt: 0,
          files: [
            makeRecord({ path: sneaky }),
            makeRecord({ path: path.join(WATCHED, 'good.md'), slug: 'good' }),
          ],
        })
      );
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);
      expect(store.size).toBe(1);
      expect(store.get(path.join(WATCHED, 'good.md'))?.slug).toBe('good');
    });

    it('prunes entries not under any active watched dir', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(
        STATE_PATH,
        JSON.stringify({
          version: 1,
          updatedAt: 0,
          files: [
            makeRecord({ path: '/var/log/other.md' }),
            makeRecord({ path: path.join(WATCHED, 'good.md'), slug: 'good' }),
          ],
        })
      );
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);
      expect(store.size).toBe(1);
      expect(store.get(path.join(WATCHED, 'good.md'))?.slug).toBe('good');
    });

    it('refuses to follow a symlink at state.json', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const decoy = path.join(STATE_DIR, 'decoy.json');
      fs.writeFileSync(
        decoy,
        JSON.stringify({ version: 1, updatedAt: 0, files: [makeRecord()] })
      );
      fs.symlinkSync(decoy, STATE_PATH);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);
      expect(store.size).toBe(0);
      warn.mockRestore();
    });
  });

  describe('write', () => {
    it('flushNow writes file with mode 0600 and sorted keys', async () => {
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);
      store.set(path.join(WATCHED, 'a.md'), {
        slug: 'a',
        hash: 'h',
        size: 1,
        mtimeMs: 100,
        isActive: true,
        stale: false,
        staleSince: null,
        needsUpload: false,
        visibility: 'private',
      });
      await store.flushNow();

      const stat = fs.statSync(STATE_PATH);
      expect(stat.mode & 0o777).toBe(0o600);

      const raw = fs.readFileSync(STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0]).toEqual({
        path: path.join(WATCHED, 'a.md'),
        slug: 'a',
        hash: 'h',
        size: 1,
        mtimeMs: 100,
        isActive: true,
        stale: false,
        staleSince: null,
        visibility: 'private',
      });
      // needsUpload is runtime-only, never persisted
      expect(parsed.files[0]).not.toHaveProperty('needsUpload');
    });

    it('debounce coalesces multiple sets into one disk write', async () => {
      const { StateStore, DEBOUNCE_MS } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);

      // Count atomic-rename completions (one per flush). renameSync is called
      // exactly once inside writeAtomic, so this is the canonical flush count.
      let renameCount = 0;
      const origRenameSync = fs.renameSync;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
        renameCount += 1;
        return origRenameSync.apply(fs, args as Parameters<typeof origRenameSync>);
      });

      // 5 sets within the debounce window — should coalesce into 1 timer-fired flush
      for (let i = 0; i < 5; i += 1) {
        store.set(path.join(WATCHED, `f${i}.md`), {
          slug: `s${i}`,
          hash: 'h',
          size: 1,
          mtimeMs: 100,
          isActive: true,
          stale: false,
          staleSince: null,
          needsUpload: false,
          visibility: 'private',
        });
      }

      // Wait past debounce window for timer to fire
      await new Promise(r => setTimeout(r, DEBOUNCE_MS + 100));
      // Wait an additional tick for the writeChain promise to settle
      await new Promise(r => setImmediate(r));

      // Coalesced: 5 sets → 1 flush from the debounce timer.
      // (Allow up to 2 in case timer fired while writeChain was still settling.)
      expect(renameCount).toBeGreaterThanOrEqual(1);
      expect(renameCount).toBeLessThanOrEqual(2);
      renameSpy.mockRestore();
    });

    it('immediate flush bypasses debounce', async () => {
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);

      store.set(
        path.join(WATCHED, 'a.md'),
        {
          slug: 'a',
          hash: null,
          size: 0,
          mtimeMs: 0,
          isActive: true,
          stale: false,
          staleSince: null,
          needsUpload: false,
          visibility: 'private',
        },
        { immediate: true }
      );

      // Wait briefly for the chained promise to write — immediate triggers
      // flushNow synchronously which queues writeChain.
      await new Promise(r => setImmediate(r));
      await new Promise(r => setTimeout(r, 50));

      expect(fs.existsSync(STATE_PATH)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      expect(parsed.files[0].slug).toBe('a');
    });

    it('concurrent flushNow calls are serialized via writeChain', async () => {
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);

      store.set(path.join(WATCHED, 'a.md'), {
        slug: 'a',
        hash: 'h1',
        size: 1,
        mtimeMs: 1,
        isActive: true,
        stale: false,
        staleSince: null,
        needsUpload: false,
        visibility: 'private',
      });
      const p1 = store.flushNow();
      store.set(path.join(WATCHED, 'b.md'), {
        slug: 'b',
        hash: 'h2',
        size: 2,
        mtimeMs: 2,
        isActive: true,
        stale: false,
        staleSince: null,
        needsUpload: false,
        visibility: 'private',
      });
      const p2 = store.flushNow();

      await Promise.all([p1, p2]);

      const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      // Final state should reflect both records (last write wins on the snapshot
      // taken when the second flushNow ran).
      const slugs = parsed.files.map((f: { slug: string }) => f.slug).sort();
      expect(slugs).toEqual(['a', 'b']);
    });

    it('close cancels pending debounce, performs final write, idempotent', async () => {
      const { StateStore } = await import('../../daemon/state-store.js');
      const store = await StateStore.load(DIRS);

      store.set(path.join(WATCHED, 'a.md'), {
        slug: 'a',
        hash: 'h',
        size: 1,
        mtimeMs: 1,
        isActive: true,
        stale: false,
        staleSince: null,
        needsUpload: false,
        visibility: 'private',
      });

      await store.close();
      expect(fs.existsSync(STATE_PATH)).toBe(true);

      // Idempotent — second close doesn't throw
      await store.close();

      // After close, set is a no-op for flush (no further timer scheduled)
      store.set(path.join(WATCHED, 'b.md'), {
        slug: 'b',
        hash: 'h',
        size: 1,
        mtimeMs: 1,
        isActive: true,
        stale: false,
        staleSince: null,
        needsUpload: false,
        visibility: 'private',
      });
      await new Promise(r => setTimeout(r, 50));
      const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      // b.md should NOT have been written because close() set closed=true
      const slugs = parsed.files.map((f: { slug: string }) => f.slug);
      expect(slugs).toContain('a');
      expect(slugs).not.toContain('b');
    });
  });
});
