// Local dev server for the browser build. Node only, no packages.
//
//   node web/host/serve.mjs [--game <folder>] [--port 8460] [--log <file>] [--overlay <dir>]
//
// Binds 127.0.0.1 only. Sends COOP/COEP (+CORP) so the page is cross-origin
// isolated (SharedArrayBuffer, shared WebAssembly.Memory), on every response
// (Firefox checks them on Worker scripts too). Caching: the page, its scripts
// and the module are "no-cache" with an ETag, so the browser revalidates
// (304, nothing re-sent) and edits still show on reload; a cached module
// response is what lets Chromium keep V8's compiled code for it (code cache).
// The module is also sent brotli-compressed (about 22 -> 2.5 MB) when the
// browser asks for br: <name>.wasm.br is made next to it in the background
// (Node's zlib) and remade when the .wasm changes. --no-compress turns that
// off. Game files (/data/) are never cached by the browser. Serves:
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
import { readFile, writeFile, rename } from 'node:fs/promises';
import { brotliCompress, constants as zc } from 'node:zlib';
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
const COMPRESS = !process.argv.includes('--no-compress');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.wgsl': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' };
// Page, scripts, module: revalidated every time (see the top).
const CACHED = { ...ISOLATION, 'Cache-Control': 'no-cache' };

// <file>.wasm.br, made once per .wasm version (brotli quality 11 takes ~25 s
// for the game module, in zlib's thread pool; until it is there the module
// goes out uncompressed).
const brPending = new Set();
function brotliFor(file, st) {
  const br = file + '.br';
  try { const b = statSync(br); if (b.mtimeMs >= st.mtimeMs) return { file: br, size: b.size }; } catch { /* not yet */ }
  if (!brPending.has(file)) {
    brPending.add(file);
    readFile(file).then((buf) => new Promise((res, rej) => brotliCompress(buf, { params: {
      [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length } }, (e, out) => (e ? rej(e) : res(out)))))
      .then((out) => writeFile(br + '.tmp', out).then(() => rename(br + '.tmp', br)))
      .then(() => console.log(`compressed ${relative(ROOT, file)} -> ${relative(ROOT, br)}`))
      .catch((e) => console.log(`brotli ${file}: ${e.message}`))
      .finally(() => brPending.delete(file));
  }
  return null;
}

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

// cache: false for game data (no-store), true for the page and the module
// (no-cache + ETag/Last-Modified, 304 when unchanged).
function sendFile(req, res, file, cache = false) {
  let st;
  try { st = statSync(file); } catch { res.writeHead(404, ISOLATION); res.end(); return; }
  if (!st.isFile()) { res.writeHead(404, ISOLATION); res.end(); return; }
  const ext = extname(file).toLowerCase();
  const type = TYPES[ext] ?? 'application/octet-stream';
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  // brotli for the module, whole-file requests only (a Range is of the plain bytes).
  const br = cache && COMPRESS && ext === '.wasm' && !m && /\bbr\b/.test(req.headers['accept-encoding'] ?? '') ? brotliFor(file, st) : null;
  const base = cache ? { ...CACHED, 'Last-Modified': new Date(st.mtimeMs).toUTCString(), Vary: 'Accept-Encoding' } : { ...ISOLATION };
  if (cache) {
    const tag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${br ? '-br' : ''}"`;
    base.ETag = tag;
    if (!m && (req.headers['if-none-match'] ?? '').split(/\s*,\s*/).includes(tag)) { res.writeHead(304, base); res.end(); return; }
  }
  if (m) {
    const start = Number(m[1]), end = Math.min(st.size - 1, m[2] ? Number(m[2]) : st.size - 1);
    if (start > end) { res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { ...base, 'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file, { start, end }).pipe(res);
  } else if (br) {
    res.writeHead(200, { ...base, 'Content-Type': type, 'Content-Encoding': 'br', 'Content-Length': br.size });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(br.file).pipe(res);
  } else {
    res.writeHead(200, { ...base, 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') { res.end(); return; }
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
    try { if (inside(OVERLAY, file) && statSync(file).isFile()) return sendFile(req, res, file, true); } catch { /* not overlaid */ }
  }
  for (const [prefix, dir] of Object.entries(MOUNTS)) {
    if (!path.startsWith(prefix)) continue;
    const file = resolve(dir, '.' + path.slice(prefix.length - 1));
    if (!inside(dir, file)) { res.writeHead(403, ISOLATION); res.end(); return; }
    return sendFile(req, res, file, true);
  }
  res.writeHead(404, ISOLATION); res.end();
});
// Start the module's compression at once rather than at the first request.
if (COMPRESS) { const p = join(MOUNTS['/wasm/'], 'atv2.wasm'); try { brotliFor(p, statSync(p)); } catch { /* not built yet */ } }
srv.listen(PORT, '127.0.0.1', () => {
  console.log(`ATV 2 dev server: http://127.0.0.1:${srv.address().port}/  ` +
    `(${GAME ? `dev game folder ${GAME} at /data/` : 'no /data/: the page imports the player\'s game folder'}, log ${LOG})`);
});
