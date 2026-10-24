// Service worker: сохраняет само приложение на телефоне, чтобы оно открывалось мгновенно.
// Запросы к почтовому API (другой домен) всегда идут в сеть.
// При изменении файлов приложения увеличь версию — старый кэш удалится.
const CACHE = 'hidemail-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png',
  'fonts/manrope-cyrillic-wght-normal.woff2', 'fonts/manrope-latin-wght-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('hidemail-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // stale-while-revalidate: отдаём из кэша, в фоне обновляем
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request)
      .then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; })
      .catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    return (await fresh) || (await cache.match('index.html')) || Response.error();
  }));
});
