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

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL.map((p) => new Request(new URL(p, scope).href, { cache: 'no-cache' })));
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
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) c.put(key, res.clone());
    return res;
  })());
});
