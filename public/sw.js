const CACHE = "goodwills-static-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll([
        "/goodwills/",
        "/goodwills/index.html",
        "/goodwills/manifest.webmanifest",
        "/goodwills/icons/icon-192.png",
        "/goodwills/icons/icon-512.png"
      ])
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : null)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== location.origin) return;

  // НЕ кэшируем медиа
  if (event.request.destination === "video" || event.request.destination === "audio") return;

  // Навигация: сеть → кэш fallback
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/goodwills/index.html"))
    );
    return;
  }

  // Статика (js/css/img/font): cache-first
  const dest = event.request.destination;
  const isStatic =
    dest === "script" || dest === "style" || dest === "image" || dest === "font";

  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return resp;
        });
      })
    );
    return;
  }

  // Остальное: как было
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
