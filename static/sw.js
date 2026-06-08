/* Arc Swim Rota service worker.
 * App-shell cache so the PWA loads offline; API requests always hit the network
 * (never cached) so rota data is fresh. Bump CACHE to invalidate old shells. */
const CACHE = "arc-swim-v20";
const SHELL = [
  "/",
  "/static/styles.css?v=20",
  "/static/app.js?v=20",
  "/manifest.webmanifest",
  "/static/icon-192.png",
  "/static/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) {
    return; // let API + writes go straight to the network
  }
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached || caches.match("/"));
      return cached || network;
    })
  );
});
