// asset-server.mjs - the asset backend: serves an asset folder (manifest.json +
// objects/<aa>/<sha256>, as pipeline/build.mjs writes it) and, optionally, a
// static web root (the launcher). Node built-ins only.
//
//   node server/asset-server.mjs            (configured by environment, see config.mjs)
//
// Routes (ASSET_PREFIX defaults to /assets/):
//   GET  <prefix>manifest.json       the catalog: ETag, Cache-Control: no-cache
//   GET  <prefix>objects/<aa>/<sha>  a file by content: Range, ETag "<sha>",
//                                    Cache-Control: public, max-age=31536000, immutable;
//                                    redirected or proxied to ASSET_CDN_BASE when set
//   GET  <prefix>files/<path>        the same file by its logical path (no-cache)
//   GET  /healthz                    "ok"
//   R2 stand-in (ASSET_BUCKET_DIR): GET/HEAD/OPTIONS /<key> for the keys of
//   the upload plan only (latest.json, v/<version>/...), with the plan's
//   Cache-Control and Content-Type, an MD5 ETag as R2 gives, Range/If-Range,
//   no compression, and CORS (preflights too) from deploy/r2-cors.json.
//   GET  /<anything else>            WEB_DIR (static), if configured
// Only objects listed in the current manifest are served (the manifest is
// re-read when its file changes). Every response carries COOP/COEP/CORP.
// gzip/brotli (node:zlib) for compressible bodies without a Range header, so
// byte offsets of a resumed download always refer to the identity bytes.
//
// Refuses to start when the asset folder (or the web root) fails the scan
// (pipeline/verify-package.mjs --delivery --assets).
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream, readFileSync, statSync, realpathSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep, extname, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { gzipSync, brotliCompressSync, constants as Z } from 'node:zlib';
import { loadConfig, isLoopback } from './config.mjs';
import { RateLimiter } from './ratelimit.mjs';
import { verifyPackage } from '../pipeline/verify-package.mjs';

const WEB_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|wasm|manifest\+json)|image\/svg)/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/**
 * The URL path -> safe segments, or an HttpError. Rejects anything that could
 * escape the root: dot segments (also encoded), backslashes, encoded slashes,
 * NUL and control characters, empty segments, dotfiles, malformed escapes.
 */
export function safeSegments(rawPath) {
  if (rawPath.length > 1024) throw new HttpError(414, 'path too long');
  if (/%2f|%5c|%00|\\/i.test(rawPath)) throw new HttpError(400, 'encoded slash, backslash or NUL in path');
  let p;
  try { p = decodeURIComponent(rawPath); } catch { throw new HttpError(400, 'malformed path'); }
  if (/[\x00-\x1f\x7f]/.test(p)) throw new HttpError(400, 'control character in path');
  const segs = p.split('/').slice(1);
  if (segs.length && segs[segs.length - 1] === '') segs.pop();     // trailing slash
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') throw new HttpError(400, 'empty or dot segment in path');
    if (s.startsWith('.')) throw new HttpError(404, 'not found');
    if (!SEGMENT.test(s)) throw new HttpError(400, 'unexpected character in path');
  }
  return segs;
}

/** abs must be inside root, also after resolving links. */
function inside(root, abs) {
  const r = resolve(root), a = resolve(abs);
  if (a !== r && !a.startsWith(r + sep)) return false;
  try { const real = realpathSync(a); const realRoot = realpathSync(r); return real === realRoot || real.startsWith(realRoot + sep); }
  catch { return true; /* missing: the caller's stat says 404 */ }
}

/** Parse one "bytes=" range against size: { start, end } | 'unsatisfiable' | null (ignore: serve 200). */
export function parseRange(h, size) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return null;                     // multiple ranges or another unit: whole body
  let start, end;
  if (m[1] === '') {                       // suffix: last N bytes
    if (m[2] === '') return null;
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null;
  }
  if (start >= size || size === 0) return 'unsatisfiable';
  return { start, end };
}

function securityHeaders(cfg, kind) {
  const h = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': kind === 'asset' ? cfg.assetCorp : 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (kind === 'html') {
    h['content-security-policy'] = cfg.csp;
    h['x-frame-options'] = 'DENY';
  }
  return h;
}

