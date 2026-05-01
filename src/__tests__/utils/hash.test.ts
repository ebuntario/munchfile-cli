import { describe, it, expect } from 'vitest';
import { hashFile } from '../../utils/hash.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

describe('hashFile', () => {
  const tmpDir = os.tmpdir();

  it('returns correct SHA-256 base64url digest', async () => {
    const content = 'hello munchfile';
    const expected = crypto.createHash('sha256').update(content).digest('base64url');
    const filePath = path.join(tmpDir, `munch-hash-test-${Date.now()}.txt`);
    fs.writeFileSync(filePath, content);

    const result = await hashFile(filePath);
    expect(result.hash).toBe(expected);
    expect(result.size).toBe(Buffer.byteLength(content));
    expect(result.mtimeMs).toBeGreaterThan(0);

    fs.unlinkSync(filePath);
  });

  it('returns size 0 and valid hash for empty file', async () => {
    const filePath = path.join(tmpDir, `munch-hash-empty-${Date.now()}.txt`);
    fs.writeFileSync(filePath, '');

    const result = await hashFile(filePath);
    expect(result.size).toBe(0);
    // SHA-256 base64url is 43 chars (32 bytes → 43 base64url chars, no padding)
    expect(result.hash).toHaveLength(43);

    fs.unlinkSync(filePath);
  });

  it('rejects for nonexistent file', async () => {
    await expect(hashFile('/nonexistent/path.txt')).rejects.toThrow();
  });
});
