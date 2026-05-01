/**
 * Utility: decide which files to upload based on extension and patterns.
 * Phase 1: Markdown and HTML only.
 */

const DEFAULT_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);
const DEFAULT_EXCLUDES = new Set([
  'node_modules', '.git', '.DS_Store', '__pycache__',
  '*.pyc', '.next', 'dist', 'build', '.cache',
]);

export interface FilterResult {
  allowed: boolean;
  reason?: string;
}

export function shouldUpload(
  filePath: string,
  options: {
    allowedExtensions?: Set<string>;
    excludedPatterns?: Set<string>;
  } = {}
): FilterResult {
  const { allowedExtensions = DEFAULT_EXTENSIONS, excludedPatterns = DEFAULT_EXCLUDES } = options;
  const filename = filePath.split('/').pop() ?? '';
  const ext = (filename.lastIndexOf('.') >= 0 ? filename.slice(filename.lastIndexOf('.')) : '').toLowerCase();

  if (allowedExtensions.size > 0 && !allowedExtensions.has(ext)) {
    return { allowed: false, reason: `extension '${ext}' not in allowlist` };
  }

  for (const pattern of excludedPatterns) {
    if (matchGlob(filename, pattern) || matchGlob(filePath, pattern)) {
      return { allowed: false, reason: `matched exclusion pattern '${pattern}'` };
    }
  }

  return { allowed: true };
}

/** Simple glob-to-regex for single patterns. Supports * and **. */
function matchGlob(str: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00DOUBLE\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00DOUBLE\x00/g, '.*')
    .replace(/^\.\//, '');

  return new RegExp(`^${regex}$`).test(str);
}
