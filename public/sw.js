// sw.js - minimal service worker so the mobile dashboard can be installed
// as a PWA (Add to Home Screen).
//
// IMPORTANT: every request is network-first. The shell + static assets are
// cached only as an offline fallback, so the desktop app always gets fresh
// CSS/JS after an update instead of silently serving a stale cached copy.
const CACHE = 'ak-mobile-v4';
const SHELL = [
  'mobile.html',
  'mobile.css',
  'mobile.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  // Network first for everything: navigations, API calls and static assets.
  // Fall back to the cached copy only when the network is unavailable.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && event.request.method === 'GET' && !event.request.url.includes('/api/')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
