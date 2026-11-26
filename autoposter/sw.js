const CACHE_NAME = 'autopub-v4';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './borders-data.js',
  './pubmat-templates.js',
  './jszip.min.js',
  './manifest.json',
  './4x3.png',
  './16x9.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return networkResponse;
        }
        return caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || networkResponse);
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
