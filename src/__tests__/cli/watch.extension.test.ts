import { describe, it, expect } from 'vitest';
import { isAllowedExtension } from '../../cli/commands/watch.js';

const PHASE_1_ALLOWED = ['.md', '.markdown', '.html', '.htm'];

describe('isAllowedExtension (Phase-1 allowlist)', () => {
  it('accepts .md', () => {
    expect(isAllowedExtension('/x/hello.md', PHASE_1_ALLOWED)).toBe(true);
  });

  it('accepts .markdown', () => {
    expect(isAllowedExtension('/x/notes.markdown', PHASE_1_ALLOWED)).toBe(true);
  });

  it('accepts .html', () => {
    expect(isAllowedExtension('/x/page.html', PHASE_1_ALLOWED)).toBe(true);
  });

  it('accepts .htm', () => {
    expect(isAllowedExtension('/x/legacy.htm', PHASE_1_ALLOWED)).toBe(true);
  });

  it('accepts mixed-case extensions (case-insensitive)', () => {
    expect(isAllowedExtension('/x/HELLO.MD', PHASE_1_ALLOWED)).toBe(true);
    expect(isAllowedExtension('/x/Page.HTML', PHASE_1_ALLOWED)).toBe(true);
  });

  it('rejects .docx', () => {
    expect(isAllowedExtension('/x/contract.docx', PHASE_1_ALLOWED)).toBe(false);
  });

  it('rejects .txt', () => {
    expect(isAllowedExtension('/x/note.txt', PHASE_1_ALLOWED)).toBe(false);
  });

  it('rejects extensionless files (e.g. Makefile, credentials)', () => {
    expect(isAllowedExtension('/home/user/Makefile', PHASE_1_ALLOWED)).toBe(false);
    expect(isAllowedExtension('/home/user/.aws/credentials', PHASE_1_ALLOWED)).toBe(false);
  });

  it('rejects .ssh/id_rsa (the security-sensitive case)', () => {
    expect(isAllowedExtension('/home/user/.ssh/id_rsa', PHASE_1_ALLOWED)).toBe(false);
  });

  it('rejects when allowedExtensions is empty', () => {
    expect(isAllowedExtension('/x/hello.md', [])).toBe(false);
  });
});
