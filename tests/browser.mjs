import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import '../scripts/app-config.js';
const root = new URL('../', import.meta.url).pathname;
const appRoot = path.resolve(process.env.MINI_APP_ROOT || root);
const artifacts = path.join(root, 'tests/.artifacts');
await mkdir(artifacts, { recursive: true });
const config = globalThis.MINI_APP_CONFIG;
let updateVersion = config.version, breakUpdate = false;
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain' };
const server = createServer(async (request, response) => {
  let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const update = pathname.startsWith('/update-test/');
  pathname = pathname.replace(/^\/(?:mini-app|alternate|update-test)\//, '/');
  if (pathname.endsWith('/')) pathname += 'index.html';
  const target = path.resolve(appRoot, `.${pathname}`);
  if (!target.startsWith(`${appRoot}${path.sep}`)) { response.writeHead(403); response.end(); return; }
  try {
    if (update && breakUpdate && pathname.endsWith('/scripts/modules/pdfModule.js')) throw new Error('fixture failure');
    let body = await readFile(target);
    if (update && pathname.endsWith('/scripts/app-config.js')) body = Buffer.from(body.toString().replace(`version: '${config.version}'`, `version: '${updateVersion}'`));
    response.writeHead(200, { 'Content-Type': `${types[path.extname(target)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' }); response.end(body);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const options = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (process.env.PLAYWRIGHT_SINGLE_PROCESS) options.args = ['--no-sandbox', '--single-process', '--no-zygote'];
let browser;
const passed = [];
function pass(name) { passed.push(name); console.log(`PASS: ${name}`); }
async function launch(contextOptions = {}) {
  browser = await chromium.launch(options);
  const context = await browser.newContext({ acceptDownloads: true, ...contextOptions });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  return { context, page };
}
async function open(page, mount = 'mini-app') {
  await page.goto(`${origin}/${mount}/`);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function feature(page, name) {
  const item = config.features.find(f => f[0] === name);
  const link = page.locator(`#${item[1]}`);
  const group = page.locator('.dropdown').filter({ has: link });
  if (await group.count()) {
    const toggle = group.locator(':scope > .nav-toggle');
    if (await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)) await toggle.hover();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  }
  await link.click();
  await page.waitForFunction(id => {
    const s = document.getElementById(`${id}-section`);
    return s && !s.hidden && !s.hasAttribute('aria-busy');
  }, name);
}
try {
  if (process.argv.includes('--ocr')) {
    const { context, page } = await launch();
    const assets = process.env.OCR_ASSET_DIR || path.join(root, 'tests/.ocr-assets');
    const external = [];
    await context.route('https://**/*', async route => {
      const url = route.request().url(); external.push(url);
      const asset = config.ocrAssets.find(([, source]) => source === url);
      if (!asset) return route.abort();
      await route.fulfill({ status: 200, body: await readFile(path.join(assets, asset[0])), headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': asset[0].endsWith('.js') ? 'application/javascript' : 'application/gzip' } });
    });
    await open(page); await feature(page, 'ocr');
    await page.locator('#ocr-prepare').click();
    await page.waitForFunction(() => document.getElementById('ocr-ready').textContent.includes('オフライン利用できます'), null, { timeout: 120000 });
    assert.equal(external.length, config.ocrAssets.length);
    pass('OCR assets prepared from verified, pinned upstream binaries');
    await context.setOffline(true); await page.reload(); await feature(page, 'ocr');
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 1000; c.height = 180;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, 180);
      ctx.fillStyle = '#000'; ctx.font = 'bold 58px Arial'; ctx.fillText('MINI APP OCR 12345', 35, 110);
      return c.toDataURL().split(',')[1];
    });
    await page.locator('#ocr-file').setInputFiles({ name: 'english.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.locator('#ocr-language').selectOption('eng'); await page.locator('#ocr-recognize').click();
    await page.waitForFunction(() => document.getElementById('ocr-status').textContent.includes('完了'), null, { timeout: 120000 });
    const english = await page.locator('#ocr-text').inputValue(); assert.match(english, /MINI APP OCR 12345/); console.log('English OCR:', english);
    pass('Real English OCR after offline cold reload');
    await page.locator('#ocr-file').setInputFiles(path.join(root, 'tests/fixtures/ocr-japanese.png'));
    await page.locator('#ocr-language').selectOption('jpn+eng'); await page.locator('#ocr-recognize').click();
    await page.waitForFunction(() => document.getElementById('ocr-status').textContent.includes('完了'), null, { timeout: 120000 });
    const japanese = await page.locator('#ocr-text').inputValue(); assert.match(japanese.replace(/\s/g, ''), /日本語/); console.log('Japanese OCR:', japanese);
    assert.equal(external.length, config.ocrAssets.length);
    pass('Real Japanese OCR offline with no image or text upload');
    const downloadPromise = page.waitForEvent('download'); await page.locator('#ocr-save').click();
    const download = await downloadPromise; assert.equal(download.suggestedFilename(), 'miniapp-ocr.txt');
    assert.equal(await readFile(await download.path(), 'utf8'), japanese);
    pass('OCR text export');
    await page.locator('#ocr-recognize').click(); await page.locator('#ocr-cancel').click();
    await page.waitForFunction(() => document.getElementById('ocr-status').textContent === '読み取りを中止しました。', null, { timeout: 20000 });
    assert.equal(await page.locator('#ocr-recognize').isEnabled(), true);
    pass('OCR cancellation restores controls');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(artifacts, 'ocr-mobile.png'), fullPage: true });
  } else {
    let { context, page } = await launch();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await open(page);
    await page.waitForFunction(() => document.getElementById('app-status').textContent.includes('基本機能'));
    assert(!await page.locator('#app-status').textContent().then(text => text.includes('新版')));
    for (const [id] of config.features) { await feature(page, id); assert.equal(await page.locator('main > section:visible').count(), 1, id); }
    assert.deepEqual(errors, []); pass(`All ${config.features.length} features load and navigate without page errors`);
    await feature(page, 'char-count'); await page.locator('#char-input').fill('abc日本語');
    assert.equal(await page.locator('#char-count').textContent(), '6');
    await page.locator('#changelog-link').click(); assert.equal(await page.locator('#changelog-modal').isVisible(), true);
    await page.locator('#close-changelog').click(); assert.equal(await page.locator('#char-count-section').isVisible(), true);
    pass('Changelog preserves the current screen');
    await feature(page, 'editor'); await page.locator('#html-code').fill('<p id="test">Editor works</p>');
    await page.locator('#js-code').fill("try { parent.document.body.dataset.escaped = 'yes'; } catch { document.getElementById('test').textContent = 'isolated'; }");
    await page.locator('#run-code').click(); await page.frameLocator('#output').locator('#test').waitFor();
    assert.equal(await page.frameLocator('#output').locator('#test').innerText(), 'isolated');
    assert.equal(await page.evaluate(() => document.body.dataset.escaped), undefined);
    pass('Editor runs JavaScript while preventing parent DOM access');
    await feature(page, 'mail'); await page.locator('#service-input').fill('shopping'); await page.locator('#domain-input').fill('example.com');
    await page.locator('#generate-btn').click(); assert.match(await page.locator('#generated-address').inputValue(), /^[a-z0-9]{12}shopping@example\.com$/);
    await page.locator('#domain-input').fill('example.com/path'); await page.locator('#generate-btn').click(); assert.equal(await page.locator('#generated-address').inputValue(), '');
    const uniform = await page.evaluate(async () => {
      const { generateSecureRandomString } = await import('./scripts/modules/mailGeneratorModule.js'); let byte = 0;
      const random = { getRandomValues(buffer) { for (let i = 0; i < buffer.length; i++) buffer[i] = (byte++) % 256; return buffer; } };
      return Object.values([...generateSecureRandomString(252, random)].reduce((a, c) => { a[c] = (a[c] || 0) + 1; return a; }, {}));
    });
    assert.equal(uniform.length, 36); assert(uniform.every(count => count === 7)); pass('Email validation and unbiased random alphabet');
    await feature(page, 'pdf');
    await page.locator('#pdf-fileInput').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('broken') });
    page.once('dialog', dialog => dialog.accept('test.pdf')); await page.locator('#pdf-generateBtn').click();
    await page.waitForFunction(() => document.getElementById('pdf-status').textContent.includes('生成できません'));
    assert.equal(await page.locator('#pdf-generateBtn').isEnabled(), true);
    const images = await page.evaluate(() => [ [120, 240], [240, 120] ].map(([w, h]) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.fillStyle = '#4488cc'; x.fillRect(0, 0, w, h); return c.toDataURL().split(',')[1];
    }));
    await page.locator('#pdf-fileInput').setInputFiles(images.map((buffer, i) => ({ name: `page-${i}.png`, mimeType: 'image/png', buffer: Buffer.from(buffer, 'base64') })));
    page.once('dialog', dialog => dialog.accept('mixed.pdf')); const pdfDownload = page.waitForEvent('download'); await page.locator('#pdf-generateBtn').click();
    const pdf = await pdfDownload; const bytes = await readFile(await pdf.path(), 'latin1');
    const boxes = [...bytes.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(m => [Number(m[1]), Number(m[2])]);
    assert.equal(boxes.length, 2); assert(boxes[0][0] < boxes[0][1]); assert(boxes[1][0] > boxes[1][1]);
    pass('PDF corrupt-image recovery and mixed page orientations through UI');
    await context.route('https://ja.wikipedia.org/**', route => route.fulfill({ json: { query: { pages: [{ index: 1, title: '<img src=x onerror=alert(1)>', extract: '<script>unsafe</script>' }] } } }));
    await feature(page, 'jpdictionary'); await page.locator('#query').fill('test'); await page.locator('#jpdictionary-search').click();
    await page.waitForFunction(() => document.getElementById('jpdictionary-results').textContent.includes('出典'));
    assert.equal(await page.locator('#jpdictionary-results img, #jpdictionary-results script').count(), 0);
    await context.route('https://en.wiktionary.org/**', route => route.fulfill({ status: 503, body: 'offline' }));
    await feature(page, 'dictionary'); await page.locator('#dictionary-input').fill('a&b'); await page.locator('#dictionary-search').click();
    await page.waitForFunction(() => document.getElementById('dictionary-result').textContent.includes('検索できません'));
    assert.equal(await page.locator('#dictionary-search').isEnabled(), true); pass('Dictionary plain-text rendering and retryable errors');
    for (const width of [320, 375, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [id] of config.features) {
        await feature(page, id); const size = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]);
        assert(size[1] <= size[0], `${id} overflows at ${width}: ${size[1]}`);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 }); await feature(page, 'home');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(artifacts, 'home-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'home-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await feature(page, 'char-count'); await page.locator('#char-input').evaluate(el => { el.style.height = '1500px'; });
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    const layout = await page.evaluate(() => ({ top: document.querySelector('header').getBoundingClientRect().top, footer: document.querySelector('footer').getBoundingClientRect().bottom + scrollY, document: document.documentElement.scrollHeight }));
    assert.equal(layout.top, 0); assert(Math.abs(layout.footer - layout.document) <= 1);
    pass('320–1280px layouts, sticky header, no trailing footer whitespace');
    await context.setOffline(true); await page.reload();
    for (const [id] of config.features) await feature(page, id);
    await feature(page, 'mail'); await page.locator('#service-input').fill('offline'); await page.locator('#generate-btn').click();
    assert.match(await page.locator('#generated-address').inputValue(), /offline@/); assert.deepEqual(errors, []);
    pass('All app screens available after an offline cold reload');
    await browser.close(); browser = null;
    ({ context, page } = await launch({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } }));
    await open(page);
    await page.locator('[aria-controls="study-menu"]').tap();
    await page.locator('#ocr-link').tap();
    await page.waitForFunction(() => !document.getElementById('ocr-section').hidden);
    await page.locator('[aria-controls="study-menu"]').tap();
    await page.locator('#char-count-link').tap();
    await page.waitForFunction(() => !document.getElementById('char-count-section').hasAttribute('aria-busy'));
    await page.locator('#char-input').fill('タッチ操作');
    assert.equal(await page.locator('#char-count').textContent(), '5');
    pass('Touch-only menu navigation remains usable without desktop hover');
    await browser.close(); browser = null; ({ context, page } = await launch()); await open(page, 'alternate');
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope), `${origin}/alternate/`);
    await context.setOffline(true); await page.reload(); assert.equal(await page.locator('#home-section').isVisible(), true);
    pass('Relative paths work at an alternate deployment prefix');
    await browser.close(); browser = null; ({ context, page } = await launch()); await open(page, 'update-test');
    await page.evaluate(async () => { const c = await caches.open('unrelated-app-cache'); await c.put('/unrelated.txt', new Response('keep')); });
    updateVersion = '9.9.1'; breakUpdate = true;
    const failed = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const terminal = new Promise(resolve => registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing.addEventListener('statechange', () => { if (['redundant', 'installed'].includes(installing.state)) resolve(installing.state); });
      }, { once: true }));
      await registration.update(); return terminal;
    });
    assert.equal(failed, 'redundant'); await context.setOffline(true); await page.reload();
    assert.equal(await page.locator('[data-app-version]').textContent(), `v${config.version}`);
    assert.equal(await page.evaluate(async () => (await caches.keys()).includes('unrelated-app-cache')), true);
    pass('Failed update retains the offline release and unrelated caches');
    await context.setOffline(false); breakUpdate = false; updateVersion = '9.9.2';
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const installed = new Promise(resolve => registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker.addEventListener('statechange', () => { if (worker.state === 'installed') resolve(); });
      }, { once: true }));
      await registration.update(); await installed;
    });
    assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).waiting), true);
    await page.goto(`${origin}/update-test/?from=installed-app`);
    assert.equal(await page.locator('[data-app-version]').textContent(), `v${config.version}`);
    await page.close(); const next = await context.newPage(); await next.goto(`${origin}/update-test/`);
    await next.waitForFunction(() => globalThis.MINI_APP_CONFIG?.version === '9.9.2');
    const names = await next.evaluate(() => caches.keys());
    assert(names.includes('unrelated-app-cache')); assert(!names.includes(`mini-app:/update-test/:shell-${config.version}`));
    pass('Complete update activates after app pages close; unrelated caches survive');
  }
  console.log(`\n${passed.length} checks passed.`);
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
