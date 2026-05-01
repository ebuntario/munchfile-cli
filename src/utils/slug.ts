/**
 * Utility: generate a cryptographically random URL slug.
 * 16 bytes = 128 bits of entropy → base64url → 22 chars.
 * Collision probability at 10 trillion slugs: ~10⁻²².
 */

import crypto from 'crypto';

export function generateSlug(): string {
  return crypto.randomBytes(16).toString('base64url');
}
