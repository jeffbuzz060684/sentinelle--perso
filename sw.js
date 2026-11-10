var CACHE = "sentinelle-perso-v7";
var SHELL = ["./", "./index.html", "./logic.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL).then(function () { return self.skipWaiting(); });
  }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = e.request.url.split("?")[0]; // clé de cache sans ?v= (secours hors ligne utilisable)
  // réseau d'abord pour le shell ET data.json ; cache en secours — jamais de version figée.
  // v3.3 : garde-fou de 3,5 s — une connexion morte/lente ne doit pas laisser l'app
  // bloquée sur un fetch qui ne répond jamais : on bascule sur le cache au bout du délai.
  e.respondWith(new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error("timeout réseau 3,5 s")); }
    }, 3500);
    fetch(e.request).then(function (r) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (r.ok) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put(url, copy); });
      }
      resolve(r);
    }, function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  }).catch(function () {
    return caches.match(url).then(function (m) { return m || (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error()); });
  }));
});
