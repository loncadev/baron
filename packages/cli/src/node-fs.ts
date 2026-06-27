import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { FileSystem } from './ports.js';

/** The real, Node-backed {@link FileSystem}. Kept dependency-free; UTF-8 throughout. */
export const nodeFileSystem: FileSystem = {
  read(path) {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  },
  write(path, content) {
    writeFileSync(path, content, 'utf8');
  },
  exists(path) {
    return existsSync(path);
  },
  mkdirp(path) {
    mkdirSync(path, { recursive: true });
  },
};
