/**
 * Utility: streaming SHA-256 hash of a file.
 * Memory usage: O(64KB) regardless of file size.
 *
 * Returns hash as base64url (URL-safe SHA-256 digest, no padding) so it
 * can compare directly against the server's stored contentHash without
 * format conversion.
 */

import crypto from 'crypto';
import fs from 'fs';

export interface FileHash {
  hash: string;
  size: number;
  mtimeMs: number;
}

export async function hashFile(filePath: string): Promise<FileHash> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    let size = 0;

    stream.on('data', (chunk: Buffer | string) => {
      hash.update(chunk);
      size += chunk.length;
    });

    stream.on('end', () => {
      const stat = fs.statSync(filePath);
      resolve({
        hash: hash.digest('base64url'),
        size,
        mtimeMs: stat.mtimeMs,
      });
    });

    stream.on('error', reject);
  });
}
