// 앱 파일을 캐시해서 오프라인에서도 열리게 함 (네트워크 우선)
const CACHE = 'handcal-v51';
const ASSETS = ['./', './index.html', './style.css', './js/core.js', './js/events.js', './js/calendar.js', './js/export.js', './js/day.js', './js/tabs.js', './js/ocr.js', './js/sync.js', './js/media.js', './js/stores.js', './js/goals.js', './js/ui.js', './js/main.js', './config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './vendor/perfect-freehand.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// 안드로이드 '공유 → 필기캘린더': 받은 글·사진을 share-inbox 캐시에 두고 앱이 열리면 오늘 메모로 옮김
async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open('share-inbox');
  const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: [] };
  let i = 0;
  for (const f of form.getAll('files')) {
    if (!(f instanceof File)) continue;
    const key = `./share-file-${Date.now()}-${i++}`;
    await cache.put(key, new Response(f, { headers: { 'Content-Type': f.type } }));
    meta.files.push({ key, type: f.type, name: f.name });
  }
  await cache.put('./share-meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
