import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../scripts/app-config.js';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const config = globalThis.MINI_APP_CONFIG;
const runtime = [...new Set([
  ...config.shellFiles.filter(file => file !== './').map(file => file.slice(2)),
  ...config.features.filter(feature => feature[2]).map(feature => `scripts/modules/${feature[2]}`),
  'service-worker.js'
])].sort();
const temp = await mkdtemp(path.join(tmpdir(), 'mini-app-bundle-test-'));
const build = () => execFileSync(process.execPath, ['tools/build-deploy.mjs'], { cwd: temp, encoding: 'utf8' });
async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), `${name}/`));
    else files.push(name);
  }
  return files.sort();
}
try {
  for (const file of [...runtime, 'tools/build-deploy.mjs']) {
    await mkdir(path.dirname(path.join(temp, file)), { recursive: true });
    await copyFile(path.join(sourceRoot, file), path.join(temp, file));
  }
  await writeFile(path.join(temp, 'development-only.txt'), 'Do not deploy this file.');
  build();
  assert.deepEqual(await listFiles(path.join(temp, 'dist')), runtime);
  for (const file of runtime) assert.deepEqual(await readFile(path.join(temp, 'dist', file)), await readFile(path.join(sourceRoot, file)));
  console.log('PASS: bundle includes only runtime files, with unchanged contents');

  await writeFile(path.join(temp, 'dist/obsolete.txt'), 'Remove on rebuild.');
  build(); assert.deepEqual(await listFiles(path.join(temp, 'dist')), runtime);
  console.log('PASS: rebuild removes obsolete generated files');

  await rm(path.join(temp, 'index.html'));
  const result = spawnSync(process.execPath, ['tools/build-deploy.mjs'], { cwd: temp, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(temp, 'dist/index.html'), 'utf8'), await readFile(path.join(sourceRoot, 'index.html'), 'utf8'));
  console.log('PASS: missing required files fail before replacing the previous bundle');
} finally {
  await rm(temp, { recursive: true, force: true });
}
