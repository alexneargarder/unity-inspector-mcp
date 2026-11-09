import { readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function jsFilesUnder(root, dir) {
  const found = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...jsFilesUnder(root, file));
    else if (entry.name.endsWith('.js')) found.push(file);
  }
  return found;
}

export function serverCodeFiles(root = REPO_ROOT) {
  return ['index.js', 'wrapper.js', ...jsFilesUnder(root, 'lib')];
}

export const WRAPPER_CODE_FILES = ['wrapper.js', 'lib/instance.js', 'lib/command-line.js', 'lib/stale-code.js'];

export function changedSince(files, startMs, root = REPO_ROOT) {
  return files.filter((file) => {
    try {
      return statSync(path.join(root, file)).mtimeMs > startMs;
    } catch {
      return true;
    }
  });
}
