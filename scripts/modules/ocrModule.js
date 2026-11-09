import '../app-config.js';
import { copyText, downloadText, loadImageFile } from './utils.js';

const config = globalThis.MINI_APP_CONFIG;
const base = new URL('../../', import.meta.url);
const assetBase = new URL(`ocr-assets/${config.ocrVersion}/`, base);
const cacheName = `mini-app:${base.pathname}:ocr-${config.ocrVersion}`;
let libraryPromise;

async function isPrepared() {
  const cache = await caches.open(cacheName);
  const matches = await Promise.all(config.ocrAssets.map(([path]) => cache.match(new URL(path, assetBase).href)));
  return matches.every(Boolean);
}
function loadLibrary() {
  if (globalThis.Tesseract) return Promise.resolve(globalThis.Tesseract);
  if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('tesseract.min.js', assetBase).href;
    script.onload = () => resolve(globalThis.Tesseract);
    script.onerror = () => { script.remove(); libraryPromise = null; reject(new Error('OCRエンジンを読み込めません。ページを開き直してください。')); };
    document.head.append(script);
  });
  return libraryPromise;
}
function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
async function ensureController() {
  if (!window.isSecureContext || !navigator.serviceWorker || !window.caches || !crypto.subtle) {
    throw new Error('OCRにはHTTPSまたはlocalhostでのアクセスが必要です。');
  }
  await withTimeout(navigator.serviceWorker.ready, 20000, 'オフライン準備が完了していません。オンラインでページを開き直してください。');
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve, reject) => {
      const changed = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve(); };
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', changed);
        reject(new Error('ページを開き直してからOCRを準備してください。'));
      }, 10000);
      navigator.serviceWorker.addEventListener('controllerchange', changed);
    });
  }
  if (navigator.serviceWorker.controller.scriptURL !== new URL('service-worker.js', base).href) {
    throw new Error('このアプリのオフライン準備が完了していません。ページを開き直してください。');
  }
}
export async function initOCR() {
  const prepare = document.getElementById('ocr-prepare');
  const readyLabel = document.getElementById('ocr-ready');
  const input = document.getElementById('ocr-file');
  const language = document.getElementById('ocr-language');
  const preview = document.getElementById('ocr-preview');
  const recognize = document.getElementById('ocr-recognize');
  const cancel = document.getElementById('ocr-cancel');
  const progress = document.getElementById('ocr-progress');
  const status = document.getElementById('ocr-status');
  const output = document.getElementById('ocr-text');
  let busy = false, prepared = false, cancelled = false, worker, aborter, previewURL;
  function buttons() {
    prepare.disabled = busy || prepared;
    recognize.disabled = busy || !prepared;
    input.disabled = language.disabled = busy;
    cancel.disabled = !busy;
    prepare.textContent = prepared ? 'OCR準備済み' : 'OCRを準備する';
    readyLabel.textContent = prepared ? 'オフライン利用できます' : '初回の準備が必要です';
  }
  function releasePreview() { if (previewURL) URL.revokeObjectURL(previewURL); previewURL = null; }
  window.addEventListener('pagehide', event => {
    if (!event.persisted) { releasePreview(); aborter?.abort(); worker?.terminate(); }
  });
  input.addEventListener('change', () => {
    releasePreview();
    preview.hidden = true;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { status.textContent = '画像は1枚20MB以下にしてください。'; input.value = ''; return; }
    previewURL = URL.createObjectURL(file);
    preview.src = previewURL; preview.hidden = false;
    status.textContent = '';
  });
  cancel.addEventListener('click', () => {
    cancelled = true;
    aborter?.abort();
    if (worker) worker.terminate().catch(() => {});
    status.textContent = '中止しています…';
    cancel.disabled = true;
  });
  prepare.addEventListener('click', async () => {
    if (busy) return;
    busy = true; cancelled = false; aborter = new AbortController(); buttons(); progress.value = 0;
    try {
      await ensureController();
      const cache = await caches.open(cacheName);
      for (let i = 0; i < config.ocrAssets.length; i++) {
        if (cancelled) throw new DOMException('Cancelled', 'AbortError');
        const [path, url, expectedHash] = config.ocrAssets[i];
        const key = new URL(path, assetBase).href;
        status.textContent = `OCR準備中 ${i + 1}/${config.ocrAssets.length}（初回は時間がかかります）`;
        if (!await cache.match(key)) {
          const timeout = setTimeout(() => aborter.abort(), 120000);
          try {
            const response = await fetch(url, { mode: 'cors', credentials: 'omit', signal: aborter.signal });
            if (!response.ok) throw new Error(`認識データを取得できません（HTTP ${response.status}）。`);
            const bytes = await response.arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
            if (hash !== expectedHash) throw new Error('認識データの検証に失敗しました。');
            if (cancelled) throw new DOMException('Cancelled', 'AbortError');
            await cache.put(key, new Response(bytes, { headers: {
              'Content-Type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/gzip'
            } }));
          } finally { clearTimeout(timeout); }
        }
        progress.value = Math.round((i + 1) / config.ocrAssets.length * 100);
      }
      prepared = await isPrepared();
      status.textContent = 'OCRの準備ができました。画像を選んで文字を読み取ってください。';
    } catch (error) {
      status.textContent = cancelled ? '準備を中止しました。再実行すると保存済みのデータから続けます。' : `準備できませんでした。接続・空き容量を確認して再実行してください。${error.message}`;
    } finally { busy = false; aborter = null; buttons(); }
  });
  recognize.addEventListener('click', async () => {
    if (busy) return;
    const file = input.files?.[0];
    if (!file) { status.textContent = '画像を選択してください。'; return; }
    busy = true; cancelled = false; buttons(); progress.value = 0;
    let canvas, disposed = false, cancelTimer;
    try {
      await ensureController();
      prepared = await isPrepared();
      if (!prepared) throw new Error('認識データが見つかりません。「OCRを準備する」を実行してください。');
      const image = await loadImageFile(file);
      canvas = document.createElement('canvas');
      const scale = Math.min(1, 3200 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('画像を処理するメモリが不足しています。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (cancelled) throw new DOMException('Cancelled', 'AbortError');
      const Tesseract = await loadLibrary();
      const loading = Tesseract.createWorker(language.value, 1, {
        workerPath: new URL('worker.min.js', assetBase).href,
        workerBlobURL: false,
        corePath: new URL('core/', assetBase).href,
        langPath: new URL('lang/', assetBase).href,
        cacheMethod: 'none',
        logger: message => {
          if (cancelled || disposed) return;
          if (message.status === 'recognizing text') {
            progress.value = Math.round(message.progress * 100);
            status.textContent = `文字を読み取り中… ${progress.value}%`;
          } else status.textContent = '認識エンジンを起動しています…';
        }
      }).then(created => {
        if (disposed || cancelled) { created.terminate(); throw new DOMException('Cancelled', 'AbortError'); }
        worker = created; return created;
      });
      const cancellation = new Promise((_, reject) => {
        cancelTimer = setInterval(() => { if (cancelled) reject(new DOMException('Cancelled', 'AbortError')); }, 100);
      });
      await Promise.race([withTimeout(loading, 60000, '認識エンジンの起動がタイムアウトしました。'), cancellation]);
      const result = await Promise.race([
        withTimeout(worker.recognize(canvas), 180000, '認識がタイムアウトしました。小さな画像でお試しください。'),
        cancellation
      ]);
      if (cancelled) throw new DOMException('Cancelled', 'AbortError');
      output.value = result.data.text.trim();
      progress.value = 100;
      status.textContent = output.value ? '読み取りが完了しました。原画像と照らして結果を確認してください。' : '文字を読み取れませんでした。明るさ・傾き・画像の大きさを調整してください。';
    } catch (error) {
      status.textContent = cancelled ? '読み取りを中止しました。' : `読み取れませんでした。${error.message}`;
    } finally {
      disposed = true;
      clearInterval(cancelTimer);
      if (worker) { await worker.terminate().catch(() => {}); worker = null; }
      if (canvas) canvas.width = canvas.height = 1;
      busy = false; buttons();
    }
  });
  document.getElementById('ocr-copy').addEventListener('click', async () => {
    try { await copyText(output.value, output); status.textContent = 'コピーしました。'; }
    catch (error) { status.textContent = error.message; }
  });
  document.getElementById('ocr-save').addEventListener('click', () => {
    if (!output.value.trim()) { status.textContent = '保存する文字がありません。'; return; }
    downloadText(output.value, 'miniapp-ocr.txt');
  });
  try { prepared = window.isSecureContext && 'caches' in window && await isPrepared(); }
  catch { status.textContent = '端末内の保存領域を利用できません。ブラウザの設定・空き容量を確認してください。'; }
  buttons();
}