/** Small LRU of compressed bodies: key -> Buffer. */
class Lru {
  constructor(maxBytes) { this.max = maxBytes; this.map = new Map(); this.bytes = 0; }
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) {
    if (v.length > this.max / 4) return;
    this.map.set(k, v); this.bytes += v.length;
    for (const [ok, ov] of this.map) { if (this.bytes <= this.max) break; this.map.delete(ok); this.bytes -= ov.length; }
  }
}

export function pickEncoding(accept) {
  const a = String(accept ?? '').toLowerCase();
  const has = (e) => new RegExp(`(^|,)\\s*${e}\\s*(;\\s*q=(?!0(\\.0*)?\\s*(,|$))[\\d.]+)?\\s*(,|$)`).test(a);
  if (has('br')) return 'br';
  if (has('gzip')) return 'gzip';
  return null;
}

/** Scan a folder before serving it; returns the problems (empty = clean). */
export function scanServed(cfg) {
  const out = [];
  if (cfg.bucketDir) {
    const r = verifyPackage(cfg.bucketDir, { quiet: true, delivery: true, r2: true });
    out.push(...r.problems.map((p) => ({ dir: cfg.bucketDir, ...p })));
  }
  if (cfg.assetDir) {
    const r = verifyPackage(cfg.assetDir, { quiet: true, delivery: true, assets: true });
    out.push(...r.problems.map((p) => ({ dir: cfg.assetDir, ...p })));
  }
  if (cfg.webDir) {
    const r = verifyPackage(cfg.webDir, { quiet: true, delivery: true });
    out.push(...r.problems.map((p) => ({ dir: cfg.webDir, ...p })));
  }
  return out;
}

