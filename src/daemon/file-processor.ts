/**
 * Streaming file uploader — pipes file stream to the API.
 * Uses O(64KB) memory regardless of file size.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { apiFetch, apiUpload } from '../api/client.js';

export interface UploadResult {
  url: string;
  hash: string;
  size: number;
}

export interface UploadOptions {
  apiBaseUrl: string;
  token: string;
  slug: string;
  maxSizeBytes: number;
  visibility?: 'private' | 'unlisted' | 'public';
}

const MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
};

export async function uploadFile(
  filePath: string,
  { apiBaseUrl, token, slug, maxSizeBytes, visibility }: UploadOptions
): Promise<UploadResult> {
  const stat = await fs.promises.stat(filePath);

  if (stat.size > maxSizeBytes) {
    throw new Error(
      `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${maxSizeBytes / 1024 / 1024}MB)`
    );
  }

  const hash = crypto.createHash('sha256');
  const fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

  for await (const chunk of fileStream) {
    hash.update(chunk);
  }

  const contentHash = hash.digest('base64url');
  const filename = path.basename(filePath);
  const originalContentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

  await apiFetch(`/files/${slug}`, {
    method: 'PUT',
    token,
    baseUrl: apiBaseUrl,
    body: {
      contentHash,
      sizeBytes: stat.size,
      originalPath: filePath,
      filename,
      ...(visibility ? { visibility } : {}),
    },
  });

  const binaryStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

  const uploadResult = await apiUpload(
    `/files/${slug}/content`,
    binaryStream,
    {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size),
      'X-Content-Hash': contentHash,
      'X-Content-Type': originalContentType,
    },
    token,
    apiBaseUrl,
  ) as { url: string };

  return { url: uploadResult.url, hash: contentHash, size: stat.size };
}
