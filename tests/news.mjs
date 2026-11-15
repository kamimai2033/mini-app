import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const appRoot = path.resolve(root, process.env.MINI_APP_ROOT || '.');
const artifacts = path.join(root, 'tests/.artifacts'); await mkdir(artifacts, { recursive: true });
const token = 'news-test-key-abcdefghijklmnopqrstuvwxyz0123456789';
const injection = '<img data-news-injection src=x onerror="window.newsInjected=1">';
const now = new Date().toISOString(), names = ['総合', '経済', 'IT'];
const feeds = names.map((name, index) => ({ id: `feed/${index}`, title: `${name}配信`, url: `https://fixture.example/${index}.xml`, category: name, enabled: true, last_success_at: now, last_error_at: null, error: null }));
const items = names.flatMap((name, category) => Array.from({ length: 7 }, (_, index) => ({
  id: `article/${category}/${index}`, title: `${name}記事${index}${index === 0 ? ' ' + injection : ''}`, url: `https://fixture.example/articles/${category}/${index}`,
  summary: `説明 ${index === 0 ? injection : index}`, published_at: index === 1 ? null : now, received_at: now,
  feed_id: `feed/${category}`, feed_title: `${name}配信`, categories: [name], read: false, starred: false
})));
items.push({ ...items[0], id: 'duplicate/0', feed_id: 'feed/2', feed_title: 'IT配信', categories: ['IT'] });
items.push({ ...items[1], id: 'unsafe/0', title: '安全でないリンク', url: 'javascript:alert(1)', categories: ['総合'] });
const olderSaved = [1, 2].map(index => ({ ...items[0], id: `old-saved/${index}`, title: `過去の保存記事${index}`, url: `https://fixture.example/saved/${index}`, read: true, starred: true }));
const data = { feeds, items, olderSaved, serverId: 'news-fixture-server-v1', receipts: new Map(), requests: [], mutations: [], infoMode: 'news', loseNext: false, apiOffline: false, starPages: 0 };
let staticOff = false, appOrigin, browser, context;
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain' };
const staticServer = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/mini-app\//, '/').replace(/\/$/, '/index.html');
  const file = path.resolve(appRoot, `.${pathname}`);
  if (staticOff || !file.startsWith(appRoot + path.sep)) { response.writeHead(503); response.end(); return; }
  try { const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes); }
  catch { response.writeHead(404); response.end(); }
});
const apiServer = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Access-Control-Allow-Origin', appOrigin);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  data.requests.push({ path: url.pathname, token: request.headers.authorization || '', cookie: request.headers.cookie || '' });
  const send = (body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
  if (data.apiOffline) return send({ error: { code: 'upstream_unavailable', message: 'fixture API unavailable' } }, 503);
  if (url.pathname === '/api/news/info') return send({ protocol: 1, mode: data.infoMode, server_id: data.serverId, capabilities: { feeds: true }, admin_url: 'https://fixture.example/admin' });
  if (request.headers.authorization !== `Bearer ${token}`) return send({ error: 'Unauthorized' }, 401);
  if (url.pathname === '/api/news/snapshot') {
    const saved = url.searchParams.get('view') === 'saved', next = url.searchParams.get('cursor');
    let page = data.items;
    if (saved) { data.starPages++; page = next ? data.olderSaved.slice(1) : [...data.items.filter(item => item.starred), data.olderSaved[0]]; }
    return send({ protocol: 1, server_id: data.serverId, updated_at: now, sync: { status: 'ok', last_success_at: now, error: null },
      feeds: data.feeds, items: page, pagination: { next_cursor: saved && !next ? 'saved-page-2' : null, has_more: saved && !next } });
  }
  let body;
  try { let raw = ''; for await (const chunk of request) raw += chunk; body = JSON.parse(raw); } catch { return send({ error: 'Invalid JSON' }, 400); }
  if (body.server_id !== data.serverId) return send({ error: { code: 'server_id_changed', message: 'NASの識別情報が変わりました。' } }, 409);
  if (url.pathname === '/api/news/operations') {
    data.mutations.push(structuredClone(body));
    if (!data.receipts.has(body.operation_id)) {
      for (const item of [...data.items, ...data.olderSaved]) if (body.item_ids.includes(item.id)) Object.assign(item, body.changes);
      data.receipts.set(body.operation_id, JSON.stringify(body));
    } else assert.equal(data.receipts.get(body.operation_id), JSON.stringify(body), 'Reused UUID payload must remain identical');
    if (data.loseNext) { data.loseNext = false; response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"operation_id":'); setTimeout(() => response.destroy(), 10); return; }
    return send({ operation_id: body.operation_id, status: 'applied', server_id: data.serverId });
  }
  if (url.pathname === '/api/news/feeds') {
    if (body.action === 'add') data.feeds.push({ id: `feed/${data.feeds.length}`, url: body.url, title: body.title, category: body.category, enabled: true, last_success_at: null, error: null });
    else {
      const feed = data.feeds.find(feed => feed.id === body.feed_id); if (!feed) return send({ error: 'Not found' }, 404);
      if (body.action === 'update') Object.assign(feed, { title: body.title, category: body.category });
      if (body.action === 'pause') feed.enabled = false;
      if (body.action === 'resume') feed.enabled = true;
    }
    return send({ server_id: data.serverId, status: 'applied', operation_id: body.operation_id });
  }
  if (url.pathname === '/api/news/refresh') return send({ server_id: data.serverId, sync: { status: 'ok', last_success_at: now, error: null } });
  send({ error: 'Not found' }, 404);
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(staticServer); appOrigin = `http://127.0.0.1:${staticServer.address().port}`;
await listen(apiServer); const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
const options = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (process.env.PLAYWRIGHT_SINGLE_PROCESS) options.args = ['--no-sandbox', '--single-process', '--no-zygote'];
let checks = 0; const pass = name => { checks++; console.log(`PASS: ${name}`); };
const errors = [], $ = (page, id) => page.locator(`#news-root #news-${id}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 15000; while (Date.now() < end) { if (await check()) return; await pause(25); } throw new Error('Fixture condition timed out'); }
async function open(page) {
  await page.goto(appOrigin + '/mini-app/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const toggle = page.locator('[aria-controls="life-menu"]');
  if (await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)) await toggle.hover();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('#news-link').click(); await $(page, 'status').waitFor();
}
async function settled(page) { await page.waitForFunction(() => !document.getElementById('news-root').shadowRoot.getElementById('news-status').textContent.includes('同期中')); }
async function view(page, value) { await page.locator(`#news-root [data-view="${value}"]`).click(); await settled(page); }
async function connect(page) {
  await view(page, 'settings'); await $(page, 'endpoint').fill(apiOrigin); await $(page, 'access-key').fill(token);
  await $(page, 'connect-form').locator('button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('news-root').shadowRoot.getElementById('news-status').textContent.includes('接続設定済み'));
  await settled(page);
}
async function stored(page) {
  return page.evaluate(async () => {
    const names = await indexedDB.databases(), name = names.find(item => item.name.startsWith('mini-app-news:')).name;
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const state = await new Promise((resolve, reject) => { const request = db.transaction('state').objectStore('state').get('current'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return state;
  });
}
async function queued(page) { const state = await stored(page); return state.records[state.endpoint].queue; }
try {
  browser = await chromium.launch(options); context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort('blockedbyclient'));
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage(); page.setDefaultTimeout(15000); await open(page);
  assert.equal(data.requests.length, 0); assert((await $(page, 'status').innerText()).includes('設定'));
  pass('Initial news screen requires explicit NAS connection and sends no credentials');

  data.infoMode = 'other'; await view(page, 'settings'); await $(page, 'endpoint').fill(apiOrigin); await $(page, 'access-key').fill(token);
  await $(page, 'connect-form').locator('button[type=submit]').click(); await settled(page);
  assert(data.requests.every(request => !request.token)); assert((await $(page, 'status').innerText()).includes('対応'));
  data.infoMode = 'news'; await connect(page);
  assert.equal(await page.locator('#news-root .category-column').count(), 3);
  for (const column of await page.locator('#news-root .category-column').all()) assert.equal(await column.locator('.article').count(), 5);
  await view(page, 'all');
  assert.equal(await page.locator('#news-root [data-article-id="duplicate/0"]').count(), 0);
  assert.equal(await page.locator('#news-root [data-news-injection]').count(), 0);
  assert((await $(page, 'results').innerText()).includes(injection));
  assert.equal(await page.locator('#news-root [data-article-id="unsafe/0"] a').count(), 0);
  assert((await $(page, 'results').innerText()).includes('公開日時不明'));
  pass('Protocol probe precedes credentials; balanced topics, safe text and exact-URL deduplication');

  const article = page.locator('#news-root [data-article-id="article/0/0"]');
  await article.locator('[data-action=read]').click(); await until(() => data.items.find(item => item.id === 'article/0/0').read); await settled(page);
  assert(data.items.find(item => item.id === 'article/0/0').read); assert(data.items.find(item => item.id === 'duplicate/0').read);
  assert.equal(await page.evaluate(() => document.getElementById('news-root').shadowRoot.activeElement?.dataset.action), 'read');
  await article.locator('[data-action=starred]').click(); await until(() => data.items.find(item => item.id === 'article/0/0').starred); await settled(page);
  assert(data.items.find(item => item.id === 'article/0/0').starred); assert(data.items.find(item => item.id === 'duplicate/0').starred);
  pass('Read and saved states propagate to every source ID of a duplicate article');

  await view(page, 'saved'); assert((await $(page, 'results').innerText()).includes('過去の保存記事1'));
  assert.equal(await $(page, 'more').isVisible(), true); await $(page, 'more').click(); await settled(page);
  assert((await $(page, 'results').innerText()).includes('過去の保存記事2')); assert.equal(await $(page, 'more').isVisible(), false);
  await $(page, 'search').fill('過去の保存記事2'); await until(async () => await page.locator('#news-root .article').count() === 1);
  await $(page, 'search').fill('');
  pass('Older saved articles use pagination and remain searchable without silent truncation');

  await view(page, 'settings'); await $(page, 'feed-url').fill('https://additional.example/rss.xml'); await $(page, 'feed-title').fill('追加テスト'); await $(page, 'feed-category').selectOption('IT');
  await $(page, 'feed-save').click(); await settled(page);
  const feed = page.locator('#news-root .feed').filter({ hasText: '追加テスト' });
  await feed.getByRole('button', { name: '収集を停止', exact: true }).click(); await settled(page); assert.equal(data.feeds.at(-1).enabled, false);
  await feed.getByRole('button', { name: '収集を再開', exact: true }).click(); await settled(page); assert.equal(data.feeds.at(-1).enabled, true);
  await feed.getByRole('button', { name: '編集', exact: true }).click(); await $(page, 'feed-title').fill('追加テスト更新'); await $(page, 'feed-save').click(); await settled(page);
  assert.equal(data.feeds.at(-1).title, '追加テスト更新');
  pass('Feed registration, title updates and pause/resume preserve subscriptions');

  await view(page, 'all'); data.loseNext = true;
  await page.locator('#news-root [data-article-id="article/1/0"] [data-action=read]').click();
  await until(async () => (await $(page, 'status').innerText()).includes('保持')); await settled(page);
  const pending = await queued(page); assert.equal(pending.length, 1); const lostId = pending[0].operation_id;
  await $(page, 'sync').click(); await settled(page); assert.equal((await queued(page)).length, 0);
  assert.equal(data.mutations.filter(operation => operation.operation_id === lostId).length, 2);
  assert.equal(data.receipts.has(lostId), true);
  pass('Lost acknowledgement reuses the durable operation ID and never toggles state on retry');

  await context.setOffline(true); staticOff = true;
  await page.locator('#news-root [data-article-id="article/2/1"] [data-action=starred]').click();
  await page.waitForFunction(() => document.getElementById('news-root').shadowRoot.getElementById('news-status').textContent.includes('送信待ち1件'));
  const offlineId = (await queued(page))[0].operation_id;
  await page.reload();
  const toggle = page.locator('[aria-controls="life-menu"]'); await toggle.hover(); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click(); await page.locator('#news-link').click();
  await $(page, 'status').waitFor(); assert.equal((await queued(page))[0].operation_id, offlineId);
  assert((await $(page, 'status').innerText()).includes('オフライン'));
  await view(page, 'saved'); assert((await $(page, 'results').innerText()).includes('IT記事1'));
  pass('Offline cold launch works with the static server stopped and preserves saved articles and outbox');

  staticOff = false; await context.setOffline(false); await settled(page);
  const mutationsBeforeReconnect = data.mutations.length; await pause(250); assert.equal(data.mutations.length, mutationsBeforeReconnect);
  await view(page, 'settings'); await $(page, 'endpoint').fill('https://different.example'); await $(page, 'access-key').fill(token); await $(page, 'connect-form').locator('button[type=submit]').click(); await settled(page);
  assert((await $(page, 'status').innerText()).includes('送信待ちを同期'));
  await connect(page); assert.equal((await queued(page)).length, 0); assert(data.mutations.some(operation => operation.operation_id === offlineId));
  const persistence = JSON.stringify(await stored(page)) + await page.evaluate(() => JSON.stringify(localStorage));
  assert(!persistence.includes(token)); assert(data.requests.every(request => !request.cookie));
  pass('Reload keeps keys out of storage, defers replay until reconnect and blocks endpoint changes with queued data');

  data.apiOffline = true; await $(page, 'sync').click(); await settled(page);
  assert((await $(page, 'status').innerText()).includes('保持')); assert(await page.locator('#news-root .article').count() > 0);
  data.apiOffline = false;
  pass('API outage preserves prior articles and reports stale/offline state');

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const value of ['home', 'all', 'saved', 'settings']) { await view(page, value); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${value} overflow at ${width}`); }
  }
  await view(page, 'home'); await page.screenshot({ path: path.join(artifacts, 'news-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(artifacts, 'news-mobile.png'), fullPage: true });
  pass('News and settings fit 320–1280px while retaining the existing navigation');

  const second = await context.newPage(); second.setDefaultTimeout(15000); await open(second); await view(second, 'all');
  await context.setOffline(true); await view(page, 'all');
  await Promise.all([
    page.locator('#news-root [data-article-id="article/0/3"] [data-action=read]').click(),
    second.locator('#news-root [data-article-id="article/2/3"] [data-action=starred]').click()
  ]);
  await until(async () => (await queued(page)).length === 2);
  assert.equal((await queued(second)).length, 2);
  await context.setOffline(false); await page.bringToFront(); await $(page, 'sync').click(); await settled(page);
  await until(async () => (await queued(page)).length === 0);
  assert.equal(data.items.find(item => item.id === 'article/0/3').read, true);
  assert.equal(data.items.find(item => item.id === 'article/2/3').starred, true);
  pass('Concurrent tabs retain both offline operations and synchronize through the shared lock');
  await second.close();

  data.items.find(item => item.id === 'article/0/6').read = true;
  await page.evaluate(() => {
    const now = Date.now; Date.now = () => now() + 61000;
    try { window.dispatchEvent(new Event('focus')); } finally { Date.now = now; }
  });
  await until(async () => (await page.locator('#news-root [data-article-id="article/0/6"] [data-action=read]').innerText()) === '未読に戻す');
  await settled(page);
  pass('Returning focus refreshes remote read states after the synchronization interval');

  const mutationsBeforeStale = data.mutations.length;
  await page.evaluate(async () => {
    const store = await import('/mini-app/scripts/modules/newsStore.js');
    const button = document.getElementById('news-root').shadowRoot.querySelector('[data-article-id="article/0/4"] [data-action=read]');
    window.fixtureOriginalEndpoint = (await store.readNewsState()).endpoint;
    await store.changeNewsState(state => {
      const replacement = structuredClone(state.records[state.endpoint]); replacement.server_id = 'other-account'; replacement.queue = [];
      state.endpoint = 'https://other-account.example'; state.records[state.endpoint] = replacement;
    });
    button.click();
  });
  await until(async () => (await $(page, 'status').innerText()).includes('表示後に接続先'));
  assert.equal((await queued(page)).length, 0); assert.equal(data.mutations.length, mutationsBeforeStale);
  await page.evaluate(async () => {
    const store = await import('/mini-app/scripts/modules/newsStore.js');
    await store.changeNewsState(state => { state.endpoint = window.fixtureOriginalEndpoint; delete state.records['https://other-account.example']; });
  });
  await $(page, 'sync').click(); await settled(page);
  pass('A stale article card cannot enqueue its IDs into a different endpoint or server identity');

  const limited = await context.newPage(); limited.setDefaultTimeout(15000);
  await limited.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
  await open(limited); await view(limited, 'all');
  assert(await limited.locator('#news-root .article').count() > 0);
  assert.equal(await limited.locator('#news-root [data-action=read]').first().isDisabled(), true);
  await view(limited, 'settings'); await $(limited, 'endpoint').fill(apiOrigin); await $(limited, 'access-key').fill(token);
  await $(limited, 'connect-form').locator('button[type=submit]').click(); await settled(limited);
  assert((await $(limited, 'status').innerText()).includes('新しいブラウザー'));
  await view(limited, 'all'); assert(await limited.locator('#news-root .article').count() > 0);
  await limited.close(); await page.bringToFront();
  pass('Browsers without Web Locks retain readable cached articles and disable unsafe synchronization');

  await context.setOffline(true); await view(page, 'all');
  await page.locator('#news-root [data-article-id="article/1/2"] [data-action=read]').click();
  await page.waitForFunction(() => document.getElementById('news-root').shadowRoot.getElementById('news-status').textContent.includes('送信待ち1件'));
  data.serverId = 'replacement-news-server'; const before = data.mutations.length;
  await context.setOffline(false); await settled(page);
  assert.equal(data.mutations.length, before); assert.equal((await queued(page)).length, 1);
  assert((await $(page, 'status').innerText()).includes('識別情報'));
  pass('Changed NAS identity stops queued state changes and preserves the previous account data');
  assert.deepEqual(errors, []); console.log(`${checks} news checks passed.`);
} catch (error) {
  console.error('News failure diagnostics:', JSON.stringify({ errors, requests: data.requests.slice(-10), mutations: data.mutations.length })); throw error;
} finally {
  await writeFile(path.join(artifacts, 'news-results.json'), JSON.stringify({ checks, errors }, null, 2));
  await context?.close(); await browser?.close();
  staticServer.closeAllConnections(); apiServer.closeAllConnections();
  await Promise.all([new Promise(resolve => staticServer.close(resolve)), new Promise(resolve => apiServer.close(resolve))]);
}
