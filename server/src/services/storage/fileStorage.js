import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function safePath(root, key) {
  const full = path.resolve(root, key);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error('Invalid file key.');
  }
  return full;
}

export function createFileStorage(root) {
  return {
    async save(bytes, extension) {
      const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${extension}`;
      const full = safePath(root, key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, bytes);
      return key;
    },
    async read(key) {
      return fs.readFile(safePath(root, key));
    },
  };
}

export function extensionFor(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'application/pdf') return '.pdf';
  return '.jpg';
}
