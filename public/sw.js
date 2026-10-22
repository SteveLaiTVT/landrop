/* LanDrop service worker：只缓存外壳，文件与 API 永远走网络 */
const CACHE = "landrop-shell-v1";
const SHELL = [
  "/app",
  "/assets/tokens.css",
  "/assets/phone.css",
  "/assets/app-shell.css",
  "/assets/icon.svg",
  "/js/app.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match("/app").then((hit) => hit || new Response("离线：请回到同一 Wi‑Fi 后重试", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        }))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((hit) => {
      const network = fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