export async function createAssetServer(overrides = {}, env = process.env) {
  const cfg = { ...loadConfig(env), ...overrides };
  if (!isLoopback(cfg.host) && !cfg.allowPublic)
    throw new Error(`refusing to bind ${cfg.host}: the asset server binds 127.0.0.1 unless ASSET_ALLOW_PUBLIC=1 (for a container behind a proxy)`);
  if (cfg.testHooks && !isLoopback(cfg.host)) throw new Error('ASSET_TEST_HOOKS is for local tests only (loopback bind)');
  if (!cfg.skipScan) {
    const problems = scanServed(cfg);
    if (problems.length) {
      const e = new Error(`refusing to serve: the scan failed\n${problems.map((p) => `  FAIL ${p.dir}: ${p.file}: ${p.why}`).join('\n')}`);
      e.problems = problems;
      throw e;
    }
  }

  // ---- manifest (re-read when the file changes) ----------------------------------
  let man = null;
  function manifest() {
    if (!cfg.assetDir) return null;
    const file = join(cfg.assetDir, 'manifest.json');
    let st;
    try { st = statSync(file); } catch { return null; }
    if (!man || man.mtimeMs !== st.mtimeMs || man.size !== st.size) {
      const body = readFileSync(file);
      const j = JSON.parse(body.toString('utf8'));
      man = { mtimeMs: st.mtimeMs, size: st.size, body, json: j, etag: `"m-${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`,
        byUrl: new Map(j.files.map((e) => [e.url, e])), byPath: new Map(j.files.map((e) => [e.path, e])) };
    }
    return man;
  }

  // ---- stats and test hooks ----------------------------------------------------
  const stats = { requests: 0, bodyBytes: 0, byKind: {}, log: [] };
  const hooks = { cut: new Map(), corrupt: new Map(), throttleKBps: 0 };
  const count = (kind, path, status, bytes, extra = {}) => {
    stats.bodyBytes += bytes;
    const k = (stats.byKind[kind] ??= { requests: 0, bytes: 0 });
    k.requests++; k.bytes += bytes;
    if (stats.log.length < 5000) stats.log.push({ t: Date.now(), kind, path, status, bytes, ...extra });
  };

  const limiter = new RateLimiter({ rate: cfg.rateRps, burst: cfg.rateBurst });
  const compressed = new Lru(cfg.compressCacheBytes);

  function clientKey(req) {
    if (cfg.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xf.length) return xf[xf.length - cfg.trustProxyHops] ?? xf[0];
    }
    return req.socket.remoteAddress ?? '?';
  }

  // ---- sending -------------------------------------------------------------------
  /** Send a file or buffer with ETag / Range / compression. */
  function sendBody(req, res, { kind, logPath, abs, buf, size, etag, type, cache, compress, sha, corpKind, base = null }) {
    const head = req.method === 'HEAD';
    const headers = { ...(base ?? securityHeaders(cfg, corpKind)), 'content-type': type, 'cache-control': cache, 'accept-ranges': 'bytes', etag, ...(base ? {} : { vary: 'Accept-Encoding' }) };
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*' || t === etag.replace(/"$/, '.br"') || t === etag.replace(/"$/, '.gz"'))) {
      res.writeHead(304, headers); res.end(); count(kind, logPath, 304, 0); return;
    }
    let range = parseRange(req.headers.range, size);
    const ifRange = req.headers['if-range'];
    if (range && ifRange && ifRange.trim() !== etag) range = null;   // changed since: whole body
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }); res.end(); count(kind, logPath, 416, 0); return;
    }
    // Compression: whole bodies only, when the type compresses and it helps.
    // (a corrupt-test hook serves identity bytes: it simulates a damaged file, not a broken stream)
    const enc = !range && compress && cfg.compress && size >= 1024 && !(sha && hooks.corrupt.has(sha)) ? pickEncoding(req.headers['accept-encoding']) : null;
    if (enc) {
      const key = `${etag}|${enc}`;
      let body = compressed.get(key);
      if (!body) {
        const raw = buf ?? readFileSync(abs);
        body = enc === 'br' ? brotliCompressSync(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: raw.length > (1 << 20) ? 5 : 9, [Z.BROTLI_PARAM_SIZE_HINT]: raw.length } })
          : gzipSync(raw, { level: 6 });
        compressed.set(key, body);
      }
      if (body.length < size * 0.95) {
        headers['content-encoding'] = enc;
        headers.etag = etag.replace(/"$/, enc === 'br' ? '.br"' : '.gz"');
        headers['content-length'] = body.length;
        res.writeHead(200, headers);
        if (head) { res.end(); count(kind, logPath, 200, 0); return; }
        return pipeOut(req, res, kind, logPath, 200, sha, Buffer.from(body), 0, { encoding: enc, identity: size });
      }
    }
    let status = 200, start = 0, end = size - 1;
    if (range) {
      status = 206; start = range.start; end = range.end;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = end - start + 1;
    res.writeHead(status, headers);
    if (head || size === 0) { res.end(); count(kind, logPath, status, 0); return; }
    const src = buf ? buf.subarray(start, end + 1) : createReadStream(abs, { start, end });
    return pipeOut(req, res, kind, logPath, status, sha, src, start, { range: range ? `${start}-${end}` : undefined });
  }

  /** Stream a body out, counting bytes; applies the test hooks (cut, corrupt, throttle). */
  function pipeOut(req, res, kind, logPath, status, sha, src, offset, extra) {
    let sent = 0, cutDone = false;
    // test hook: cut the connection after N bytes (one N per request, in order)
    const cuts = sha && hooks.cut.get(sha);
    const cutAt = cuts?.length ? cuts.shift() : undefined;
    if (cuts && !cuts.length) hooks.cut.delete(sha);
    const corrupt = sha && hooks.corrupt.get(sha);
    if (corrupt) { if (--corrupt.left <= 0) hooks.corrupt.delete(sha); }
    const kbps = hooks.throttleKBps;
    const t = new Transform({
      transform(chunk, _e, cb) {
        if (corrupt) { chunk = Buffer.from(chunk); for (let i = 0; i < chunk.length; i += 4096) chunk[i] ^= 0x5a; }
        if (cutDone) return cb();
        if (cutAt !== undefined && sent + chunk.length >= cutAt) {
          cutDone = true;
          const part = chunk.subarray(0, Math.max(0, cutAt - sent));
          sent += part.length;
          res.write(part, () => { count(kind, logPath, status, sent, { ...extra, cut: true }); res.socket?.destroy(); });
          return cb();
        }
        sent += chunk.length;
        if (kbps > 0) setTimeout(() => cb(null, chunk), (chunk.length / 1024 / kbps) * 1000); else cb(null, chunk);
      },
    });
    let done = false;
    const finish = () => { if (!done && cutAt === undefined) { done = true; count(kind, logPath, status, sent, extra); } };
    res.on('finish', finish);
    res.on('close', () => { if (!done && cutAt === undefined) { done = true; count(kind, logPath, status, sent, { ...extra, aborted: !res.writableFinished }); } });
    if (Buffer.isBuffer(src)) { t.pipe(res); t.end(src); }
    else { src.on('error', () => res.destroy()); src.pipe(t).pipe(res); }
  }

  function proxy(req, res, target, e) {
    const u = new URL(target);
    const fwd = {};
    for (const k of ['range', 'if-range', 'if-none-match', 'accept-encoding']) if (req.headers[k]) fwd[k] = req.headers[k];
    const rq = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: req.method, headers: fwd, timeout: 30000 }, (up) => {
      const h = { ...securityHeaders(cfg, 'asset') };
      for (const k of ['content-type', 'content-length', 'content-range', 'content-encoding', 'etag', 'cache-control', 'accept-ranges', 'last-modified', 'vary'])
        if (up.headers[k]) h[k] = up.headers[k];
      res.writeHead(up.statusCode ?? 502, h);
      let n = 0;
      up.on('data', (c) => { n += c.length; });
      up.on('end', () => count('object', e.path, up.statusCode, n, { via: 'proxy' }));
      up.pipe(res);
    });
    rq.on('timeout', () => rq.destroy(new Error('upstream timeout')));
    rq.on('error', (err) => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain', ...securityHeaders(cfg, 'asset') }); res.end(`upstream: ${err.message}\n`); }
      else res.destroy();
    });
    rq.end();
  }

  function fail(res, status, msg, extra = {}) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders(cfg, 'other'), ...extra });
    res.end(`${msg}\n`);
  }

  // ---- routes ----------------------------------------------------------------------
  const prefixSegs = cfg.assetPrefix.split('/').filter(Boolean);

  async function handle(req, res) {
    stats.requests++;
    const key = clientKey(req);
    const wait = limiter.take(key);
    if (wait > 0) { count('limited', req.url, 429, 0); return fail(res, 429, 'too many requests', { 'retry-after': String(Math.ceil(wait / 1000)) }); }
    if (cfg.bucketDir && !(cfg.testHooks && req.url.startsWith('/__test/'))) return bucket(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
    const q = req.url.indexOf('?');
    const rawPath = q >= 0 ? req.url.slice(0, q) : req.url;
    const search = q >= 0 ? req.url.slice(q) : '';
    if (!rawPath.startsWith('/')) return fail(res, 400, 'bad request');
    const segs = safeSegments(rawPath);

    if (segs.length === 1 && segs[0] === 'healthz') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end('ok\n'); }
    if (cfg.testHooks && segs[0] === '__test') return testHook(segs[1], new URLSearchParams(search), req, res);

    const isAsset = cfg.assetDir && prefixSegs.every((s, i) => segs[i] === s);
    if (isAsset) return asset(req, res, segs.slice(prefixSegs.length));
    if (cfg.webDir) return web(req, res, segs);
    return fail(res, 404, 'not found');
  }

  function asset(req, res, rest) {
    const m = manifest();
    if (!m) return fail(res, 503, 'no manifest.json in the asset folder');
    if (rest.length === 1 && rest[0] === 'manifest.json') {
      return sendBody(req, res, { kind: 'manifest', logPath: 'manifest.json', buf: m.body, size: m.body.length, etag: m.etag,
        type: 'application/json', cache: 'no-cache', compress: true, corpKind: 'asset' });
    }
    let e = null, contentAddressed = false;
    if (rest[0] === 'objects' && rest.length === 3) { e = m.byUrl.get(rest.join('/')); contentAddressed = true; }
    else if (rest[0] === 'files' && rest.length >= 2) e = m.byPath.get(rest.slice(1).join('/'));
    if (!e) return fail(res, 404, 'not found');
    if (cfg.cdnBase && contentAddressed) {
      const target = new URL(e.url, cfg.cdnBase).href;
      if (cfg.cdnMode === 'proxy') return proxy(req, res, target, e);
      res.writeHead(302, { location: target, 'cache-control': 'no-store', ...securityHeaders(cfg, 'asset') });
      count('redirect', e.path, 302, 0);
      return res.end();
    }
    const abs = join(cfg.assetDir, ...e.url.split('/'));
    if (!inside(cfg.assetDir, abs)) return fail(res, 404, 'not found');
    let st;
    try { st = lstatSync(abs); } catch { return fail(res, 404, 'not found'); }
    if (!st.isFile() || st.size !== e.size) return fail(res, 500, `object ${e.url} does not match the manifest`);
    return sendBody(req, res, { kind: 'object', logPath: e.path, abs, size: e.size, etag: `"${e.sha256}"`, type: e.type ?? 'application/octet-stream',
      cache: contentAddressed ? 'public, max-age=31536000, immutable' : 'no-cache', compress: !!e.compress, sha: e.sha256, corpKind: 'asset' });
  }

  function web(req, res, segs) {
    let abs = join(cfg.webDir, ...segs);
    if (!inside(cfg.webDir, abs)) return fail(res, 404, 'not found');
    let st;
    try { st = lstatSync(abs); } catch { return fail(res, 404, 'not found'); }
    if (st.isSymbolicLink()) return fail(res, 404, 'not found');
    if (st.isDirectory()) {
      if (!req.url.split('?')[0].endsWith('/')) {
        res.writeHead(301, { location: req.url.split('?')[0] + '/', ...securityHeaders(cfg, 'other') }); return res.end();
      }
      abs = join(abs, 'index.html');
      try { st = lstatSync(abs); } catch { return fail(res, 404, 'not found'); }
    }
    if (!st.isFile()) return fail(res, 404, 'not found');
    const ext = extname(abs).toLowerCase();
    const type = WEB_TYPES[ext] ?? 'application/octet-stream';
    const etag = `"w-${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const extra = segs[segs.length - 1] === 'sw.js' ? { 'service-worker-allowed': '/' } : {};
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    return sendBody(req, res, { kind: 'web', logPath: segs.join('/') || 'index.html', abs, size: st.size, etag, type, cache: 'no-cache',
      compress: COMPRESSIBLE.test(type), corpKind: type.startsWith('text/html') ? 'html' : 'other' });
  }

  // ---- R2 stand-in ------------------------------------------------------------------
  let bk = null;
  function bucketState() {
    const planFile = cfg.bucketPlan ?? join(cfg.bucketDir, '..', 'r2-upload-plan.json');
    const st = statSync(planFile);
    if (!bk || bk.mtimeMs !== st.mtimeMs) {
      const plan = JSON.parse(readFileSync(planFile, 'utf8'));
      const corsFile = cfg.bucketCors ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'r2-cors.json');
      const rules = JSON.parse(readFileSync(corsFile, 'utf8')).rules.map((r) => ({ ...r, allowed: { ...r.allowed, origins: [...r.allowed.origins, ...cfg.bucketCorsOrigins] } }));
      const byKey = new Map();
      for (const o of plan.objects) {
        const abs = join(cfg.bucketDir, ...o.key.split('/'));
        if (!inside(cfg.bucketDir, abs)) continue;
        const body = readFileSync(abs);
        byKey.set(o.key, { ...o, abs, md5: createHash('md5').update(body).digest('hex'),
          logPath: o.key === 'latest.json' ? 'latest.json' : o.key.replace(/^v\/[^/]+\//, '') });
      }
      bk = { mtimeMs: st.mtimeMs, plan, rules, byKey };
    }
    return bk;
  }
  /** The CORS rule that allows this origin and method (first match, as R2). */
  const corsRule = (rules, origin, method) => rules.find((r) => r.allowed.origins.includes(origin) && r.allowed.methods.includes(method)) ?? null;
  function bucket(req, res) {
    const b = bucketState();
    let key;
    try { key = safeSegments(req.url.split('?')[0]).join('/'); } catch (e) { return fail(res, e.status ?? 400, e.message); }
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      const want = String(req.headers['access-control-request-headers'] ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
      const rule = origin && method ? corsRule(b.rules, origin, method) : null;
      const allowedHeaders = new Set((rule?.allowed.headers ?? []).map((h) => h.toLowerCase()));
      if (!rule || !want.every((h) => allowedHeaders.has(h))) {
        count('preflight', key, 403, 0, { origin, method, headers: want.join(',') });
        res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('CORS preflight refused\n');
      }
      count('preflight', key, 204, 0, { origin, method, headers: want.join(',') });
      res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': rule.allowed.methods.join(', '),
        'access-control-allow-headers': want.join(', '), 'access-control-max-age': String(rule.maxAgeSeconds ?? 0), vary: 'Origin' });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed', { allow: 'GET, HEAD, OPTIONS' });
    const o = b.byKey.get(key);
    const base = {};
    const rule = origin ? corsRule(b.rules, origin, req.method) : null;
    if (rule) Object.assign(base, { 'access-control-allow-origin': origin, 'access-control-expose-headers': (rule.exposeHeaders ?? []).join(', '), vary: 'Origin' });
    if (!o) { count('missing', key, 404, 0); res.writeHead(404, { ...base, 'content-type': 'text/plain' }); return res.end('not found\n'); }
    let st;
    try { st = lstatSync(o.abs); } catch { return fail(res, 404, 'not found'); }
    if (!st.isFile() || st.size !== o.size) return fail(res, 500, `object ${o.key} does not match the plan`);
    const kind = o.key === 'latest.json' ? 'pointer' : o.key.endsWith('/manifest.json') ? 'manifest' : 'object';
    return sendBody(req, res, { kind, logPath: o.logPath, abs: o.abs, size: o.size, etag: `"${o.md5}"`, type: o.contentType, cache: o.cacheControl,
      compress: false, sha: o.sha256, base });
  }

  function testHook(what, qs, req, res) {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (what === 'stats') {
      const out = JSON.parse(JSON.stringify(stats));
      if (qs.get('reset')) { stats.requests = 0; stats.bodyBytes = 0; stats.byKind = {}; stats.log = []; }
      return json(out);
    }
    const m = manifest();
    const sha = qs.get('sha') ?? m?.byPath.get(qs.get('path') ?? '')?.sha256 ??
      (cfg.bucketDir ? [...bucketState().byKey.values()].find((o) => o.logPath === qs.get('path'))?.sha256 : undefined);
    if (what === 'cut') { hooks.cut.set(sha, String(qs.get('after') ?? '0').split(',').map(Number)); return json({ ok: !!sha, sha }); }
    if (what === 'corrupt') { hooks.corrupt.set(sha, { left: Number(qs.get('count') ?? 1) }); return json({ ok: !!sha, sha }); }
    if (what === 'throttle') { hooks.throttleKBps = Number(qs.get('kBps') ?? 0); return json({ ok: true, kBps: hooks.throttleKBps }); }
    if (what === 'clear') { hooks.cut.clear(); hooks.corrupt.clear(); hooks.throttleKBps = 0; return json({ ok: true }); }
    return fail(res, 404, 'no such hook');
  }

  const server = createServer((req, res) => {
    try {
      const r = handle(req, res);
      if (r?.catch) r.catch((e) => fail(res, e.status ?? 500, e.status ? e.message : 'internal error'));
    } catch (e) {
      if (!e.status) console.error(e);
      fail(res, e.status ?? 500, e.status ? e.message : 'internal error');
    }
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 15000;
  server.requestTimeout = 60000;
  await new Promise((r, j) => { server.once('error', j); server.listen(cfg.port, cfg.host, r); });
  const addr = server.address();
  return {
    cfg, server, stats, limiter,
    url: `http://${addr.family === 'IPv6' ? `[${addr.address}]` : addr.address}:${addr.port}`,
    close: () => new Promise((r) => { limiter.stop(); server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const s = await createAssetServer();
    const c = s.cfg;
    console.log(`asset server on ${s.url} (${c.bucketDir ? `R2 stand-in for ${c.bucketDir}; ` : ''}assets ${c.assetDir ?? '-'} at ${c.assetPrefix}${c.cdnBase ? `, objects via ${c.cdnMode} to ${c.cdnBase}` : ''}` +
      `${c.webDir ? `, web ${c.webDir}` : ''}; rate ${c.rateRps}/s burst ${c.rateBurst}${c.testHooks ? '; TEST HOOKS ON' : ''})`);
    const stop = () => { s.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (e) {
    console.error(`asset server: ${e.message}`);
    process.exit(1);
  }
}

