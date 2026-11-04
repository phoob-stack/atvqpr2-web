// sw.js - the launcher shell offline: the page and its code, cache-first.
// The pipeline fills in SHELL (every shell file with its hash) and VERSION
// (their combined hash), so a new release means a new sw.js, which the
// browser picks up on its own update check, installs, and swaps in.
// Assets are NOT cached here: they live in OPFS (asset-worker.js), and every
// request outside the shell (the manifest, objects, the hub) goes to the
// network untouched.
const VERSION = '__VERSION__';
const SHELL = __SHELL__;       // ['index.html', 'client/assets.js', ...] relative to this file
const CACHE = `delivery-shell-${VERSION}`;
const scope = new URL(self.registration.scope);
const shellUrls = new Set(SHELL.map((p) => new URL(p, scope).href));

// A response that followed a redirect (hosts that serve /dir/index.html as a redirect to /dir/) may not
// answer a navigation: the browser shows an error page. Keep and serve a plain copy of its body instead.
const plain = async (res) => (res.redirected
  ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers })
  : res);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (p) => {
      const url = new URL(p, scope).href;
      const res = await fetch(new Request(url, { cache: 'no-cache' }));
      if (!res.ok) throw new Error(`shell file ${p}: HTTP ${res.status}`);
      await c.put(url, await plain(res));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('delivery-shell-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  u.search = '';
  let key = u.href;
  if (req.mode === 'navigate' && (u.href === scope.href || u.href === new URL('index.html', scope).href)) key = new URL('index.html', scope).href;
  if (!shellUrls.has(key)) return;                    // not ours: straight to the network
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(key);
    if (hit) return plain(hit);
    const res = await plain(await fetch(req));
    if (res.ok) c.put(key, res.clone());
    return res;
  })());
});
