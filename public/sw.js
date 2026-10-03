// Offline shell: stale-while-revalidate for this app's own files. The first
// online visit fills the cache with whatever the app actually loaded.
const CACHE = 'fieldstretcher-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(r);
      const net = fetch(r)
        .then((res) => {
          if (res.ok) c.put(r, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
