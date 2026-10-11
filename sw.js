// HarvTrack service worker
// Bump CACHE_NAME whenever you change the cached files so users receive the update.
const CACHE_NAME = 'harvtrack-v3';
const ASSETS = ['/', '/index.html', '/css/style.css', '/js/app.js', '/manifest.json', '/img/icon-192.png', '/img/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Remove caches from older versions
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (always the latest app), fall back to the cache when offline.
// /api/ requests are never cached: they carry private data and login tokens.
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))
      )
  );
});
