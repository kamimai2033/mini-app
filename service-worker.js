const CACHE_NAME = 'mini-app-cache-v4';
const urlsToCache = [
    '/styles/main.css',
    '/scripts/main.js',
    '/scripts/modules/charCountModule.js',
    '/scripts/modules/dictionaryModule.js',
    '/scripts/modules/posModule.js',
    '/scripts/modules/editorModule.js',
    '/scripts/modules/audioPlayerModule.js', // 追加
    '/images/icon-192x192.png',
    '/images/icon-512x512.png'
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
