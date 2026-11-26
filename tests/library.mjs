// Browser test for 「本棚・図書館」 against the real Library API (kamimai2033/libre_integration)
// with fixture bibliographic sources. Requires LIBRARY_API_ROOT (path to that checkout).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const appRoot = path.resolve(root, process.env.MINI_APP_ROOT || '.');
const apiRoot = process.env.LIBRARY_API_ROOT;
if (!apiRoot) { console.log('SKIP: set LIBRARY_API_ROOT to a kamimai2033/libre_integration checkout to run the library browser test.'); process.exit(0); }
const artifacts = path.join(root, 'tests/.artifacts/library'); await mkdir(artifacts, { recursive: true });
const token = 'library-browser-key-abcdefghijklmnopqrstuvwxyz0123';
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain' };
const staticServer = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/mini-app\//, '/').replace(/\/$/, '/index.html');
  const file = path.resolve(appRoot, `.${pathname}`);
  if (!file.startsWith(appRoot + path.sep)) { response.writeHead(403); response.end(); return; }
  try { const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
const appOrigin = `http://127.0.0.1:${staticServer.address().port}`;
const dataDir = await mkdtemp(path.join(tmpdir(), 'library-api-'));
const api = spawn(process.env.LIBRARY_API_PYTHON || 'python3', [path.join(apiRoot, 'tests/serve_fixture.py'), '--origin', appOrigin, '--token', token, '--data', dataDir], { stdio: ['ignore', 'pipe', 'inherit'] });
const apiOrigin = await new Promise((resolve, reject) => {
  let buffer = '';
  api.stdout.on('data', chunk => { buffer += chunk; const match = buffer.match(/READY (\d+)/); if (match) resolve(`http://127.0.0.1:${match[1]}`); });
  api.on('exit', code => reject(new Error(`Library API exited (${code})`)));
  setTimeout(() => reject(new Error('Library API did not start')), 15000);
});
async function apiCall(pathname, body) {
  const response = await fetch(apiOrigin + pathname, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return response.json();
}
const snapshot = () => apiCall('/api/library/snapshot?since=0');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'condition') { const end = Date.now() + 20000; while (Date.now() < end) { if (await check()) return; await pause(50); } throw new Error(`Timed out waiting for ${message}`); }
const tokyoToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const shift = (days, base = tokyoToday()) => { const [y, m, d] = base.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };
const label = value => { const [y, m, d] = value.split('-').map(Number); return `${y}/${m}/${d}`; };

const options = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
let browser, checks = 0; const errors = [], coverRequests = [], cookies = [];
const pass = name => { checks++; console.log(`PASS: ${name}`); };
try {
  browser = await chromium.launch(options);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort('blockedbyclient'));
  context.on('page', page => page.on('pageerror', error => errors.push(error.stack || error.message)));
  context.on('request', request => {
    if (request.url().includes('/api/library/cover/')) coverRequests.push(request.url());
    if (request.url().startsWith(apiOrigin) && request.headers().cookie) cookies.push(request.url());
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const lib = id => page.locator(`#library-root #lib-${id}`);
  const tab = async name => { await page.locator(`#library-root [data-tab="${name}"]`).click(); await page.waitForFunction(n => !document.getElementById('library-root').shadowRoot.querySelector(`[data-panel="${n}"]`).hidden, name); };
  const settled = () => page.waitForFunction(() => !document.getElementById('library-root').shadowRoot.getElementById('lib-status').textContent.includes('同期中'));
  const status = () => lib('status').innerText();
  async function openLibrary() {
    await page.goto(`${appOrigin}/mini-app/`);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const toggle = page.locator('[aria-controls="life-menu"]');
    if (await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)) await toggle.hover();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.locator('#library-link').click(); await lib('status').waitFor();
  }
  async function connect(key = token) {
    await tab('settings'); await lib('endpoint').fill(apiOrigin); await lib('access-key').fill(key);
    await lib('connect-form').locator('button[type=submit]').click(); await settled();
  }

  await openLibrary();
  assert.equal(await page.locator('#library-root [data-tab]').count(), 4);
  assert.deepEqual(await page.locator('#library-root [data-tab]').allInnerTexts(), ['蔵書管理', '借用管理', '置場管理', '共通設定']);
  assert.equal(await page.locator('#library-link').innerText(), '本棚・図書館');
  assert((await lib('message').innerText()).includes('共通設定'));
  pass('Menu name, four 4-character screens and an explicit first connection');

  await connect('wrong-key-wrong-key-wrong-key');
  assert((await lib('message').innerText()).includes('アクセスキー'));
  await connect();
  assert((await status()).startsWith('接続中'));
  pass('Wrong key is rejected; the real API connects over Bearer without cookies');

  // Places
  await tab('places');
  for (const [name, parent] of [['部屋', ''], ['本棚A', '部屋'], ['箱3', '部屋 ＞ 本棚A']]) {
    if (parent) await lib('place-parent').selectOption({ label: parent });
    await lib('place-name').fill(name); await lib('place-form').locator('button[type=submit]').click(); await settled();
  }
  await until(async () => (await snapshot()).places.length === 3, 'three places');
  const placeIds = Object.fromEntries((await snapshot()).places.map(place => [place.name, place.id]));
  assert.equal((await snapshot()).places.find(place => place.name === '箱3').parent_id, placeIds['本棚A']);
  assert((await lib('place-tree').innerText()).includes('箱3（0冊）'));
  pass('Nested places are created and shown as a tree');

  // Register by ISBN with presets
  await tab('copies'); await lib('copy-register').click();
  const sheet = lib('copy-register-area');
  await sheet.getByLabel('置き場所').selectOption({ label: '部屋 ＞ 本棚A' });
  await sheet.getByLabel('ISBNを入力').fill('1920193004009'); await sheet.locator('form.isbn-form button[type=submit]').click();
  assert((await sheet.locator('.scan-status').innerText()).includes('ISBNを確認'));
  await sheet.getByLabel('ISBNを入力').fill('4-10-101013-7'); await sheet.locator('form.isbn-form button[type=submit]').click();
  await sheet.locator('.row h5').filter({ hasText: 'こころ' }).waitFor();
  assert((await sheet.locator('.row').innerText()).includes('夏目 漱石'));
  await sheet.getByLabel('ISBNを入力').fill('9784101010137'); await sheet.locator('form.isbn-form button[type=submit]').click();
  assert.equal(await sheet.locator('.row').count(), 1, 'the same ISBN is not listed twice');
  await sheet.getByRole('button', { name: 'まとめて登録（1件）' }).click(); await settled();
  await until(async () => (await snapshot()).copies.length === 1, 'first copy');
  let snap = await snapshot();
  assert.equal(snap.copies[0].place_id, placeIds['本棚A']); assert.equal(snap.bibs[0].title, 'こころ'); assert.equal(snap.bibs[0].ndl_id, '000007312345');
  pass('ISBN entry rejects the lower 192 barcode, looks up NDL and registers with the chosen place');

  // Title search for doujinshi without ISBN, new series, volumes
  await lib('copy-register').click();
  await sheet.getByLabel('シリーズ').selectOption('__new'); await sheet.getByLabel('新しいシリーズ名').fill('夏の合同誌');
  await sheet.getByLabel('置き場所').selectOption({ label: '部屋 ＞ 本棚A ＞ 箱3' });
  await sheet.locator('summary', { hasText: '書名で検索' }).click();
  await sheet.locator('.search-form').getByLabel('書名').fill('夏の合同誌'); await sheet.locator('.search-form button[type=submit]').click();
  await until(async () => await sheet.locator('.candidate').count() === 2, 'two candidates');
  for (const button of await sheet.locator('.candidate button').all()) await button.click();
  await until(async () => await sheet.locator('.row').count() === 2, 'two rows');
  assert.deepEqual(await sheet.getByLabel('巻表記').evaluateAll(inputs => inputs.map(input => input.value)), ['2', '1']);
  await sheet.locator('.search-form').getByLabel('書名').fill('夏の合同誌 総集編'); await sheet.getByRole('button', { name: '書名だけで追加' }).click();
  await sheet.getByLabel('巻表記').nth(2).fill('総集');
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await settled();
  await page.keyboard.type('編');
  assert.equal(await sheet.getByLabel('巻表記').nth(2).inputValue(), '総集編', 'a background sync does not replace the field being typed in');
  await page.setViewportSize({ width: 390, height: 844 }); await sheet.screenshot({ path: path.join(artifacts, 'register-390.png') }); await page.setViewportSize({ width: 1280, height: 900 });
  await sheet.getByRole('button', { name: 'まとめて登録（3件）' }).click(); await settled();
  await until(async () => (await snapshot()).copies.length === 4, 'doujinshi copies');
  snap = await snapshot();
  assert.equal(snap.series.length, 1);
  assert.equal(snap.copies.filter(copy => copy.series_id === snap.series[0].id).length, 3);
  assert(snap.bibs.some(bib => bib.ndl_id === 'R100000002-I031234567' && bib.isbn13 === null));
  const group = page.locator('#library-root [data-series-id]').filter({ hasText: '夏の合同誌（3冊）' });
  await group.waitFor();
  const volumes = await group.locator('.book h5').allInnerTexts();
  assert.deepEqual(volumes, ['夏の合同誌　1', '夏の合同誌　2', '夏の合同誌 総集編'], 'volumes in order; a title ending with its label is not repeated');
  assert((await group.innerText()).includes('月見サークル ／ 2023/8') && !(await group.innerText()).includes('月見サークル ／ 月見サークル'));
  pass('Title search (NDL book ID without ISBN), new series, volume hints and series grouping');

  // Duplicate warning
  await lib('copy-register').click();
  await sheet.getByLabel('ISBNを入力').fill('9784101010137'); await sheet.locator('form.isbn-form button[type=submit]').click();
  await until(async () => (await sheet.locator('.row .warning').count()) > 0, 'duplicate warning');
  assert((await sheet.locator('.row .warning').innerText()).includes('既に蔵書にあります（ISBN一致・部屋 ＞ 本棚A）'));
  await sheet.getByRole('button', { name: '一覧から外す' }).click(); await sheet.getByRole('button', { name: '閉じる' }).click();
  pass('Registering an owned ISBN warns with its place');

  // Edit, bib override, conflict
  const kokoro = page.locator('#library-root [data-copy-id]').filter({ hasText: 'こころ' });
  await kokoro.locator('[data-action=edit]').click();
  const editor = lib('copy-editor');
  await editor.getByLabel('読書状態').selectOption('done'); await editor.getByLabel('書名', { exact: true }).fill('こころ（新潮文庫）');
  await editor.getByRole('button', { name: '保存' }).click(); await settled();
  await until(async () => (await snapshot()).copies.find(copy => copy.place_id === placeIds['本棚A'])?.reading === 'done', 'reading saved');
  snap = await snapshot();
  const kokoroBib = snap.bibs.find(bib => bib.isbn13 === '9784101010137');
  assert.equal(kokoroBib.title, 'こころ（新潮文庫）'); assert.deepEqual(kokoroBib.overridden, ['title']);
  const kokoroCopy = snap.copies.find(copy => copy.bib_id === kokoroBib.id);
  await kokoro.locator('[data-action=edit]').click();
  await apiCall('/api/library/commands', { server_id: snap.copies.length && (await apiCall('/api/library/info')).server_id, operations: [{ operation_id: crypto.randomUUID(), op: 'copy.update', data: { id: kokoroCopy.id, note: '他の端末で追記' }, base_revision: kokoroCopy.revision }] });
  await editor.getByLabel('メモ').fill('この端末のメモ'); await editor.getByRole('button', { name: '保存' }).click(); await settled();
  await until(async () => (await status()).includes('要確認1件'), 'conflict reported');
  assert.equal((await snapshot()).copies.find(copy => copy.id === kokoroCopy.id).note, '他の端末で追記', 'a stale edit never overwrites silently');
  await tab('settings');
  assert((await lib('queue').innerText()).includes('競合'));
  await lib('queue').getByRole('button', { name: '自分の変更で上書き' }).click(); await settled();
  await until(async () => (await snapshot()).copies.find(copy => copy.id === kokoroCopy.id).note === 'この端末のメモ', 'override applied');
  pass('Edits and bibliographic overrides sync; a stale edit becomes a conflict that the user resolves explicitly');

  // Loans while the NAS is unreachable
  await tab('loans'); await lib('loan-register').click();
  const loanSheet = lib('loan-register-area');
  await context.route(`${apiOrigin}/**`, route => route.abort('connectionrefused'));
  await loanSheet.getByLabel('借りた先').fill('市立図書館');
  await loanSheet.getByLabel('ISBNを入力').fill('9784088725093'); await loanSheet.locator('form.isbn-form button[type=submit]').click();
  await until(async () => (await loanSheet.locator('.row').innerText()).includes('書誌未取得'), 'offline row');
  assert((await loanSheet.locator('.due-preview').innerText()).includes(label(shift(14))));
  await loanSheet.getByRole('button', { name: 'まとめて登録（1件）' }).click(); await settled();
  await until(async () => (await status()).includes('送信待ち1件'), 'queued loan');
  const pendingCard = lib('loan-list').locator('[data-loan-id]');
  assert((await pendingCard.innerText()).includes('送信待ち'));
  await context.unroute(`${apiOrigin}/**`);
  await lib('sync').click(); await settled();
  await until(async () => (await snapshot()).loans.length === 1, 'loan sent');
  await until(async () => (await snapshot()).bibs.some(bib => bib.isbn13 === '9784088725093' && bib.title === 'ワンピース 1'), 'NAS fills the bibliographic record');
  await lib('sync').click(); await settled();
  await until(async () => (await lib('loan-list').innerText()).includes('ワンピース 1'), 'filled title shown');
  assert((await lib('loan-list').innerText()).includes(`返却期限 ${label(shift(14))}（あと14日）`));
  pass('A loan scanned while the NAS is unreachable is queued, sent later and its title filled by the NAS');

  // Overdue, return, reopen, renew
  await lib('loan-register').click();
  await loanSheet.getByLabel('借りた日').fill(shift(-30)); await loanSheet.getByLabel('貸出期間').selectOption('custom');
  await loanSheet.getByLabel('返却期限').fill(shift(-16));
  await loanSheet.locator('summary', { hasText: '書名で検索' }).click();
  await loanSheet.locator('.search-form').getByLabel('書名').fill('期限切れテスト'); await loanSheet.getByRole('button', { name: '書名だけで追加' }).click();
  await loanSheet.getByRole('button', { name: 'まとめて登録（1件）' }).click(); await settled();
  const overdue = lib('loan-list').locator('[data-loan-id]').filter({ hasText: '期限切れテスト' });
  await overdue.waitFor();
  assert.equal(await overdue.evaluate(node => node.classList.contains('due-overdue')), true);
  assert((await overdue.innerText()).includes('16日超過'));
  assert.equal(await lib('loan-list').locator('[data-loan-id]').first().innerText().then(text => text.includes('期限切れテスト')), true, 'overdue loans sort first');
  await overdue.locator('[data-action=return]').click(); await settled();
  await until(async () => (await snapshot()).loans.find(loan => loan.lender === '市立図書館' && loan.borrowed_on === shift(-30))?.returned_on === tokyoToday(), 'returned');
  assert.equal(await lib('loan-list').locator('[data-loan-id]').filter({ hasText: '期限切れテスト' }).count(), 0);
  await lib('loan-returned').check();
  await lib('loan-list').locator('[data-loan-id]').filter({ hasText: '返却済み' }).locator('[data-action=reopen]').click(); await settled();
  await until(async () => (await snapshot()).loans.every(loan => !loan.returned_on), 'reopened');
  await lib('loan-returned').uncheck();
  await lib('loan-list').locator('[data-loan-id]').filter({ hasText: 'ワンピース' }).locator('[data-action=renew]').click();
  await lib('loan-editor').getByRole('button', { name: '延長する' }).click(); await settled();
  await until(async () => (await snapshot()).loans.find(loan => loan.borrowed_on === tokyoToday())?.renewals === 1, 'renewed');
  pass('Overdue loans are highlighted and sorted first; return, undo and renewal sync');

  // Bulk move, merge, delete guard
  await tab('places');
  await lib('move-source').selectOption({ label: '部屋 ＞ 本棚A' });
  await lib('move-list').getByLabel(/こころ/).check(); await lib('move-target').selectOption({ label: '部屋 ＞ 本棚A ＞ 箱3' });
  await lib('move-form').locator('button[type=submit]').click(); await settled();
  await until(async () => (await snapshot()).copies.find(copy => copy.id === kokoroCopy.id).place_id === placeIds['箱3'], 'moved to box');
  const boxRow = lib('place-tree').locator(`[data-place-id="${placeIds['箱3']}"] > .place-row`);
  assert((await boxRow.innerText()).includes('箱3（4冊）'));
  await boxRow.getByRole('button', { name: '統合' }).click();
  await lib('place-editor').getByLabel('統合先').selectOption({ label: '部屋 ＞ 本棚A' });
  await lib('place-editor').getByRole('button', { name: '統合する' }).click(); await settled();
  await until(async () => (await snapshot()).places.length === 2, 'merged');
  assert((await snapshot()).copies.every(copy => copy.place_id === placeIds['本棚A']));
  await lib('place-tree').locator(`[data-place-id="${placeIds['本棚A']}"] > .place-row`).getByRole('button', { name: '削除' }).click();
  assert((await lib('place-editor').innerText()).includes('削除できません'));
  pass('Bulk move, merging a box into a shelf and refusing to delete a non-empty place');

  // Dispose and the disposed duplicate warning
  await tab('copies'); await lib('copy-place').selectOption('');
  await page.locator('#library-root [data-copy-id]').filter({ hasText: 'こころ' }).locator('[data-action=edit]').click();
  await editor.getByLabel('手放し方').selectOption('sold'); await editor.getByRole('button', { name: '手放す' }).click(); await settled();
  await until(async () => (await snapshot()).copies.find(copy => copy.id === kokoroCopy.id).disposition === 'sold', 'disposed');
  assert.equal(await page.locator('#library-root [data-copy-id]').filter({ hasText: 'こころ' }).count(), 0);
  await lib('copy-disposed').check();
  assert((await page.locator('#library-root [data-copy-id]').filter({ hasText: 'こころ' }).innerText()).includes('売却'));
  await lib('copy-disposed').uncheck();
  await lib('copy-register').click();
  await sheet.getByLabel('ISBNを入力').fill('9784101010137'); await sheet.locator('form.isbn-form button[type=submit]').click();
  await until(async () => (await sheet.locator('.row .warning').count()) > 0, 'disposed warning');
  assert((await sheet.locator('.row .warning').innerText()).includes('以前手放した本です'));
  await sheet.getByRole('button', { name: '閉じる' }).click();
  pass('Disposed books leave the list, stay searchable and still warn against buying again');

  // Covers: off by default, loaded only when enabled and visible
  await tab('loans');
  assert.equal(coverRequests.length, 0); assert.equal(await lib('loan-list').locator('.cover').count(), 0);
  await tab('settings'); await lib('covers').check(); await tab('loans');
  await lib('loan-list').locator('.cover img').first().waitFor();
  const loaded = coverRequests.length; assert(loaded >= 1);
  await tab('settings'); await lib('covers').uncheck(); await tab('loans');
  assert.equal(await lib('loan-list').locator('.cover').count(), 0); assert.equal(coverRequests.length, loaded);
  pass('Covers are off by default and are requested only while the bulk switch is on');

  // Layout at narrow widths
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['copies', 'loans', 'places', 'settings']) {
      await tab(name);
      const size = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]);
      assert(size[1] <= size[0], `${name} overflows at ${width}: ${size[1]}`);
    }
  }
  await tab('copies'); await page.screenshot({ path: path.join(artifacts, 'copies-390.png'), fullPage: true });
  await tab('loans'); await page.screenshot({ path: path.join(artifacts, 'loans-390.png'), fullPage: true });
  await tab('places'); await page.screenshot({ path: path.join(artifacts, 'places-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  pass('All four screens fit 320px and 390px without horizontal overflow');

  // Offline cold start: data stays readable, registration is queued, the key is not stored
  await context.setOffline(true); await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const toggle = page.locator('[aria-controls="life-menu"]');
  await toggle.hover(); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('#library-link').click(); await lib('status').waitFor(); await tab('copies');
  assert((await status()).startsWith('オフライン'));
  assert((await lib('copy-list').innerText()).includes('夏の合同誌'));
  await lib('copy-register').click();
  await sheet.locator('summary', { hasText: '書名で検索' }).click();
  assert.equal(await sheet.locator('.row').count(), 1, 'the unregistered row survived the reload as a draft');
  await sheet.getByRole('button', { name: '一覧から外す' }).click();
  await sheet.locator('.search-form').getByLabel('書名').fill('オフライン登録'); await sheet.getByRole('button', { name: '書名だけで追加' }).click();
  await sheet.getByRole('button', { name: 'まとめて登録（1件）' }).click();
  await until(async () => (await status()).includes('送信待ち1件'), 'offline queue');
  const stored = await page.evaluate(async () => {
    const names = await indexedDB.databases(), name = names.find(item => item.name.startsWith('mini-app-library:')).name;
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const value = await new Promise(resolve => { const request = db.transaction('state').objectStore('state').get('current'); request.onsuccess = () => resolve(request.result); });
    db.close(); return JSON.stringify(value) + JSON.stringify({ ...localStorage });
  });
  assert(!stored.includes(token), 'the access key is never persisted');
  await context.setOffline(false);
  await connect();
  await until(async () => (await snapshot()).bibs.some(bib => bib.title === 'オフライン登録'), 'offline registration sent');
  assert.deepEqual(cookies, []);
  assert.deepEqual(errors, []);
  pass('Offline cold start keeps data and drafts, queues registrations, never stores the key and sends after reconnecting');
  console.log(`\n${checks} checks passed.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  api.kill();
  staticServer.close();
}
