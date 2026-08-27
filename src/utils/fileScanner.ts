import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.dart_tool', '.next', '.cache',
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.bmp']);
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.dart', '.json', '.yaml', '.yml', '.toml',
  '.md', '.mdx', '.env', '.env.local',
  '.html', '.css', '.scss', '.less',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.sh', '.bash', '.zsh',
]);

export interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  type: 'image' | 'code';
  ext: string;
}

let fileCache: ScannedFile[] | null = null;

export function scanFiles(root: string = process.cwd()): ScannedFile[] {
  if (fileCache) return fileCache;

  const results: ScannedFile[] = [];

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const ext = extname(entry.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        results.push({
          relativePath: relative(root, fullPath),
          absolutePath: fullPath,
          type: 'image',
          ext,
        });
      } else if (CODE_EXTS.has(ext)) {
        results.push({
          relativePath: relative(root, fullPath),
          absolutePath: fullPath,
          type: 'code',
          ext,
        });
      }
    }
  }

  walk(root);
  fileCache = results;
  return results;
}

export function searchFiles(query: string, root: string = process.cwd()): ScannedFile[] {
  const files = scanFiles(root);
  const q = query.toLowerCase().replace(/^@/, '');

  if (!q) return files.slice(0, 8);

  return files
    .filter(f => f.relativePath.toLowerCase().includes(q))
    .slice(0, 8);
}

export function readFileContent(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTS.has(extname(filePath).toLowerCase());
}

export function isCodeFile(filePath: string): boolean {
  return CODE_EXTS.has(extname(filePath).toLowerCase());
}

export function invalidateCache(): void {
  fileCache = null;
}
