// ─── Sentinelle perso — service worker v1 ────────────────────────────────────
// Shell et data.json servis réseau d'abord (fraîcheur) avec repli cache (hors ligne).
var CACHE = 'sentinelle-v1';
var SHELL = [
  './', 'index.html', 'styles.css', 'logic.js', 'app.js',
  'manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function (r) {
      if (r.ok) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return r;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(function (m) {
        return m || caches.match('./').then(function (sh) { return sh || Response.error(); });
      });
    })
  );
});
