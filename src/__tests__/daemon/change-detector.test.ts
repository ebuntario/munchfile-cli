import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChangeDetector } from '../../daemon/change-detector.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('ChangeDetector', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `munch-cd-test-${Date.now()}.txt`);
    fs.writeFileSync(filePath, 'initial content');
  });

  afterEach(() => {
    try { fs.unlinkSync(filePath); } catch { /* may already be removed */ }
  });

  it('returns hash on first change', async () => {
    const detector = new ChangeDetector(filePath, 10);
    const result = await detector.onFileChange();
    expect(result.type).toBe('change');
    expect(result.hash).toBeTruthy();
    expect(result.filePath).toBe(filePath);
  });

  it('returns no hash when content unchanged', async () => {
    const detector = new ChangeDetector(filePath, 10);
    await detector.onFileChange();
    const result = await detector.onFileChange();
    expect(result.type).toBe('change');
    expect(result.hash).toBeUndefined();
  });

  it('returns hash when content actually changes', async () => {
    const detector = new ChangeDetector(filePath, 10);
    await detector.onFileChange();
    fs.writeFileSync(filePath, 'updated content');
    const result = await detector.onFileChange();
    expect(result.hash).toBeTruthy();
  });

  it('signalUnlink resolves pending changes', async () => {
    const detector = new ChangeDetector(filePath, 5000);
    const promise = detector.onFileChange();
    detector.signalUnlink();
    const result = await promise;
    expect(result.type).toBe('unlink');
  });
});
