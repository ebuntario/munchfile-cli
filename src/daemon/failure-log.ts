/**
 * Failure log — records non-auth upload failures to ~/.munchfile/failures.json
 * so they show up in `munchfile status` instead of being lost.
 *
 * Security:
 *  - Sanitizes Bearer tokens, URL query strings, and stack traces before writing.
 *  - File mode 0600 (mirrors session.json).
 *  - Atomic writes via tmp+rename, serialized through a module-level promise chain.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.munchfile');
const FAILURES_PATH = path.join(CONFIG_DIR, 'failures.json');
const TMP_PATH = path.join(CONFIG_DIR, 'failures.json.tmp');
const MAX_ENTRIES = 100;
const MAX_ERROR_LEN = 500;

export interface FailureEntry {
  filePath: string;
  error: string;
  attempts: number;
  timestamp: number;
}

let writeChain: Promise<void> = Promise.resolve();

function sanitize(error: string): string {
  let safe = error
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/\?[^\s]*/g, '?[REDACTED]')
    .split('\n')[0]; // strip stack traces — keep only first line

  if (safe.length > MAX_ERROR_LEN) {
    safe = safe.slice(0, MAX_ERROR_LEN) + '…';
  }
  return safe;
}

async function ensureDir(): Promise<void> {
  await fs.promises.mkdir(CONFIG_DIR, { recursive: true });
}

async function readRaw(): Promise<FailureEntry[]> {
  try {
    const data = await fs.promises.readFile(FAILURES_PATH, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAtomic(entries: FailureEntry[]): Promise<void> {
  await ensureDir();
  await fs.promises.writeFile(TMP_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 });
  await fs.promises.chmod(TMP_PATH, 0o600);
  await fs.promises.rename(TMP_PATH, FAILURES_PATH);
  await fs.promises.chmod(FAILURES_PATH, 0o600).catch(() => {});
}

export function recordFailure(input: { filePath: string; error: string | Error; attempts: number }): Promise<void> {
  const errMsg = input.error instanceof Error ? input.error.message : String(input.error);
  const entry: FailureEntry = {
    filePath: input.filePath,
    error: sanitize(errMsg),
    attempts: input.attempts,
    timestamp: Date.now(),
  };

  writeChain = writeChain.then(async () => {
    const existing = await readRaw();
    const filtered = existing.filter(e => e.filePath !== entry.filePath);
    filtered.push(entry);
    const trimmed = filtered.slice(-MAX_ENTRIES);
    await writeAtomic(trimmed);
  }).catch(err => {
    console.warn(`failure-log: could not write failure record: ${err}`);
  });

  return writeChain;
}

export async function readFailures(): Promise<FailureEntry[]> {
  return readRaw();
}

export function clearFailures(): Promise<number> {
  let cleared = 0;
  writeChain = writeChain.then(async () => {
    const existing = await readRaw();
    cleared = existing.length;
    await writeAtomic([]);
  }).catch(err => {
    console.warn(`failure-log: could not clear failures: ${err}`);
  });
  return writeChain.then(() => cleared);
}
