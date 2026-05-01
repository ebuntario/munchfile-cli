/**
 * C20 smoke test — confirm CLI's apiFetch throws RateLimitError with
 * retryAfter populated when the live API server returns 429.
 *
 * Pre-req: API server running on localhost:3000, magic-link bucket
 * already exhausted for this email (or run multiple times in quick
 * succession against a clean DB).
 */
import { apiFetch, RateLimitError } from '../src/api/client.js';

async function main() {
  const email = process.env.SMOKE_EMAIL ?? `c20-${Date.now()}@example.com`;
  // Burn the per-email bucket (3/min) before the assertion call.
  for (let i = 0; i < 3; i++) {
    await fetch('http://localhost:3000/v1/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  }
  try {
    await apiFetch('/auth/magic-link', {
      method: 'POST',
      body: { email },
      baseUrl: 'http://localhost:3000/v1',
    });
    console.log('UNEXPECTED: no error thrown — bucket may have reset');
    process.exit(1);
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.log('PASS: RateLimitError thrown');
      console.log('  retryAfter:', err.retryAfter);
      console.log('  message:', err.message);
      process.exit(0);
    }
    console.log('FAIL: wrong error type:', err);
    process.exit(2);
  }
}

void main();
