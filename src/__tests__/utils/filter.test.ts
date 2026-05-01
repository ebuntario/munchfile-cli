import { describe, it, expect } from 'vitest';
import { shouldUpload } from '../../utils/filter.js';

describe('shouldUpload', () => {
  it('allows .md files by default', () => {
    expect(shouldUpload('/home/user/notes.md').allowed).toBe(true);
  });

  it('allows .html files by default', () => {
    expect(shouldUpload('/home/user/index.html').allowed).toBe(true);
  });

  it('allows .htm files by default', () => {
    expect(shouldUpload('/docs/page.htm').allowed).toBe(true);
  });

  it('allows .markdown files by default', () => {
    expect(shouldUpload('/docs/readme.markdown').allowed).toBe(true);
  });

  it('rejects .js files by default', () => {
    const result = shouldUpload('/src/app.js');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.js');
  });

  it('rejects files in node_modules', () => {
    const result = shouldUpload('node_modules');
    expect(result.allowed).toBe(false);
  });

  it('rejects .DS_Store', () => {
    const result = shouldUpload('.DS_Store');
    expect(result.allowed).toBe(false);
  });

  it('allows custom extensions when specified', () => {
    const result = shouldUpload('/file.txt', { allowedExtensions: new Set(['.txt']) });
    expect(result.allowed).toBe(true);
  });
});
