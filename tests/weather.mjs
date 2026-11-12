import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const appRoot = path.resolve(root, process.env.MINI_APP_ROOT || '.');
const artifacts = path.join(root, 'tests/.artifacts');
await mkdir(artifacts, { recursive: true });
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
let staticOff = false;
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/mini-app\//, '/').replace(/\/$/, '/index.html');
  const target = path.resolve(appRoot, `.${pathname}`);
  if (staticOff || !target.startsWith(appRoot + path.sep)) { response.writeHead(503); response.end(); return; }
  try { response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(await readFile(target)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const options = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (process.env.PLAYWRIGHT_SINGLE_PROCESS) options.args = ['--no-sandbox', '--single-process', '--no-zygote'];
const browser = await chromium.launch(options);
const tileImage = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eef0f2"/></svg>';
const now = Math.floor(Date.now() / 300000) * 300000;
const time = milliseconds => new Date(milliseconds).toISOString().replace(/\D/g, '').slice(0, 14);
const iso = milliseconds => new Date(milliseconds).toISOString();
const frames = offsets => offsets.map(minutes => ({ basetime: time(now), validtime: time(now + minutes * 60000), elements: ['hrpns'] }));
const fixtureText = '<img data-weather-injection src=x onerror="window.weatherInjected=1">';
const rainfall = () => ({ Feature: [{ Property: { WeatherList: { Weather: [
  { Date: time(now + 9 * 3600000).slice(0, 12), Rainfall: 0, Type: 'observation' },
  { Date: time(now + 9 * 3600000 + 300000).slice(0, 12), Rainfall: 1.5, Type: 'forecast' }
] } } }] });
const rainfallXML = () => `<?xml version="1.0" encoding="UTF-8"?><YDF xmlns="http://olp.yahooapis.jp/ydf/1.0"><Feature><Property><WeatherList><Weather><Type>observation</Type><Date>${time(now + 9 * 3600000).slice(0, 12)}</Date><Rainfall>0</Rainfall></Weather><Weather><Type>forecast</Type><Date>${time(now + 9 * 3600000 + 300000).slice(0, 12)}</Date><Rainfall>2.5</Rainfall></Weather></WeatherList></Property></Feature></YDF>`;
function forecast(city) {
  return {
    publicTime: iso(now), publicTimeFormatted: 'テスト配信時刻', publishingOffice: 'テスト気象台',
    title: `予報-${city}`, link: 'https://example.com/weather', location: { area: '関東', prefecture: '東京都', district: '東京地方', city },
    description: { publicTime: iso(now), publicTimeFormatted: 'テスト配信時刻', headlineText: '', bodyText: `説明 ${fixtureText}`, text: `説明 ${fixtureText}` },
    forecasts: [0, 1, 2].map(day => ({
      date: iso(now + day * 86400000).slice(0, 10), dateLabel: ['今日', '明日', '明後日'][day], telop: `晴れ-${city} ${fixtureText}`,
      detail: { weather: `晴れ ${fixtureText}`, wind: '北の風', wave: '0.5メートル' },
      temperature: { min: { celsius: null, fahrenheit: null }, max: { celsius: day ? '20' : null, fahrenheit: null } },
      chanceOfRain: { T00_06: '--%', T06_12: '10%', T12_18: '20%', T18_24: '30%' },
      image: { title: '晴れ', url: 'https://www.jma.go.jp/bosai/forecast/img/100.svg', width: 80, height: 60 }
    })),
    copyright: { title: '天気予報 API', link: 'https://weather.tsukumijima.net/', provider: [] }
  };
}
let checks = 0;
const pass = name => { checks++; console.log(`PASS: ${name}`); };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function launch() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const state = { offline: false, forecastFail: false, radarFail: false, tileFail: false, workerFail: false, workerXML: false, workerMissing: false, heldCity: null, releaseCity: null, requests: [] };
  await context.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', { configurable: true, value(success, failure) {
      window.weatherTestLocationCalls = (window.weatherTestLocationCalls || 0) + 1;
      if (window.weatherTestLocationAllowed) success({ coords: { latitude: 35.68, longitude: 139.76, accuracy: 25 }, timestamp: Date.now() });
      else failure({ code: 1, message: 'Location permission denied by test' });
    } });
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    state.requests.push(url.href);
    if (state.offline) return route.abort('internetdisconnected');
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
    if (url.hostname === 'weather.tsukumijima.net') {
      const city = url.searchParams.get('city');
      if (state.heldCity === city) await new Promise(resolve => { state.releaseCity = resolve; });
      try { return await json(state.forecastFail ? { error: 'forecast unavailable' } : forecast(city), state.forecastFail ? 503 : 200); }
      catch (error) { if (state.heldCity !== city) throw error; return; }
    }
    if (/targetTimes_N[12]\.json$/.test(url.pathname)) return json(state.radarFail ? { error: 'radar unavailable' } : frames(url.pathname.includes('_N1') ? [-10, -5, 0] : [5, 10]), state.radarFail ? 503 : 200);
    if (/\.(png|jpg|jpeg|webp|svg)$/.test(url.pathname)) return state.tileFail ? route.abort('failed') : route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileImage });
    // Optional rainfall worker is configured by the test, never the user's service.
    if (url.hostname === 'weather-fixture.example') {
      if (state.workerFail) return json({ error: 'fixture worker unavailable' }, 503);
      if (state.workerMissing) return json({ Feature: [{ Property: { WeatherList: { Weather: [null, ...[null, ' ', -1, 0].map(Rainfall => ({ Date: time(now + 9 * 3600000).slice(0, 12), Rainfall, Type: 'observation' }))] } } }] });
      if (state.workerXML) return route.fulfill({ status: 200, contentType: 'application/json', body: rainfallXML(), headers: { 'Access-Control-Allow-Origin': '*' } });
      return json(rainfall());
    }
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, state, errors };
}
async function open(page) {
  await page.goto(origin + '/mini-app/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await weather(page);
}
async function weather(page) {
  const toggle = page.locator('.nav-toggle[aria-controls="life-menu"]');
  if (await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)) await toggle.hover();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('#weather-link').click();
  await page.waitForFunction(() => !document.getElementById('weather-section').hidden && !document.getElementById('weather-section').hasAttribute('aria-busy'));
}
async function waitForecast(page, city) { await page.waitForFunction(value => document.getElementById('weather-forecast-result').textContent.includes(`晴れ-${value}`), city); }
async function waitRadar(page) { await page.waitForFunction(() => !document.getElementById('weather-radar-slider').disabled && Number(document.getElementById('weather-radar-slider').max) > 0); }
async function settled(page, id) { await page.waitForFunction(value => !document.getElementById(value).disabled, id); }

