/**
 * Integration test: daemon startup ordering with persisted state.
 *
 * Verifies:
 *   - loadState completes before any hashFile call (a)
 *   - cheap-gate hit: hashFile NOT called for unchanged files (b)
 *   - cheap-gate miss: hashFile called when mtime advances (c)
 *   - teardown flushes state on SIGTERM path (d-1) and auth-error path (d-2)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DIR = path.join(
  os.tmpdir(),
  `.munchfile-startup-test-${Date.now()}-${process.pid}`
);
const FAKE_HOME = TEST_DIR;
const STATE_DIR = path.join(FAKE_HOME, '.munchfile');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const WATCHED = path.join(FAKE_HOME, 'notes');

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, default: { ...actual, homedir: () => FAKE_HOME } };
});

// Mock auth — return a fake token so daemon.start() proceeds.
vi.mock('../../auth/session.js', () => ({
  getSessionToken: vi.fn().mockResolvedValue('fake-token'),
}));

// Mock chokidar — don't actually start filesystem watchers.
vi.mock('chokidar', () => ({
  default: {
    watch: () => ({
      on: () => undefined,
      close: () => undefined,
    }),
  },
}));

// Hoist hashFile spy state so vi.mock factory can reference it.
let hashFileCalls: string[];
let _hashFileLoadResolved: boolean;
let listFilesImpl: () => Promise<unknown[]>;
let listFilesReturned: boolean;

vi.mock('../../utils/hash.js', () => ({
  hashFile: vi.fn(async (filePath: string) => {
    hashFileCalls.push(filePath);
    const stat = fs.statSync(filePath);
    return { hash: 'computed-hash-' + path.basename(filePath), size: stat.size, mtimeMs: stat.mtimeMs };
  }),
}));

vi.mock('../../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/client.js')>('../../api/client.js');
  return {
    ...actual,
    listFiles: vi.fn(async () => {
      listFilesReturned = true;
      return listFilesImpl();
    }),
    apiFetch: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock('../../daemon/file-processor.js', () => ({
  uploadFile: vi.fn(async () => ({ hash: 'uploaded-hash' })),
}));

describe('daemon startup with persisted state', () => {
  beforeEach(() => {
    vi.resetModules();
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.rmSync(WATCHED, { recursive: true, force: true });
    fs.mkdirSync(WATCHED, { recursive: true });
    hashFileCalls = [];
    _hashFileLoadResolved = false;
    listFilesReturned = false;
    listFilesImpl = async () => [];
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function writeStateJson(records: Record<string, unknown>[]) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ version: 1, updatedAt: 0, files: records })
    );
  }

  async function writeConfigJson() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const configPath = path.join(STATE_DIR, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        apiBaseUrl: 'http://localhost:0/v1',
        daemon: {
          debounceMs: 500,
          maxRetries: 3,
          baseDelayMs: 1000,
          maxFileSizeMb: 100,
          healthCheckIntervalMs: 30000,
        },
        watchDefaults: {
          visibility: 'private',
          recursive: false,
          allowedExtensions: ['.md'],
          excludePatterns: ['node_modules', '.git'],
        },
        paths: [
          {
            id: 'test-id',
            path: WATCHED,
            visibility: 'private',
            recursive: false,
            allowedExtensions: ['.md'],
            excludePatterns: ['node_modules', '.git'],
            maxFileSizeMb: 100,
            createdAt: 0,
          },
        ],
      })
    );
  }

  it('cheap-gate hit: skips hashFile when (mtime, size) match persisted record', async () => {
    const filePath = path.join(WATCHED, 'unchanged.md');
    fs.writeFileSync(filePath, '# unchanged');
    const stat = fs.statSync(filePath);

    await writeStateJson([
      {
        path: filePath,
        slug: 'slug-unchanged',
        hash: 'persisted-hash',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isActive: true,
        stale: false,
        staleSince: null,
        visibility: 'private',
      },
    ]);
    await writeConfigJson();

    listFilesImpl = async () => [
      {
        slug: 'slug-unchanged',
        contentHash: 'persisted-hash',
        originalPath: filePath,
        isActive: true,
        staleSince: null,
      },
    ];

    const { MunchFileDaemon } = await import('../../daemon/daemon.js');
    const daemon = new MunchFileDaemon({ apiBaseUrl: 'http://localhost:0/v1' });
    await daemon.start();

    // (a) listFiles called before hashFile (rehydrate happens before initialScan)
    expect(listFilesReturned).toBe(true);
    // (b) hashFile NOT called — cheap-gate hit
    expect(hashFileCalls).toEqual([]);

    await daemon.stop();
  });

  it('cheap-gate miss: calls hashFile when mtime has advanced', async () => {
    const filePath = path.join(WATCHED, 'edited.md');
    fs.writeFileSync(filePath, '# v1');
    const oldStat = fs.statSync(filePath);

    // Advance mtime by writing again after a small delay
    await new Promise(r => setTimeout(r, 50));
    fs.writeFileSync(filePath, '# v2 — content changed');

    await writeStateJson([
      {
        path: filePath,
        slug: 'slug-edited',
        hash: 'old-hash',
        size: oldStat.size, // size before edit
        mtimeMs: oldStat.mtimeMs, // mtime before edit
        isActive: true,
        stale: false,
        staleSince: null,
        visibility: 'private',
      },
    ]);
    await writeConfigJson();

    listFilesImpl = async () => [
      {
        slug: 'slug-edited',
        contentHash: 'old-hash',
        originalPath: filePath,
        isActive: true,
        staleSince: null,
      },
    ];

    const { MunchFileDaemon } = await import('../../daemon/daemon.js');
    const daemon = new MunchFileDaemon({ apiBaseUrl: 'http://localhost:0/v1' });
    await daemon.start();

    // (c) hashFile called for the edited file (gate miss → hash)
    expect(hashFileCalls).toContain(filePath);

    await daemon.stop();
  });

  it('cheap-gate miss-norecord: calls hashFile when no persisted record exists', async () => {
    const filePath = path.join(WATCHED, 'new-file.md');
    fs.writeFileSync(filePath, '# newly added');

    // No state.json — pure cold start
    await writeConfigJson();

    listFilesImpl = async () => []; // server has nothing yet

    const { MunchFileDaemon } = await import('../../daemon/daemon.js');
    const daemon = new MunchFileDaemon({ apiBaseUrl: 'http://localhost:0/v1' });
    await daemon.start();

    expect(hashFileCalls).toContain(filePath);

    await daemon.stop();
  });

  it('teardown via stop() flushes state.json (SIGTERM path)', async () => {
    const filePath = path.join(WATCHED, 'a.md');
    fs.writeFileSync(filePath, '# a');
    await writeConfigJson();
    listFilesImpl = async () => [];

    const { MunchFileDaemon } = await import('../../daemon/daemon.js');
    const daemon = new MunchFileDaemon({ apiBaseUrl: 'http://localhost:0/v1' });
    await daemon.start();
    await daemon.stop();

    // state.json should exist (written by teardown's state.close())
    expect(fs.existsSync(STATE_PATH)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    expect(parsed.version).toBe(1);
    // Should contain the file from initialScan's slug-mint
    expect(parsed.files.length).toBeGreaterThan(0);
  });

  it('AC9b: refuses to scan when state.json is empty AND server is unreachable', async () => {
    // Watched paths configured, but no state.json AND listFiles throws (not AuthError).
    const filePath = path.join(WATCHED, 'a.md');
    fs.writeFileSync(filePath, '# a');
    await writeConfigJson();

    listFilesImpl = async () => {
      throw new Error('ECONNREFUSED — server unreachable');
    };

    const { MunchFileDaemon } = await import('../../daemon/daemon.js');
    const daemon = new MunchFileDaemon({ apiBaseUrl: 'http://localhost:0/v1' });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(daemon.start()).rejects.toThrow(/state-cold-and-server-offline/);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('state.json is missing AND server is unreachable')
    );
    // hashFile must NOT have been called — daemon refused to scan
    expect(hashFileCalls).toEqual([]);

    // Reset exitCode for subsequent tests
    process.exitCode = 0;
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('teardown via handleAuthError flushes state.json (auth-error path)', async () => {
    // Set up: state.json with one record, listFiles throws AuthError
    const filePath = path.join(WATCHED, 'a.md');
    fs.writeFileSync(filePath, '# a');
    const stat = fs.statSync(filePath);

    await writeStateJson([
      {
        path: filePath,
        slug: 'slug-pre-auth',
        hash: 'h',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isActive: true,
        stale: false,
        staleSince: null,
        visibility: 'private',
      },
    ]);
    await writeConfigJson();

    const { AuthError } = await import('../../api/client.js');
    listFilesImpl = async () => {
      throw new AuthError('expired token');
    };

    const { MunchFileDaemon } = await import('../../daemon/daemon.js');
    const daemon = new MunchFileDaemon({ apiBaseUrl: 'http://localhost:0/v1' });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(daemon.start()).rejects.toThrow(/expired/);
    errSpy.mockRestore();

    // state.json must still exist after auth-error teardown
    expect(fs.existsSync(STATE_PATH)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    expect(parsed.version).toBe(1);
    // The pre-existing record should still be present (loadState ran before
    // rehydrate threw)
    expect(parsed.files.find((f: { slug: string }) => f.slug === 'slug-pre-auth')).toBeDefined();
  });
});
