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

  // Навигация: сеть → кэш
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/goodwills/"))
    );
    return;
  }

  // Статика: кэш → сеть
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