let current;
try {
  current = await launch();
  const { page, state, errors } = current;
  await open(page);
  const cities = await page.locator('#weather-city option').evaluateAll(options => options.map(option => option.value));
  assert.equal(cities.length, 7, 'The existing seven forecast regions remain available');
  const initialCity = await page.locator('#weather-city').inputValue();
  await waitForecast(page, initialCity);
  await waitRadar(page);
  const text = await page.locator('#weather-forecast-result').innerText();
  assert(!/\b(null|undefined|NaN)\b/.test(text), 'Missing values must have a user-facing fallback');
  assert(text.includes(fixtureText), 'External weather text is displayed literally');
  assert.equal(await page.locator('#weather-forecast-result [data-weather-injection]').count(), 0);
  assert.equal(await page.evaluate(() => window.weatherInjected), undefined);
  pass('Seven regions, null forecast values and safe rendering of external text');

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#weather-reset-view').click();
    await page.waitForFunction(() => {
      const map = document.getElementById('weather-map');
      const width = Number(map.dataset.viewWidthMeters), height = Number(map.dataset.viewHeightMeters);
      return width >= 3800 && width <= 4600 && height >= 3800 && height <= 4600;
    });
    const layout = await page.locator('#weather-map').evaluate(map => ({ width: map.clientWidth, height: map.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth }));
    assert(Math.abs(layout.width - layout.height) <= 3, `Map should be square at ${width}px`);
    assert.equal(layout.overflow, false, `Weather overflows at ${width}px`);
  }
  await page.screenshot({ path: path.join(artifacts, 'weather-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#weather-reset-view').click();
  await page.screenshot({ path: path.join(artifacts, 'weather-mobile.png'), fullPage: true });
  pass('Map covering a 2 km radius and responsive 320–1280px layouts');

  const center = await page.locator('#weather-center-label').innerText();
  await page.locator('#weather-location').click();
  await page.waitForFunction(() => /許可|拒否|位置.*取得/.test(document.getElementById('weather-map-status').textContent));
  assert.equal(await page.locator('#weather-center-label').innerText(), center);
  assert.equal(await page.locator('#weather-section').isVisible(), true);
  pass('Denied geolocation keeps the selected map center usable');

  const oldRadarTime = await page.locator('#weather-radar-time').innerText();
  const slider = page.locator('#weather-radar-slider');
  await slider.evaluate(input => { input.value = input.value === input.min ? input.max : input.min; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(value => document.getElementById('weather-radar-time').textContent !== value, oldRadarTime);
  await page.locator('#weather-play').click();
  await page.locator('#home-link').click();
  const stoppedTime = await page.locator('#weather-radar-time').textContent();
  await sleep(1800);
  assert.equal(await page.locator('#weather-radar-time').textContent(), stoppedTime, 'Animation stops when leaving weather');
  await weather(page);
  pass('Radar frame selection works and playback stops on navigation');

  state.forecastFail = true;
  await page.locator('#weather-forecast-refresh').click();
  await settled(page, 'weather-forecast-refresh');
  assert((await page.locator('#weather-forecast-result').innerText()).includes(`晴れ-${initialCity}`));
  await page.locator('#weather-radar-refresh').click();
  await settled(page, 'weather-radar-refresh');
  await waitRadar(page);
  state.forecastFail = false;
  state.radarFail = true;
  await page.locator('#weather-radar-refresh').click();
  await settled(page, 'weather-radar-refresh');
  await page.locator('#weather-forecast-refresh').click();
  await settled(page, 'weather-forecast-refresh');
  await waitForecast(page, initialCity);
  assert(/失敗|取得でき|前回|接続|エラー/.test(await page.locator('#weather-radar-status').innerText()));
  state.radarFail = false;
  pass('Forecast and radar failures are isolated and previous forecast is preserved');

  await page.locator('.weather-settings > summary').click();
  await page.locator('#weather-worker-url').fill('https://weather-fixture.example/');
  await page.locator('#weather-settings-form button[type="submit"]').click();
  await page.evaluate(() => { window.weatherTestLocationAllowed = true; });
  await page.locator('#weather-location').click();
  await page.waitForFunction(() => /1[.]5/.test(document.getElementById('weather-rain-result').textContent));
  assert(state.requests.some(url => url.startsWith('https://weather-fixture.example/')), 'The configured worker is used');
  state.workerFail = true;
  await page.locator('#weather-location').click();
  await page.waitForFunction(() => /失敗|前回|取得でき|接続|エラー/.test(document.getElementById('weather-rain-status').textContent));
  assert(/1[.]5/.test(await page.locator('#weather-rain-result').innerText()), 'Failed refresh retains rainfall for the same location');
  pass('Explicit geolocation loads configured rainfall and a failed refresh preserves the last result');

  state.workerFail = false; state.workerXML = true;
  await page.locator('#weather-location').click();
  await page.waitForFunction(() => /2[.]5 mm\/h/.test(document.getElementById('weather-rain-result').textContent));
  assert.equal(await page.locator('#weather-rain-result tbody tr').count(), 2);
  assert(/実況/.test(await page.locator('#weather-rain-result').innerText()));
  pass('Worker XML with a default namespace is parsed despite its application/json header');

  state.workerMissing = true;
  await page.locator('#weather-location').click();
  await page.waitForFunction(() => document.querySelectorAll('#weather-rain-result tbody tr').length === 4);
  const amounts = await page.locator('#weather-rain-result tbody tr td:last-child').allTextContents();
  assert.deepEqual(amounts, ['不明', '不明', '不明', '0 mm/h']);
  state.workerMissing = false;
  await page.locator('#weather-location').click();
  await page.waitForFunction(() => /2[.]5 mm\/h/.test(document.getElementById('weather-rain-result').textContent));
  pass('Missing, blank and negative rainfall stay unknown while a measured zero stays zero');

  state.heldCity = cities.find(city => city !== initialCity);
  const latestCity = cities.find(city => city !== initialCity && city !== state.heldCity);
  await page.locator('#weather-city').selectOption(state.heldCity);
  for (let count = 0; !state.releaseCity && count < 100; count++) await sleep(20);
  assert(state.releaseCity, 'The first region request is pending');
  await page.locator('#weather-city').selectOption(latestCity);
  await waitForecast(page, latestCity);
  state.releaseCity();
  await sleep(300);
  assert((await page.locator('#weather-forecast-result').innerText()).includes(`晴れ-${latestCity}`));
  assert.equal(await page.locator('#weather-city').inputValue(), latestCity);
  pass('Late response from a previously selected region cannot overwrite the latest region');

  state.offline = true; staticOff = true;
  await current.context.setOffline(true);
  await page.reload(); await weather(page); await waitForecast(page, latestCity);
  assert.equal(await page.locator('#weather-city').inputValue(), latestCity);
  assert(/2[.]5/.test(await page.locator('#weather-rain-result').innerText()), 'Offline rainfall remains the actual prior observation');
  assert(/オフライン|前回|未取得|取得でき|未設定|接続/.test(await page.locator('#weather-rain-status').innerText()));
  assert.deepEqual(errors, []);
  pass('Offline cold launch retains the last forecast and never converts unavailable rainfall into no rain');

  state.offline = false; staticOff = false;
  await current.context.setOffline(false);
  state.requests = [];
  await page.reload(); await weather(page); await waitForecast(page, latestCity); await waitRadar(page);
  assert.equal(await page.evaluate(() => window.weatherTestLocationCalls || 0), 0, 'Cold launch does not ask for geolocation');
  assert(!state.requests.some(url => url.startsWith('https://weather-fixture.example/')), 'Cold launch does not send the saved location to the worker');
  assert((await page.locator('#weather-center-label').innerText()).includes('前回の現在地'));
  assert(/2[.]5/.test(await page.locator('#weather-rain-result').innerText()), 'Previous location rainfall remains readable');
  await page.evaluate(() => { window.weatherTestLocationAllowed = true; });
  await page.locator('#weather-location').click();
  await page.waitForFunction(() => document.getElementById('weather-rain-status').textContent.includes('雨量を更新しました'));
  assert(state.requests.some(url => url.startsWith('https://weather-fixture.example/')), 'A new explicit location action authorizes the worker request');
  pass('Online cold launch preserves prior location without obtaining or sending it until explicit action');
  await current.context.close(); current = null; staticOff = false;

  current = await launch();
  current.state.forecastFail = current.state.radarFail = true;
  await open(current.page);
  await settled(current.page, 'weather-forecast-refresh'); await settled(current.page, 'weather-radar-refresh');
  assert(!/雨は降っていません|降水なし|降水量[:： ]*0/.test(await current.page.locator('#weather-rain-result').innerText()));
  assert.equal(await current.page.locator('#weather-section').isVisible(), true);
  assert.deepEqual(current.errors, []);
  pass('First-use API outages leave weather controls available with no fabricated weather values');
  console.log(`${checks} weather checks passed.`);
} catch (error) {
  if (current) console.error('Weather failure diagnostics:', JSON.stringify({
    errors: current.errors,
    requests: current.state.requests.slice(-15),
    ui: await current.page.evaluate(() => Object.fromEntries(['weather-map-status', 'weather-rain-status', 'weather-rain-result', 'weather-settings-status', 'weather-center-label'].map(id => [id, document.getElementById(id)?.textContent])))
  }));
  throw error;
} finally {
  if (current?.state.releaseCity) current.state.releaseCity();
  await current?.context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
