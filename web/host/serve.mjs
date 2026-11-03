// Local dev server for the browser build. Node only, no packages.
//
//   node web/host/serve.mjs [--game <folder>] [--port 8460] [--log <file>] [--overlay <dir>]
//
// Binds 127.0.0.1 only. Sends COOP/COEP (+CORP) so the page is cross-origin
// isolated (SharedArrayBuffer, shared WebAssembly.Memory). Serves:
//   /                 -> /host/index.html
//   /host/*, /gpu/*   web/host, web/gpu
//   /wasm/atv2.wasm   build-wasm/atv2.wasm
//   /data/manifest.json  the game folder's file list (path, size, mtime)
//   /data/<path>      the game folder's files, with Range support
//   POST /log         appends the page's log to --log (default build-wasm/web.log)
// /data/ exists only with --game <folder> (a developer option: the page then
// reads that folder instead of the player's import; ?dev=0 ignores it). The
// folder is read in place, never copied, and only ever served to this
// machine. Without --game the server sends no game data at all: the page asks
// the player for their own game folder and copies it into OPFS (loader.js).
import { createServer } from 'node:http';
import { createReadStream, statSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GAME = arg('--game') ? resolve(arg('--game')) : null;
const PORT = Number(arg('--port', 8460));
const LOG = resolve(arg('--log', join(ROOT, 'build-wasm/web.log')));
const MOUNTS = { '/host/': join(ROOT, 'web/host'), '/gpu/': join(ROOT, 'web/gpu'), '/wasm/': join(ROOT, 'build-wasm') };
// --overlay <dir>: files there shadow /host/* (try another worker's host JS
// without copying it into the tree).
const OVERLAY = arg('--overlay') ? resolve(arg('--overlay')) : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.wgsl': 'text/plain', '.css': 'text/css; charset=utf-8' };
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' };

function manifest() {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = statSync(p);
        files.push({ path: relative(GAME, p).split(sep).join('/'), size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
  };
  walk(GAME);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

function sendFile(req, res, file) {
  let st;
  try { st = statSync(file); } catch { res.writeHead(404, ISOLATION); res.end(); return; }
  if (!st.isFile()) { res.writeHead(404, ISOLATION); res.end(); return; }
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (m) {
    const start = Number(m[1]), end = Math.min(st.size - 1, m[2] ? Number(m[2]) : st.size - 1);
    if (start > end) { res.writeHead(416, { ...ISOLATION, 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { ...ISOLATION, 'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...ISOLATION, 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(res);
  }
}

const inside = (base, p) => { const r = relative(base, p); return r && !r.startsWith('..') && !r.includes(':'); };

writeFileSync(LOG, `--- dev server start ${new Date().toISOString()} (${GAME ? `game folder ${GAME} at /data/` : 'no /data/'})\n`);
const srv = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'POST' && path === '/log') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1 << 22) req.destroy(); });
    req.on('end', () => { appendFileSync(LOG, body); res.writeHead(204, ISOLATION); res.end(); });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, ISOLATION); res.end(); return; }
  if (path === '/' || path === '/index.html') {
    res.writeHead(302, { ...ISOLATION, Location: '/host/index.html' + new URL(req.url, 'http://x').search }); res.end(); return;
  }
  if (!GAME && path.startsWith('/data/')) { res.writeHead(404, ISOLATION); res.end(); return; }
  if (path === '/data/manifest.json') {
    const body = JSON.stringify(manifest());
    res.writeHead(200, { ...ISOLATION, 'Content-Type': 'application/json' }); res.end(body); return;
  }
  if (path.startsWith('/data/')) {
    const file = resolve(GAME, '.' + path.slice(5));
    if (!inside(GAME, file)) { res.writeHead(403, ISOLATION); res.end(); return; }
    return sendFile(req, res, file);
  }
  if (OVERLAY && path.startsWith('/host/')) {
    const file = resolve(OVERLAY, '.' + path.slice(5));
    try { if (inside(OVERLAY, file) && statSync(file).isFile()) return sendFile(req, res, file); } catch { /* not overlaid */ }
  }
  for (const [prefix, dir] of Object.entries(MOUNTS)) {
    if (!path.startsWith(prefix)) continue;
    const file = resolve(dir, '.' + path.slice(prefix.length - 1));
    if (!inside(dir, file)) { res.writeHead(403, ISOLATION); res.end(); return; }
    return sendFile(req, res, file);
  }
  res.writeHead(404, ISOLATION); res.end();
});
srv.listen(PORT, '127.0.0.1', () => {
  console.log(`ATV 2 dev server: http://127.0.0.1:${srv.address().port}/  ` +
    `(${GAME ? `dev game folder ${GAME} at /data/` : 'no /data/: the page imports the player\'s game folder'}, log ${LOG})`);
});
