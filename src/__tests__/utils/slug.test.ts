import { describe, it, expect } from 'vitest';
import { generateSlug } from '../../utils/slug.js';

describe('generateSlug', () => {
  it('returns a base64url string of 22 characters', () => {
    const slug = generateSlug();
    expect(slug).toHaveLength(22);
    expect(slug).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique slugs', () => {
    const slugs = new Set(Array.from({ length: 100 }, () => generateSlug()));
    expect(slugs.size).toBe(100);
  });

  it('matches the API slug regex', () => {
    const slug = generateSlug();
    expect(slug).toMatch(/^[A-Za-z0-9_-]{20,128}$/);
  });
});
