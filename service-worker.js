importScripts('./scripts/app-config.js');

const config = self.MINI_APP_CONFIG;
const scopeURL = new URL(self.registration.scope);
const prefix = `mini-app:${scopeURL.pathname}:`;
const shellCache = `${prefix}shell-${config.version}`;
const ocrCache = `${prefix}ocr-${config.ocrVersion}`;
const shellURLs = [...new Set([
  ...config.shellFiles,
  ...config.features.filter(feature => feature[2]).map(feature => `./scripts/modules/${feature[2]}`)
].map(path => new URL(path, scopeURL).href))];
const ocrURLs = new Set(config.ocrAssets.map(([path]) =>
  new URL(`./ocr-assets/${config.ocrVersion}/${path}`, scopeURL).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Reject installation on failure; the old worker and cache remain usable.
    const cache = await caches.open(shellCache);
    await cache.addAll(shellURLs.map(url => new Request(url, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name =>
      (name.startsWith(prefix) && name !== shellCache && name !== ocrCache) ||
      (scopeURL.pathname === '/mini-app/' && /^mini-app-cache-v[\d.]+$/.test(name))
    ).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scopeURL.origin ||
      !url.pathname.startsWith(scopeURL.pathname)) return;
  if (ocrURLs.has(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(ocrCache);
      return await cache.match(request) || new Response('OCR preparation required', { status: 503 });
    })());
    return;
  }
  if (!shellURLs.includes(url.href) && request.mode !== 'navigate') return;
  event.respondWith((async () => {
    const cache = await caches.open(shellCache);
    const lookup = new URL(request.url);
    if (request.mode === 'navigate') lookup.search = '';
    const cached = await cache.match(lookup.href);
    if (cached) return cached;
    try { return await fetch(request); }
    catch {
      if (request.mode === 'navigate') {
        const home = await cache.match(new URL('./index.html', scopeURL).href);
        if (home) return home;
      }
      return new Response('オフラインです。オンラインで一度アプリを開いてください。', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});

// No skipWaiting: close all app tabs/windows to activate a complete update.
