import fs from 'fs';
import path from 'path';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vscode']);

export function getProjectFiles(dir = process.cwd(), baseDir = process.cwd(), maxFiles = 100): string[] {
  let results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        results = results.concat(getProjectFiles(fullPath, baseDir, maxFiles));
      } else {
        results.push(relativePath);
      }
      if (results.length >= maxFiles) break;
    }
  } catch {}
  return results;
}
