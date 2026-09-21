'use strict';

const SHELL = 'shell-v1';
const IMAGES = 'images-v1';
const MAX_IMAGES = 400;
const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== IMAGES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_IMAGES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // AniList sorguları (POST) hep ağdan gider

  const url = new URL(req.url);

  // Kapak görselleri: önce önbellek, yoksa ağdan al ve sakla (çevrimdışı koleksiyon için)
  if (req.destination === 'image' && url.origin !== location.origin) {
    e.respondWith(
      caches.open(IMAGES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') {
            cache.put(req, res.clone()).then(() => trim(cache));
          }
          return res;
        } catch (err) {
          return Response.error();
        }
      })
    );
    return;
  }

  // Uygulama dosyaları: önce ağ (güncellemeler hemen gelsin), olmazsa önbellek
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
    );
  }
});
