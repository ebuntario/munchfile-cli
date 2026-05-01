import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MunchFileDaemon } from '../../daemon/daemon.js';

const ALLOWED = new Set(['.md', '.markdown', '.html', '.htm']);
const EXCLUDES = new Set(['node_modules', '.git', '.DS_Store', 'dist']);

describe('MunchFileDaemon.walkDir (file/folder branching)', () => {
  let tmpDir: string;
  let daemon: MunchFileDaemon;
  // Bypass private to exercise the pure walking logic — walkDir has no `this` deps.
  let walkDir: (dir: string, recursive: boolean, allowed: Set<string>, excluded: Set<string>) => Promise<string[]>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'munchfile-walkdir-'));
    daemon = new MunchFileDaemon({ apiBaseUrl: 'http://localhost:0/v1' });
    walkDir = (daemon as unknown as {
      walkDir: typeof walkDir;
    }).walkDir.bind(daemon);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns single-element array for a file with allowed extension', async () => {
    const file = path.join(tmpDir, 'hello.md');
    fs.writeFileSync(file, '# hello');

    const result = await walkDir(file, false, ALLOWED, EXCLUDES);
    expect(result).toEqual([path.resolve(file)]);
  });

  it('returns empty array for a file with disallowed extension', async () => {
    const file = path.join(tmpDir, 'doc.docx');
    fs.writeFileSync(file, 'binary');

    const result = await walkDir(file, false, ALLOWED, EXCLUDES);
    expect(result).toEqual([]);
  });

  it('returns empty array for a missing path', async () => {
    const ghost = path.join(tmpDir, 'does-not-exist.md');
    const result = await walkDir(ghost, false, ALLOWED, EXCLUDES);
    expect(result).toEqual([]);
  });

  it('walks a directory and returns matching files (non-recursive)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'b.html'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'skip.txt'), 'skip');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'c.md'), 'c');

    const result = await walkDir(tmpDir, false, ALLOWED, EXCLUDES);
    const names = result.map(p => path.basename(p)).sort();
    expect(names).toEqual(['a.md', 'b.html']);
  });

  it('walks recursively when flag is set', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'a');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'b.md'), 'b');

    const result = await walkDir(tmpDir, true, ALLOWED, EXCLUDES);
    const names = result.map(p => path.basename(p)).sort();
    expect(names).toEqual(['a.md', 'b.md']);
  });

  it('skips excluded directories during recursive walk', async () => {
    fs.writeFileSync(path.join(tmpDir, 'keep.md'), 'k');
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'leaked.md'), 'no');

    const result = await walkDir(tmpDir, true, ALLOWED, EXCLUDES);
    const names = result.map(p => path.basename(p)).sort();
    expect(names).toEqual(['keep.md']);
  });
});
