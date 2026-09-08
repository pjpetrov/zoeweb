/* ZoeWeb service worker: stale-while-revalidate for same-origin requests,
 * so the installed app works offline and still picks up updates. */
const CACHE = 'zoeweb-v1';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request);
    const network = fetch(e.request).then(resp => {
      if (resp.ok) cache.put(e.request, resp.clone());
      return resp;
    }).catch(() => null);
    return cached || (await network) || new Response('offline', { status: 503 });
  })());
});
