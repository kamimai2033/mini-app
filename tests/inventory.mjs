import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Optional real integration run uses a separately checked-out private NAS repository.
// CI uses this public protocol fixture; server transaction tests live with the API.
const root = fileURLToPath(new URL('../', import.meta.url));
const appRoot = process.env.MINI_APP_ROOT ? path.resolve(root, process.env.MINI_APP_ROOT) : root;
const artifacts = path.join(root, 'tests/.artifacts'); await mkdir(artifacts, { recursive: true });
let blockAPI = false, staticOff = false, loseResponse = false, restoreCount = 0;
const receipts = new Map();
let snapshot = { protocol: 1, epoch: 'fixture-epoch', maintenance: null, products: [], types: [], items: [], notifications: [], revisions: {}, notification_settings: { webhook_configured: false, daily_warn_days: 7, clothing_warn_days: 15 } };
let sequence = 0;
const bodyOf = async req => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
const fixture = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Requested-With');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE');
  res.setHeader('Content-Type', 'application/json');
  const reply = (v, status = 200) => { res.statusCode = status; res.end(JSON.stringify(v)); };
  if (req.method === 'OPTIONS') return reply({});
  if (req.url === '/api/status') return reply({ maintenance: snapshot.maintenance });
  if (req.url === '/api/mobile/snapshot') return reply(snapshot);
  if (req.url === '/api/backup/list') return reply([]);
  if (req.url === '/api/backup/run') return reply({ prefix: 'test-backup' });
  if (req.url === '/api/notify/run') return reply({ delivered: [], failed: [], webhook_configured: false });
  if (req.url === '/api/mobile/commands') {
    const b = await bodyOf(req);
    if (snapshot.maintenance) return reply({ error: 'maintenance' }, 503);
    if (b.epoch !== snapshot.epoch) return reply({ error: 'restore conflict' }, 409);
    if (receipts.has(b.id)) return reply(receipts.get(b.id));
    let target = typeof b.target === 'string' && b.target.startsWith('@') ? receipts.get(b.target.slice(1)).target : b.target;
    const [kind, operation] = b.op.split('.'); const group = ['purchase', 'inventory', 'expected'].includes(kind) ? 'product' : kind === 'individual' ? 'item' : kind;
    const created = ['product.create', 'type.create', 'item.create'].includes(b.op);
    if (!created && (b.after ? receipts.get(b.after)?.revision : b.base_revision) !== snapshot.revisions[`${group}:${target}`]) return reply({ error: 'revision conflict' }, 409);
    const d = b.data;
    if (created) target = ++sequence;
    const key = `${group}:${target}`;
    if (b.op === 'product.create') snapshot.products.push({ ...d, id: target, purchases: [], expected_empty_date: null });
    if (b.op === 'product.update') Object.assign(snapshot.products.find(p => p.id === target), d);
    if (b.op === 'product.delete') snapshot.products = snapshot.products.filter(p => p.id !== target);
    if (b.op === 'purchase.create') snapshot.products.find(p => p.id === target).purchases.push({ ...d, id: ++sequence, counted: d.counted || 0 });
    if (b.op === 'inventory.update') Object.assign(snapshot.products.find(p => p.id === target), d, { last_checked_at: d.checked_at });
    if (b.op === 'type.create') snapshot.types.push({ ...d, id: target });
    if (b.op === 'item.create') snapshot.items.push({ ...d, id: target, individuals: Array.from({ length: d.quantity || 1 }, (_, n) => ({ id: ++sequence, item_id: target, individual_number: n + 1, status: 'active', due_date: '2027-01-01' })) });
    if (b.op === 'individual.update') Object.assign(snapshot.items.find(i => i.id === target).individuals.find(i => i.id === d.individual_id), d);
    snapshot.revisions[key] = `revision-${++sequence}`;
    const result = { id: b.id, group, target, created, revision: snapshot.revisions[key] };
    receipts.set(b.id, result); return reply(result);
  }
  // Simulate the legacy desktop API bypassing the mobile protocol.
  if (req.url.startsWith('/api/daily/products/') && req.method === 'PATCH') {
    const id = Number(req.url.split('/').pop()); Object.assign(snapshot.products.find(p => p.id === id), await bodyOf(req)); snapshot.revisions[`product:${id}`] = `revision-${++sequence}`; return reply({ ok: true });
  }
  if (req.url === '/api/backup/restore') { restoreCount++; snapshot.epoch = `restored-${restoreCount}`; return reply({ ok: true }); }
  reply({ error: 'unknown fixture route' }, 404);
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
let apiOrigin = `http://127.0.0.1:${fixture.address().port}`;
const types = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };
const web = createServer(async (req, res) => {
  const target = path.resolve(appRoot, '.' + new URL(req.url, 'http://localhost').pathname.replace(/^\/mini-app/, '').replace(/\/$/, '/index.html'));
  if (staticOff || !target.startsWith(appRoot + path.sep)) { res.statusCode = 503; res.end(); return; }
  try { res.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream'); res.end(await readFile(target)); }
  catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => web.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${web.address().port}`;
let backend, dataDir;
if (process.env.INVENTORY_API_SOURCE) {
  dataDir = await mkdtemp(path.join(tmpdir(), 'miniapp-api-'));
  const port = fixture.address().port; await new Promise(r => fixture.close(r));
  backend = spawn('python', ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)], { cwd: process.env.INVENTORY_API_SOURCE,
    env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: path.join(dataDir, 'backups'), ALLOWED_HOSTS: '127.0.0.1', ALLOWED_ORIGINS: origin, DISABLE_SCHEDULER: '1', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  backend.stderr.on('data', b => { if (String(b).includes('ERROR')) console.error(String(b)); });
  for (let n = 0; n < 100; n++) { try { if ((await fetch(apiOrigin + '/api/status')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
}
const options = { headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), ...(process.env.PLAYWRIGHT_SINGLE_PROCESS ? { args: ['--no-sandbox', '--single-process', '--no-zygote'] } : {}) };
const browser = await chromium.launch(options), context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
const page = await context.newPage(); page.setDefaultTimeout(12000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('dialog', dialog => dialog.accept());
const getState = () => page.evaluate(async () => (await import('./scripts/modules/inventoryStore.js')).readState());
const waitAsync = async predicate => {
  for (let n = 0; n < 240; n++) { if (await page.evaluate(predicate)) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for asynchronous application state');
};
const waitSynced = () => waitAsync(async () => !(await (await import('./scripts/modules/inventoryStore.js')).readState()).queue.length && document.getElementById('inventory-sync-status').textContent.includes('NASと同期済み'));
const tab = name => page.getByRole('button', { name, exact: true }).click();
async function open() {
  await page.goto(origin + '/mini-app/'); await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.locator('.nav-toggle[aria-controls="life-menu"]').click(); await page.locator('#inventory-link').click();
  await page.waitForFunction(() => !document.getElementById('inventory-section').hasAttribute('aria-busy'));
}
async function save(panel) { await page.locator(`#inventory-${panel}-editor`).getByRole('button', { name: '保存・送信待ちに追加' }).click(); await page.waitForFunction(panel => !document.querySelector(`#inventory-${panel}-editor form`), panel); }
async function direct(pathname, body, method = 'POST') { const r = await fetch(apiOrigin + pathname, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) }); assert(r.ok, await r.clone().text()); return r.json(); }
let checks = 0; const pass = msg => { checks++; console.log(`PASS: ${msg}`); };
try {
  await context.route(apiOrigin + '/**', async route => {
    if (blockAPI) return route.abort();
    if (loseResponse && route.request().url().endsWith('/commands')) { loseResponse = false; await route.fetch(); return route.abort(); }
    await route.continue();
  });
  await open();
  assert.equal(await page.locator('#inventory-section > h2 + .inventory-tabs').count(), 1);
  assert.equal(await page.locator('#inventory-section [aria-pressed="true"]').innerText(), '日用管理');
  await tab('共通設定'); await page.locator('#inventory-endpoint').fill(apiOrigin); await tab('接続先を保存・同期'); await waitSynced();
  pass('Configured API through actual cross-origin browser requests');
  await tab('日用管理'); await tab('商品追加');
  await page.locator('[name="name"]').fill('石鹸 <script>alert(1)</script>');
  await tab('衣類管理'); await tab('日用管理');
  assert.match(await page.locator('[name="name"]').inputValue(), /石鹸/);
  await save('daily'); await waitSynced();
  assert.equal((await getState()).snapshot.products.length, 1);
  assert.equal(await page.locator('#inventory-products script').count(), 0);
  pass('Four persistent inner screens preserve drafts and render untrusted names as text');

  blockAPI = true;
  await tab('購入追加'); await page.locator('[name="boxes"]').fill('2'); await save('daily');
  await page.waitForFunction(() => document.getElementById('inventory-sync-status').textContent.includes('NASに接続できません'));
  assert.equal((await getState()).queue.length, 1);
  staticOff = true; await page.reload();
  await page.locator('.nav-toggle[aria-controls="life-menu"]').click(); await page.locator('#inventory-link').click();
  await page.waitForFunction(() => document.getElementById('inventory-sync-status').textContent.includes('送信待ち：1件'));
  assert.match(await page.locator('#inventory-products').innerText(), /石鹸/);
  pass('Static distribution server stopped: cold launch retains snapshot and durable outbox');
  const jan = await page.evaluate(async () => {
    const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
    const R = L.map(bits => [...bits].map(b => b === '0' ? '1' : '0').join(''));
    const code = '92450127';
    const bits = '101' + [...code.slice(0,4)].map(n => L[Number(n)]).join('') + '01010' + [...code.slice(4)].map(n => R[Number(n)]).join('') + '101';
    const canvas = document.createElement('canvas'); canvas.width = (bits.length + 24) * 4; canvas.height = 160;
    const c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, canvas.width, canvas.height); c.fillStyle = '#000';
    [...bits].forEach((b, i) => { if (b === '1') c.fillRect((i + 12) * 4, 20, 4, 120); });
    const blob = await new Promise(r => canvas.toBlob(r));
    return (await import('./scripts/modules/janScanner.js')).scanImage(new File([blob], 'jan.png', { type: 'image/png' }));
  });
  assert.equal(jan, '92450127');
  pass('Bundled JAN decoder reads an actual image while static server and API are unavailable');


  blockAPI = false; loseResponse = true; await tab('今すぐ同期');
  await waitAsync(async () => (await (await import('./scripts/modules/inventoryStore.js')).readState()).queue[0]?.status === 'uncertain');
  await tab('共通設定'); assert.equal(await page.getByRole('button', { name: '待機を取消', exact: true }).count(), 0);
  await tab('今すぐ同期'); await waitSynced();
  let st = await getState(); assert.equal(st.queue.length, 0); assert.equal(st.snapshot.products[0].purchases.length, 1);
  pass('Lost acknowledgement retried with same operation ID; purchase recorded exactly once');

  await tab('日用管理'); await tab('商品編集'); await page.locator('[name="name"]').fill('スマホ変更');
  await direct(`/api/daily/products/${st.snapshot.products[0].id}`, { name: 'PC変更' }, 'PATCH');
  await save('daily'); await waitAsync(async () => (await (await import('./scripts/modules/inventoryStore.js')).readState()).queue[0]?.status === 'conflict');
  await page.waitForFunction(() => document.getElementById('inventory-sync-status').textContent.includes('同期停止'));
  assert.equal((await getState()).snapshot.products[0].name, 'PC変更');
  await tab('共通設定'); await tab('待機を取消'); await waitSynced();
  pass('Stale form cannot overwrite a desktop edit; conflict requires review');

  blockAPI = true; await tab('日用管理'); await tab('商品追加'); await page.locator('[name="name"]').fill('オフライン新規'); await save('daily');
  await page.waitForFunction(() => document.getElementById('inventory-sync-status').textContent.includes('NASに接続できません'));
  const pending = page.locator('.inventory-record').filter({ has: page.getByRole('heading', { name: 'オフライン新規（新規・送信待ち）' }) });
  await pending.getByRole('button', { name: '購入追加' }).click(); await save('daily');
  await waitAsync(async () => (await (await import('./scripts/modules/inventoryStore.js')).readState()).queue.length === 2);
  blockAPI = false; await tab('今すぐ同期'); await waitSynced();
  st = await getState(); assert.equal(st.snapshot.products.find(p => p.name === 'オフライン新規').purchases.length, 1);
  pass('Offline-created parent and dependent purchase synchronize in order');

  await tab('衣類管理'); blockAPI = true;
  await tab('種類追加'); await page.locator('[name="name"]').fill('シャツ'); await page.locator('[name="renewal_period_days"]').fill('30'); await save('clothing');
  await page.waitForFunction(() => document.getElementById('inventory-sync-status').textContent.includes('NASに接続できません'));
  await tab('衣類追加'); await page.locator('[name="name"]').fill('青シャツ'); await page.locator('[name="type_id"]').selectOption({ label: 'シャツ（送信待ち）' }); await page.locator('[name="quantity"]').fill('2'); await save('clothing');
  await page.waitForFunction(() => document.getElementById('inventory-sync-status').textContent.includes('NASに接続できません'));
  blockAPI = false; await tab('今すぐ同期'); await waitSynced();
  assert.equal((await getState()).snapshot.items[0].individuals.length, 2);
  await page.getByRole('button', { name: '期限延期', exact: true }).first().click(); await save('clothing'); await waitSynced();
  pass('Offline clothing type/item dependencies, quantity and individual postponement');

  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['日用管理', '衣類管理', '通知履歴', '共通設定']) { await tab(name); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflow at ${width}`); }
  }
  await page.setViewportSize({ width: 390, height: 844 }); await tab('日用管理'); await page.screenshot({ path: path.join(artifacts, 'inventory-mobile.png'), fullPage: true });
  pass('Populated lists and all inner screens fit 320–1280px');

  await page.locator('.inventory-record').filter({ has: page.getByRole('heading', { name: 'オフライン新規', exact: true }) }).getByRole('button', { name: '商品削除' }).click();
  await page.waitForFunction(() => document.getElementById('inventory-sync-status').textContent.includes('削除の送信確認'));
  assert.equal((await getState()).snapshot.products.length, 2);
  await tab('共通設定'); await tab('削除を送信'); await waitSynced();
  assert.equal((await getState()).snapshot.products.length, 1);
  pass('Deletion waits for explicit connected confirmation');

  const backup = await direct('/api/backup/run', {});
  blockAPI = true; await tab('日用管理'); await tab('商品編集'); await page.locator('[name="name"]').fill('古い待機'); await save('daily');
  await page.waitForFunction(() => document.getElementById('inventory-sync-status').textContent.includes('NASに接続できません'));
  await direct('/api/backup/restore', { prefix: backup.prefix });
  blockAPI = false; await tab('今すぐ同期');
  await waitAsync(async () => (await (await import('./scripts/modules/inventoryStore.js')).readState()).queue[0]?.status === 'conflict');
  assert.notEqual((await getState()).snapshot.products[0].name, '古い待機');
  pass('NAS restore invalidates stale outbox rather than replaying edits');
  assert.deepEqual(errors, []);
  console.log(`${checks} inventory checks passed (${backend ? 'real NAS API' : 'protocol fixture'}).`);
} finally {
  await browser.close(); await new Promise(r => web.close(r));
  if (backend) { backend.kill(); await new Promise(r => backend.once('exit', r)); await rm(dataDir, { recursive: true, force: true }); }
  else await new Promise(r => fixture.close(r));
}
