/* Aurum service worker — network-first for everything, cache as the offline fallback.
   Network-first means a new deploy (and each day's prices) is picked up on the next visit,
   while a phone with no signal still opens the app with the last prices it saw. */
const VERSION = 'aurum-v2';
const SHELL = ['./', 'index.html', 'assets/styles.css', 'assets/app.js', 'assets/icon.svg', 'manifest.webmanifest', 'data/prices.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Price data is requested with a ?d=YYYY-MM-DD cache-buster; store it under one key.
  const key = url.pathname.endsWith('/data/prices.json') ? 'data/prices.json' : req;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); }
        return res;
      })
      .catch(() => caches.match(key, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
