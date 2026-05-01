import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkOverlap } from '../../cli/commands/watch.js';
import type { Config, WatchedPath } from '../../config/store.js';

function makeConfig(paths: WatchedPath[]): Config {
  return {
    version: 1,
    apiBaseUrl: 'http://localhost:0/v1',
    daemon: { debounceMs: 500, maxRetries: 3, baseDelayMs: 1000, maxFileSizeMb: 100, healthCheckIntervalMs: 30000 },
    watchDefaults: {
      visibility: 'private',
      recursive: false,
      allowedExtensions: ['.md', '.markdown', '.html', '.htm'],
      excludePatterns: [],
    },
    paths,
  };
}

function makePath(absPath: string): WatchedPath {
  return {
    id: 'test-id',
    path: absPath,
    visibility: 'private',
    recursive: false,
    allowedExtensions: ['.md'],
    excludePatterns: [],
    maxFileSizeMb: 100,
    createdAt: Date.now(),
  };
}

describe('checkOverlap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'munchfile-overlap-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok when config is empty', async () => {
    const config = makeConfig([]);
    const result = await checkOverlap(path.join(tmpDir, 'hello.md'), 'file', config);
    expect(result.ok).toBe(true);
  });

  it('rejects file under an existing watched folder (covered_by)', async () => {
    const folder = path.join(tmpDir, 'notes');
    fs.mkdirSync(folder);
    const file = path.join(folder, 'hello.md');
    fs.writeFileSync(file, 'x');

    const config = makeConfig([makePath(folder)]);
    const result = await checkOverlap(file, 'file', config);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('covered_by');
      expect(result.conflict.path).toBe(folder);
    }
  });

  it('rejects folder that would cover an existing watched file (covers)', async () => {
    const folder = path.join(tmpDir, 'notes');
    fs.mkdirSync(folder);
    const file = path.join(folder, 'hello.md');
    fs.writeFileSync(file, 'x');

    const config = makeConfig([makePath(file)]);
    const result = await checkOverlap(folder, 'directory', config);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('covers');
      expect(result.conflict.path).toBe(file);
    }
  });

  it('does NOT trigger overlap for sibling paths with shared prefix', async () => {
    const a = path.join(tmpDir, 'notes-a');
    const b = path.join(tmpDir, 'notes-b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);

    const config = makeConfig([makePath(a)]);
    const result = await checkOverlap(b, 'directory', config);
    expect(result.ok).toBe(true);
  });

  it('skips exact-match (defers to addWatchedPath "Already watching")', async () => {
    const file = path.join(tmpDir, 'hello.md');
    fs.writeFileSync(file, 'x');

    const config = makeConfig([makePath(file)]);
    const result = await checkOverlap(file, 'file', config);
    expect(result.ok).toBe(true);
  });

  it('skips stale config entries whose paths no longer exist', async () => {
    const ghost = path.join(tmpDir, 'deleted-folder');
    const config = makeConfig([makePath(ghost)]);

    const newFile = path.join(tmpDir, 'fresh.md');
    fs.writeFileSync(newFile, 'x');

    const result = await checkOverlap(newFile, 'file', config);
    expect(result.ok).toBe(true);
  });

  it('does NOT report covered_by when existing entry is a file (not a folder)', async () => {
    const otherFile = path.join(tmpDir, 'other.md');
    fs.writeFileSync(otherFile, 'x');

    const newFile = path.join(tmpDir, 'new.md');
    fs.writeFileSync(newFile, 'y');

    const config = makeConfig([makePath(otherFile)]);
    const result = await checkOverlap(newFile, 'file', config);
    // Two unrelated files in the same parent — no overlap.
    expect(result.ok).toBe(true);
  });

  it('handles trailing slash and `..` segments via path.resolve', async () => {
    const folder = path.join(tmpDir, 'notes');
    fs.mkdirSync(folder);
    const file = path.join(folder, 'hello.md');
    fs.writeFileSync(file, 'x');

    // Stored path with trailing slash; target path with `..` segment.
    const config = makeConfig([makePath(folder + '/')]);
    const target = path.join(folder, '..', 'notes', 'hello.md');
    const result = await checkOverlap(target, 'file', config);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('covered_by');
  });
});
