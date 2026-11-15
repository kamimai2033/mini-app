import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Synthetic API and an isolated browser profile. No user profile, NAS or Google calls.
const root = fileURLToPath(new URL('../', import.meta.url));
const appRoot = process.env.MINI_APP_ROOT ? path.resolve(root, process.env.MINI_APP_ROOT) : root;
const backend = process.env.LEDGER_TEST_ROOT;
if (!backend) throw new Error('Set LEDGER_TEST_ROOT to the household-ledger checkout.');
const runtime = path.join(root, '.test-runtime'); await mkdir(runtime, { recursive: true });
const artifacts = await mkdtemp(path.join(runtime, 'ledger-'));
const token = 'browser-test-only-' + 'x'.repeat(48), origin = 'http://127.0.0.1:18083', apiOrigin = 'http://127.0.0.1:18084';
const python = process.env.LEDGER_TEST_PYTHON || path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const apiProcess = spawn(python, ['tests/mobile_ui_server.py'], { cwd: backend, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let apiErrors = ''; apiProcess.stderr.on('data', value => { apiErrors += value; });
const types = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon', '.md':'text/plain' };
const server = createServer(async (req, res) => {
  let name = decodeURIComponent(new URL(req.url, origin).pathname).replace(/^\/mini-app\//, '/');
  if (name.endsWith('/')) name += 'index.html';
  const target = path.resolve(appRoot, '.' + name);
  if (!target.startsWith(appRoot + path.sep)) { res.writeHead(403); res.end(); return; }
  try { const body = await readFile(target); res.writeHead(200, { 'Content-Type':types[path.extname(target)] || 'application/octet-stream', 'Cache-Control':'no-store' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 25000) { const end = Date.now() + ms; while(Date.now() < end) { if(await check()) return; await pause(150); } throw Error('Timed out waiting for test condition'); }
const api = async (url = '/api/ledger?month=2026-02', body) => {
  const response = await fetch(apiOrigin + url, { method:body ? 'POST':'GET', headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)}:{}) });
  return response.json();
};
let context;
const errors = [], results = [];
function pass(name) { results.push(name); console.log('PASS:', name); }
async function openLedger(page) {
  await page.goto(origin + '/mini-app/');
  const toggle = page.locator('[aria-controls="life-menu"]');
  await toggle.hover();
  if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
  await page.locator('#ledger-link').click();
  await page.locator('#ledger-root #login-panel').waitFor({state:'visible'});
}
async function connect(page) {
  await page.locator('#ledger-root #endpoint').fill(apiOrigin);
  await page.locator('#ledger-root #access-key').fill(token);
  await page.locator('#ledger-root #login-form button[type=submit]').click();
  await page.locator('#ledger-root #application').waitFor({state:'visible'});
  await page.locator('#ledger-root #month').fill('2026-02');
  await page.locator('#ledger-root #month').press('Tab');
  await page.locator('#ledger-root #page-title').filter({hasText:'2026年 2月'}).waitFor();
}
async function add(page, label, amount) {
  await page.locator('#ledger-root #add').click();
  await page.locator('#ledger-root #field-description').fill(label);
  await page.locator('#ledger-root #field-date').fill('2026-02-03');
  await page.locator('#ledger-root #field-amount').fill(String(amount));
  await page.locator('#ledger-root #edit-form button[type=submit]').click();
  await page.locator('#ledger-root #editor').waitFor({state:'hidden'});
}
const queue = page => page.evaluate(() => Object.entries(localStorage).filter(([k])=>k.startsWith('mini-app-ledger:')&&k.endsWith(':outbox')).flatMap(([,v])=>JSON.parse(v)));
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18083,'127.0.0.1',resolve);});
  await until(async()=>{try{return (await fetch(apiOrigin+'/health')).ok;}catch{return false;}});
  const options = {headless:true, viewport:{width:1280,height:900}, locale:'ja-JP'};
  if (process.platform === 'win32') options.channel='msedge';
  context = await chromium.launchPersistentContext(path.join(artifacts, 'profile'), options);
  context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  await openLedger(page); await connect(page);
  await until(async()=> (await page.locator('#ledger-root .metric-value').nth(2).textContent()).includes('10,000'));
  await page.locator('#ledger-root').getByRole('tab',{name:'摘要',exact:true}).click();
  assert(await page.locator('#ledger-root').getByRole('heading',{name:'精算表',exact:true}).isVisible());
  pass('cross-origin login, monthly budget and summary');
  await page.locator('#ledger-root [data-screen=assets]').click();
  await page.locator('#ledger-root').getByRole('button',{name:'予算から充当',exact:true}).click();
  await page.locator('#ledger-root #field-amount').fill('3000');
  await page.locator('#ledger-root #edit-form button[type=submit]').click();
  await page.locator('#ledger-root .asset-columns section:nth-child(2) .asset-card').waitFor();
  await page.screenshot({path:path.join(artifacts,'assets.png'),fullPage:true});
  await page.locator('#ledger-root [data-screen=ledger]').click();
  await until(async()=> (await page.locator('#ledger-root .metric-value').nth(2).textContent()).includes('7,000'));
  pass('asset allocation completes the annual asset and reduces monthly remainder exactly once');
  await page.locator('#ledger-root').getByRole('tab',{name:'貸方',exact:true}).click();
  await page.locator('#ledger-root').getByRole('checkbox',{name:'交通費の立替（合成データ）を処理済みにする'}).check();
  await until(async()=> (await page.locator('#ledger-root .metric-value').nth(3).textContent()).replace(/\s/g,'')==='0円');
  await page.locator('#ledger-root').getByRole('tab',{name:'借方',exact:true}).click();
  await add(page,'返金の合成データ',-120);
  await until(async()=> (await api()).month.remaining===7120);
  pass('credit full settlement and signed negative amounts');
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await until(()=>page.evaluate(()=>!!navigator.serviceWorker.controller));
  await context.setOffline(true); await add(page,'圏外保存の合成データ',75);
  await until(async()=> (await queue(page)).length===1);
  const operationId=(await queue(page))[0].command.operation_id;
  await openLedger(page); await page.locator('#ledger-root #open-offline').click();
  await page.locator('#ledger-root #month').fill('2026-02'); await page.locator('#ledger-root #month').press('Tab');
  assert.equal((await queue(page))[0].command.operation_id,operationId);
  assert.equal(await page.locator('#ledger-root #connection').textContent(),'保存済み表示');
  await context.setOffline(false); await page.locator('#ledger-root #reconnect').click(); await connect(page);
  await until(async()=> (await queue(page)).length===0);
  await until(async()=> (await api()).entries.filter(x=>x.entity.description==='圏外保存の合成データ').length===1);
  pass('offline shell, cached month switching, preserved operation ID and reconnect replay');
  let lose=true;
  await page.route(apiOrigin+'/api/ledger/operations', async route=>{const response=await route.fetch();if(lose){lose=false;await route.abort();}else await route.fulfill({response});});
  await add(page,'応答喪失の合成データ',20);
  await until(async()=> (await queue(page)).length===1);
  const lostId=(await queue(page))[0].command.operation_id;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await until(async()=> (await queue(page)).length===0);
  const after=await api(); assert.equal(after.entries.filter(x=>x.entity.description==='応答喪失の合成データ').length,1);
  assert(after.operations.some(x=>x.operation_id===lostId));
  pass('lost NAS response replays the same operation without duplicate entries');
  await page.unroute(apiOrigin+'/api/ledger/operations');
  const second=await context.newPage(); await openLedger(second); await connect(second);
  await context.setOffline(true);
  await Promise.all([add(page,'別タブAの合成データ',11),add(second,'別タブBの合成データ',12)]);
  assert.equal((await queue(page)).length,2);
  assert.equal(new Set((await queue(page)).map(x=>x.command.operation_id)).size,2);
  await context.setOffline(false);
  await Promise.all([page.evaluate(()=>window.dispatchEvent(new Event('focus'))),second.evaluate(()=>window.dispatchEvent(new Event('focus')))]);
  await until(async()=> (await queue(page)).length===0);
  await until(async()=> (await api()).entries.filter(x=>/^別タブ[AB]/.test(x.entity.description||'')).length===2);
  pass('two tabs preserve both queued inputs and serialize replay');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.locator('#ledger-root').getByRole('button',{name:'日々の支出（合成データ）',exact:true}).click();
  const original=(await api()).entries.find(x=>x.entity.description==='日々の支出（合成データ）');
  await api('/api/ledger/operations',{operation_id:crypto.randomUUID(),expected_revision:original.revision,entity:{...original.entity,amount:19900}});
  await until(async()=> (await api()).entries.find(x=>x.entity.id===original.entity.id).entity.amount===19900);
  await page.locator('#ledger-root #field-amount').fill('19800');
  await page.locator('#ledger-root #edit-form button[type=submit]').click();
  await until(async()=> (await queue(page)).some(x=>x.error));
  assert.equal((await api()).entries.find(x=>x.entity.id===original.entity.id).entity.amount,19900);
  await page.locator('#ledger-root [data-screen=sync]').click();
  assert(await page.locator('#ledger-root').getByRole('button',{name:'最新値と比較して再編集',exact:true}).isVisible());
  pass('a stale edit remains reviewable in the local queue and never overwrites the newer NAS value');
  assert(!(await page.evaluate(()=>JSON.stringify({...localStorage}))).includes(token));
  assert.equal((await context.cookies()).length,0);
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(artifacts,'mobile.png'),fullPage:true});
  assert.equal(JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8')).id,'https://misacanetworks.myqnapcloud.com:8081/mini-app/');
  assert.deepEqual(errors,[]);
  pass('no persistent key or auth cookies, preserved PWA identity, mobile width and no JavaScript errors');
} catch(error) { console.error(error); if(apiErrors) console.error(apiErrors); process.exitCode=1; }
finally {
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({results,errors},null,2));
  if(context)await context.close(); server.close();
  await fetch(apiOrigin+'/__test_shutdown',{method:'POST',headers:{Authorization:'Bearer '+token}}).catch(()=>{});
  await pause(1000); if(apiProcess.exitCode===null)apiProcess.kill();
  console.log('Retained test artifacts:',artifacts);
}
