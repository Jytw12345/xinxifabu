/* 设计需求发布平台 · Service Worker
 * 独立缓存空间（dr-pwa），与「设计部工作台」互不干扰。
 *  - 同源静态资源：运行时 network-first（联网即用最新，离线回退缓存）
 *  - vendor/supabase.js：cache-first（带 ?libN，URL 不变即不重抓）
 *  - 页面导航：network-first，回退缓存外壳
 * 发版改前端时把下面 CACHE 的 vN + index.html 里的 ?vN 同步 +1。
 */
const CACHE = 'dr-pwa-v31';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css?v31',
  './vendor/supabase.js?lib1',
  './js/config.js?v31',
  './js/db.js?v31',
  './js/app.js?v31',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  // 不调用 skipWaiting：由页面在「检查更新」时 postMessage SKIP_WAITING 唤醒，避免静默刷新。
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(
      PRECACHE.map((u) =>
        fetch(new Request(u, { cache: u.indexOf('/vendor/') >= 0 ? 'default' : 'reload' }))
          .then((res) => (res && res.ok ? c.put(u, res) : null))
          .catch(() => null)
      )
    ))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (url.origin === self.location.origin && url.pathname.indexOf('/vendor/') >= 0) {
    event.respondWith(
      caches.match(req).then((m) => m || fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((f) => f || Response.error())))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((m) => m || Response.error())))
    return;
  }
});

async function cachePut(req, res) {
  try {
    if (res && res.status === 200 && res.type !== 'error') {
      const c = await caches.open(CACHE);
      await c.put(req, res);
    }
  } catch (e) {}
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
