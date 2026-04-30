const CACHE_NAME = 'a-eye-v2';

// App shell — everything needed to load the UI
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './icon-192.png',
  './icon-512.png',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap'
];

// ── Install: cache the app shell ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting(); // activate immediately
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim(); // take control of all pages immediately
});

// ── Fetch: serve from cache, fall back to network ────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go to network for Ollama API calls (localhost)
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return; // let it pass through to the network
  }

  // Cache-first strategy for app shell assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        // Cache new successful responses for next time
        if (response && response.status === 200 && response.type === 'basic') {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return response;
      });
    }).catch(() => {
      // Offline fallback — return the cached index.html for navigation requests
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
