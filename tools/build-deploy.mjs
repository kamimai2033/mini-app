import { copyFile, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../scripts/app-config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = globalThis.MINI_APP_CONFIG;
const files = [...new Set([
  ...config.shellFiles.filter(file => file !== './'),
  ...config.features.filter(feature => feature[2]).map(feature => `./scripts/modules/${feature[2]}`),
  './service-worker.js'
])].sort();

// Validate every source before replacing a previous generated bundle.
for (const file of files) {
  if (!file.startsWith('./') || file.includes('\\') || file.slice(2).split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid deployment path: ${file}`);
  }
  if (!(await lstat(path.join(root, file))).isFile()) throw new Error(`Not a regular file: ${file}`);
}
const staging = await mkdtemp(path.join(root, '.deploy-build-'));
try {
  for (const file of files) {
    const target = path.join(staging, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file), target);
  }
  await rm(path.join(root, 'dist'), { recursive: true, force: true });
  await rename(staging, path.join(root, 'dist'));
} finally {
  await rm(staging, { recursive: true, force: true });
}
console.log(`Built dist/: ${files.length} runtime files for v${config.version}`);
