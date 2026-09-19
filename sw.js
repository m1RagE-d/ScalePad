const CACHE_NAME = 'bip-evaluation-v6';
const CORE_FILES = ['./', './index.html', './app.js', './presets.js', './manifest.json'];
const numbered = (folder, prefix, count) => Array.from({ length: count }, (_, index) => `./${folder}/${prefix}${String(index + 1).padStart(2, '0')}.png`);
const MATERIAL_FILES = [
  ...numbered('assets/animal', 'item', 15),
  ...numbered('assets/colors', 'item', 13),
  ...numbered('assets/spatial-a', 'item', 16),
  ...numbered('assets/spatial-b', 'item', 16),
  ...numbered('assets/clock-a', 'item', 15),
  ...numbered('assets/clock-b', 'item', 15),
  ...numbered('assets/faces-a-18', 'face', 10),
  ...numbered('assets/faces-b-18', 'face', 10),
  ...numbered('assets/faces-a-30', 'face', 10),
  ...numbered('assets/faces-b-30', 'face', 10)
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...CORE_FILES, ...MATERIAL_FILES])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  })));
});
