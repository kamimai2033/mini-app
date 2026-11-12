import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../scripts/app-config.js';
const root = process.env.OCR_ASSET_DIR || fileURLToPath(new URL('./.ocr-assets/', import.meta.url));
for (const [name, url, hash] of globalThis.MINI_APP_CONFIG.ocrAssets) {
  const target = path.join(root, name);
  let bytes;
  try { bytes = await readFile(target); } catch { /* First run. */ }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== hash) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Integrity mismatch: ${name}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  console.log(`Verified ${name}: ${bytes.length} bytes`);
}
