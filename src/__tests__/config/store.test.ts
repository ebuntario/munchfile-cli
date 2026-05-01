import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DIR = path.join(os.tmpdir(), `.munchfile-test-${Date.now()}`);
const FAKE_HOME = TEST_DIR;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, default: { ...actual, homedir: () => FAKE_HOME } };
});

describe('config store', () => {
  beforeEach(() => {
    vi.resetModules();
    fs.rmSync(path.join(FAKE_HOME, '.munchfile'), { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('loadConfig returns defaults when no config file exists', async () => {
    const { loadConfig } = await import('../../config/store.js');
    const config = await loadConfig();
    expect(config.version).toBe(1);
    expect(config.paths).toEqual([]);
    expect(config.daemon.debounceMs).toBe(500);
  });

  it('addWatchedPath adds a new entry', async () => {
    const { addWatchedPath, loadConfig } = await import('../../config/store.js');
    const result = await addWatchedPath({
      path: '/home/user/docs',
      visibility: 'private',
      recursive: false,
      allowedExtensions: ['.md'],
      excludePatterns: [],
      maxFileSizeMb: 100,
    });

    expect(result.created).toBe(true);
    expect(result.entry.id).toBeTruthy();
    expect(result.entry.path).toBe('/home/user/docs');

    const config = await loadConfig();
    expect(config.paths).toHaveLength(1);
  });

  it('addWatchedPath returns existing entry for duplicate path', async () => {
    const { addWatchedPath } = await import('../../config/store.js');
    const first = await addWatchedPath({
      path: '/home/user/docs',
      visibility: 'private',
      recursive: false,
      allowedExtensions: ['.md'],
      excludePatterns: [],
      maxFileSizeMb: 100,
    });
    const second = await addWatchedPath({
      path: '/home/user/docs',
      visibility: 'public',
      recursive: true,
      allowedExtensions: ['.html'],
      excludePatterns: [],
      maxFileSizeMb: 50,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    // Reused entry keeps its original settings — incoming visibility is NOT applied
    expect(second.entry.visibility).toBe('private');
    expect(second.entry.recursive).toBe(false);
  });

  it('removeWatchedPath removes an entry by id', async () => {
    const { addWatchedPath, removeWatchedPath, loadConfig } = await import('../../config/store.js');
    const { entry } = await addWatchedPath({
      path: '/tmp/test',
      visibility: 'private',
      recursive: false,
      allowedExtensions: [],
      excludePatterns: [],
      maxFileSizeMb: 100,
    });

    const removed = await removeWatchedPath(entry.id);
    expect(removed).not.toBeNull();
    expect(removed?.id).toBe(entry.id);
    const config = await loadConfig();
    expect(config.paths).toHaveLength(0);
  });

  it('removeWatchedPath removes an entry by path', async () => {
    const { addWatchedPath, removeWatchedPath, loadConfig } = await import('../../config/store.js');
    await addWatchedPath({
      path: '/tmp/test-by-path',
      visibility: 'private',
      recursive: false,
      allowedExtensions: [],
      excludePatterns: [],
      maxFileSizeMb: 100,
    });

    const removed = await removeWatchedPath('/tmp/test-by-path');
    expect(removed?.path).toBe('/tmp/test-by-path');
    const config = await loadConfig();
    expect(config.paths).toHaveLength(0);
  });

  it('removeWatchedPath returns null on miss', async () => {
    const { removeWatchedPath } = await import('../../config/store.js');
    const removed = await removeWatchedPath('does-not-exist');
    expect(removed).toBeNull();
  });
});
