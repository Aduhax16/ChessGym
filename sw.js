// Offline support. Every request tries the network first, so a new release
// reaches people on their next visit without any version bump here. The cache
// answers when there is no connection or the network takes too long.

const CACHE = 'chessgym-v1';
const NETWORK_TIMEOUT_MS = 3000;

// Add any new file the app needs at startup. scripts/check_offline.py checks this list.
const APP_FILES = [
  './',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/appearance.js',
  'js/board.js',
  'js/book.js',
  'js/bot.js',
  'js/install.js',
  'js/progress.js',
  'js/rating.js',
  'js/trainer.js',
  'vendor/chess.js',
  'assets/pieces.svg',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'data/openings.json',
  'data/book/meta.json',
  'data/book/reference.json',
];

/** The rating bands are large, so one failed download must not block the install. */
async function storeBands(cache) {
  const response = await cache.match('data/book/meta.json');
  const { bands } = await response.json();
  await Promise.allSettled(bands.map(({ id }) => cache.add(`data/book/${id}.json`)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_FILES);
    await storeBands(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function fromCache(cache, request) {
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit || request.mode !== 'navigate') return hit;
  return cache.match('./');
}

async function respond(event) {
  const cache = await caches.open(CACHE);
  const network = fetch(event.request);
  // Keep the copy even if the page was already answered from the cache.
  event.waitUntil(network.then((response) => {
    if (response.ok) return cache.put(event.request, response.clone());
    return undefined;
  }).catch(() => {}));

  const slow = new Promise((resolve) => {
    setTimeout(async () => {
      const hit = await fromCache(cache, event.request);
      if (hit) resolve(hit);
    }, NETWORK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([network, slow]);
  } catch (error) {
    const hit = await fromCache(cache, event.request);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(respond(event));
});
