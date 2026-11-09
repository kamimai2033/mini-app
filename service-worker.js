const CACHE_NAME = 'mini-app-cache-v1.7.2';
const urlsToCache = [
    '/mini-app/',
    '/mini-app/index.html',
    '/mini-app/styles/main.css',
    '/mini-app/scripts/main.js',
    '/mini-app/scripts/modules/charCountModule.js',
    '/mini-app/scripts/modules/dictionaryModule.js',
    '/mini-app/scripts/modules/jpdictionaryModule.js',
    '/mini-app/scripts/modules/posModule.js',
    '/mini-app/scripts/modules/editorModule.js',
    '/mini-app/scripts/modules/audioPlayerModule.js',
    '/mini-app/scripts/modules/weatherModule.js',
    '/mini-app/scripts/modules/pdfModule.js',
    '/mini-app/scripts/modules/jspdfModule.js',
    '/mini-app/scripts/modules/mailGeneratorModule.js',
    '/mini-app/images/icon-192x192.png',
    '/mini-app/images/icon-512x512.png',
    '/mini-app/images/icon-512x512.png',
];

// インストール処理
self.addEventListener('install', async (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_NAME);
            try {
                await cache.addAll(urlsToCache);
                console.log('[ServiceWorker] キャッシュ完了:', CACHE_NAME);
            } catch (error) {
                console.error('[ServiceWorker] キャッシュ追加エラー:', error);
            }
        })()
    );
});

// キャッシュの更新処理（古いキャッシュを削除）
self.addEventListener('activate', async (event) => {
    event.waitUntil(
        (async () => {
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames.map(async (cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[ServiceWorker] 古いキャッシュ削除:', cacheName);
                        await caches.delete(cacheName);
                    }
                })
            );
            console.log('[ServiceWorker] アクティベーション完了:', CACHE_NAME);
        })()
    );
});

// フェッチ処理
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
        .then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse; // キャッシュがあればそれを返す
            }
            return fetch(event.request)
                .then((networkResponse) => {
                    return caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, networkResponse.clone()); // 最新データをキャッシュ
                        return networkResponse;
                    });
                })
                .catch(() => {
                    console.warn('[ServiceWorker] ネットワークエラー:', event.request.url);
                    return caches.match('/offline.html'); // オフライン用ページ（未実装）
                });
        })
    );
});
