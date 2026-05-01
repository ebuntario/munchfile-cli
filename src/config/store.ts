/**
 * Config store — read/write ~/.munchfile/config.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.munchfile');

export interface WatchedPath {
  id: string;
  path: string;
  visibility: 'private' | 'unlisted' | 'public';
  recursive: boolean;
  allowedExtensions: string[];
  excludePatterns: string[];
  maxFileSizeMb: number;
  createdAt: number;
}

export interface Config {
  version: number;
  apiBaseUrl: string;
  daemon: {
    debounceMs: number;
    maxRetries: number;
    baseDelayMs: number;
    maxFileSizeMb: number;
    healthCheckIntervalMs: number;
  };
  watchDefaults: {
    visibility: 'private' | 'unlisted' | 'public';
    recursive: boolean;
    allowedExtensions: string[];
    excludePatterns: string[];
  };
  paths: WatchedPath[];
}

const DEFAULT_CONFIG: Config = {
  version: 1,
  apiBaseUrl: 'https://api.munchfile.com/v1',
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
    allowedExtensions: ['.md', '.markdown', '.html', '.htm'],
    excludePatterns: ['node_modules', '.git', '.DS_Store', '__pycache__', 'dist', 'build'],
  },
  paths: [],
};

async function ensureDir() {
  await fs.promises.mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadConfig(): Promise<Config> {
  const configPath = path.join(CONFIG_DIR, 'config.json');
  try {
    const data = await fs.promises.readFile(configPath, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch {
    await ensureDir();
    await saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await ensureDir();
  const configPath = path.join(CONFIG_DIR, 'config.json');
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export interface AddWatchedPathResult {
  entry: WatchedPath;
  created: boolean;
}

export async function addWatchedPath(
  wp: Omit<WatchedPath, 'id' | 'createdAt'>
): Promise<AddWatchedPathResult> {
  const config = await loadConfig();

  const existing = config.paths.find(p => p.path === wp.path);
  if (existing) {
    return { entry: existing, created: false };
  }

  const entry: WatchedPath = {
    ...wp,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  config.paths.push(entry);
  await saveConfig(config);
  return { entry, created: true };
}

/** Remove a watched path by either its uuid or its absolute path. Returns the removed entry, or null if no match. */
export async function removeWatchedPath(idOrPath: string): Promise<WatchedPath | null> {
  const config = await loadConfig();
  const match = config.paths.find(p => p.id === idOrPath || p.path === idOrPath);
  if (!match) return null;
  config.paths = config.paths.filter(p => p.id !== match.id);
  await saveConfig(config);
  return match;
}
