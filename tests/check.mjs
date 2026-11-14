import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import '../scripts/app-config.js';
const root = new URL('../', import.meta.url);
const config = globalThis.MINI_APP_CONFIG;
const files = [...config.shellFiles, ...config.features.filter(f => f[2]).map(f => `./scripts/modules/${f[2]}`)];
assert.equal(new Set(files).size, files.length, 'No duplicate shell paths');
for (const file of files.filter(file => file !== './')) await readFile(new URL(file, root));
const html = await readFile(new URL('index.html', root), 'utf8');
for (const [id, link] of config.features) {
  assert(html.includes(`id="${id}-section"`), `Missing section ${id}`);
  assert(html.includes(`id="${link}"`), `Missing link ${link}`);
}
assert.equal(config.version, JSON.parse(await readFile(new URL('package.json', root))).version);
async function checkDirectory(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await checkDirectory(file);
    else if (/\.(m?js)$/.test(entry.name)) execFileSync(process.execPath, ['--check', file]);
  }
}
await checkDirectory(fileURLToPath(root));
console.log(`PASS: shell files, all ${config.features.length} features, version and JavaScript syntax`);
