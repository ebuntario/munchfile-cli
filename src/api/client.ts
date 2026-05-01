import type { Readable } from 'node:stream';
import nodeFetch from 'node-fetch';
import { getSessionToken } from '../auth/session.js';

export interface ApiError {
  error: { code: string; message: string; field?: string };
}

export class AuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class RateLimitError extends Error {
  readonly status = 429;
  readonly retryAfter: number;
  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

function readRetryAfter(body: Record<string, unknown> | null): number {
  const wrapped = body?.error as { retryAfter?: unknown } | undefined;
  const v = wrapped?.retryAfter;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return 0;
}

function formatApiError(body: Record<string, unknown> | null, statusText: string, status?: number): string {
  if (!body) return `API_ERROR: ${statusText}`;
  // Custom shape: { error: { code, message } }
  const wrapped = body.error;
  if (wrapped && typeof wrapped === 'object') {
    const e = wrapped as { code?: string; message?: string; retryAfter?: number };
    if (e.code || e.message) {
      const base = `${e.code ?? 'API_ERROR'}: ${e.message ?? statusText}`;
      if (status === 429 && typeof e.retryAfter === 'number') {
        return `${base} (retry in ${e.retryAfter}s)`;
      }
      return base;
    }
  }
  // Fastify default: { code, error, message } or { statusCode, code, error, message }
  const code = (body.code as string | undefined) ?? (body.error as string | undefined) ?? 'API_ERROR';
  const message = (body.message as string | undefined) ?? statusText;
  return `${code}: ${message}`;
}

export interface RemoteFile {
  slug: string;
  filename: string;
  originalPath: string | null;
  contentHash: string | null;
  visibility: string;
  isActive: boolean;
  staleSince: string | null;
  createdAt: string;
}

export async function apiFetch(
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    baseUrl?: string;
  } = {}
): Promise<unknown> {
  const { method = 'GET', body, baseUrl = 'https://api.munchfile.com/v1' } = options;
  const token = options.token ?? await getSessionToken();

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const status = response.status;
    const errBody = await response.json().catch(() => null) as Record<string, unknown> | null;
    const message = formatApiError(errBody, response.statusText, status);
    if (status === 401) {
      throw new AuthError(message);
    }
    if (status === 429) {
      throw new RateLimitError(message, readRetryAfter(errBody));
    }
    throw new Error(message);
  }

  return response.json();
}

export async function apiUpload(
  endpoint: string,
  stream: Readable,
  headers: Record<string, string>,
  token: string,
  baseUrl: string = 'https://api.munchfile.com/v1'
): Promise<unknown> {
  const response = await nodeFetch(`${baseUrl}${endpoint}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: stream,
    duplex: 'half' as const,
  } as Parameters<typeof nodeFetch>[1]);

  if (!response.ok) {
    const status = response.status;
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const message = formatApiError(body, response.statusText, status);
    if (status === 401) {
      throw new AuthError(message);
    }
    if (status === 429) {
      throw new RateLimitError(message, readRetryAfter(body));
    }
    throw new Error(message);
  }

  return response.json();
}

export async function listFiles(token: string, baseUrl: string = 'https://api.munchfile.com/v1'): Promise<RemoteFile[]> {
  const result = await apiFetch('/files', { token, baseUrl }) as { files: RemoteFile[]; total: number };
  return result.files;
}
