// Sapphire service worker.
// - Chapters saved "on this device" (Cache Storage "sapphire-offline-v1") are served from there,
//   so they open with no connection and without using data.
// - Everything else goes to the network first; if that fails (offline), a saved copy is used.
// - The app itself is kept so it can open offline. The page is always checked for a new version first.
const OFFLINE = "sapphire-offline-v1";
const SHELL = "sapphire-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Page images: a saved copy first (saves data), the network otherwise.
  if (/^\/api\/(read|dl)\//.test(url.pathname) || /\/thumbnail$/.test(url.pathname)) {
    event.respondWith(caches.match(req, { cacheName: OFFLINE }).then((hit) => hit || fetch(req)));
    return;
  }

  // API: network first, saved copy when offline.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(req, { cacheName: OFFLINE }).then((hit) => hit || new Response(JSON.stringify({ error: "You're offline." }), { status: 503, headers: { "content-type": "application/json" } })),
      ),
    );
    return;
  }

  // Built files have content hashes in their names, so a cached copy is always right.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // The page and icons: network first (so updates arrive), last good copy when offline.
  if (req.mode === "navigate" || /\.(svg|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(req.mode === "navigate" ? "/" : req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req.mode === "navigate" ? "/" : req, { cacheName: SHELL }).then((hit) => hit || Response.error())),
    );
  }
});
