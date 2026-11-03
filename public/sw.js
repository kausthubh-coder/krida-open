// Krida's service worker: what makes it an installable app that opens at once, even on a bad connection.
//
// - Pages always come from the network first, so a new deploy is what opens; the last one is kept for when the
//   network is down, so the app still opens instead of the browser's offline page.
// - Built files (/assets/*) never change under one name, so once fetched they come from here.
// - Nothing else is touched: /api, Convex, streams, artwork and every POST go straight to the network.

const SHELL = "krida-shell-v1";
const ASSETS = "krida-assets-v1";
// Old builds' files are dropped once there are more than this many; a build has about 35.
const MAX_ASSETS = 200;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(SHELL).then((cache) => cache.put("/", copy)));
          }
          return response;
        })
        .catch(() => caches.match("/", { cacheName: SHELL }).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request, { cacheName: ASSETS }).then(
        (cached) =>
          cached ??
          fetchAsset(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              event.waitUntil(caches.open(ASSETS).then((cache) => cache.put(request, copy).then(() => trim(cache))));
            }
            return response;
          }),
      ),
    );
  }
});

// A built file that fails is asked for again past the browser's own cache. vercel.json gives every /assets/ answer a
// year-long cache header, a 404 too: one caught mid-deploy stayed in the desktop app's cache and blanked it on every
// launch, since a reload reads the same cache.
function fetchAsset(request) {
  return fetch(request).then((response) => (response.ok ? response : fetch(request, { cache: "reload" })));
}

async function trim(cache) {
  const keys = await cache.keys();
  // Keys come back in the order they were added, so the oldest builds go first.
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((key) => cache.delete(key)));
}
