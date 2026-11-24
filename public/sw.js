const CACHE_NAME = 'tinnitune-v2';
const PRECACHE = /*__PRECACHE_MANIFEST__*/ ['/'];

/**
 * Strip the `redirected` flag from a Response before storing or returning to navigation
 * requests (Chromium rejects redirected Service Worker responses on navigate mode).
 */
async function cleanResponse(res) {
  if (!res || !res.redirected) return res;
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        await Promise.all(
          PRECACHE.map(async (url) => {
            try {
              const res = await fetch(new Request(url, { cache: 'reload' }));
              // Never cache HTTP errors or 3xx redirects
              if (!res.ok || (res.status >= 300 && res.status < 400)) return;
              const cleaned = await cleanResponse(res);
              await cache.put(url, cleaned);
            } catch {
              // Skip transient individual fetch errors during install
            }
          })
        );
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/cdn-cgi/')) return;
  if (url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          if (res.ok && !res.redirected && url.pathname === '/') {
            const copy = await cleanResponse(res.clone());
            const cache = await caches.open(CACHE_NAME);
            await cache.put('/', copy);
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match('/', { ignoreVary: true });
          if (cached) return cleanResponse(cached);
          return Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreVary: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then(async (res) => {
        if (res.ok && res.type === 'basic' && !res.redirected) {
          const copy = res.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(req, copy);
        }
        return res;
      });
    })
  );
});
