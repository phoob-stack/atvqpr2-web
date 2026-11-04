// The asset server: ranges, ETags, caching, compression, security headers,
// path traversal, rate limiting, CDN redirect/proxy, start-up refusals.
//   node --test test/server.test.mjs      (127.0.0.1:8855-8857)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createAssetServer, parseRange, pickEncoding, safeSegments } from '../server/asset-server.mjs';
import { writeLayout } from '../pipeline/manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.test', 'unit-server');
const ASSETS = join(TMP, 'assets'), WEB = join(TMP, 'web'), SRC = join(TMP, 'src');
let srv, man;
const BIG = Buffer.alloc(300000);
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 7) & 255;            // compressible
const NOISE = Buffer.alloc(100000);
for (let i = 0; i < NOISE.length; i += 32) createHash("sha256").update(String(i)).digest().copy(NOISE, i);  // not compressible

function get(path, headers = {}, { port = 8856, method = 'GET' } = {}) {
  return new Promise((res, rej) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (resp) => {
      const parts = [];
      resp.on('data', (c) => parts.push(c));
      resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(parts) }));
    });
    r.on('error', rej);
    r.end();
  });
}
const obj = (path) => `/assets/${man.files.find((f) => f.path === path).url}`;

before(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true }); mkdirSync(WEB, { recursive: true });
  writeFileSync(join(SRC, 'big.bin'), BIG);
  writeFileSync(join(SRC, 'noise.bin'), NOISE);
  writeFileSync(join(SRC, 'hello.json'), JSON.stringify({ hello: 'world'.repeat(400) }));
  writeFileSync(join(WEB, 'index.html'), '<!doctype html><title>t</title><p>hi</p>\n');
  writeFileSync(join(WEB, 'app.js'), 'export const x = 1;\n'.repeat(200));
  writeFileSync(join(TMP, 'secret.txt'), 'outside the roots\n');
  man = writeLayout(ASSETS, [{ path: 'big.bin', abs: join(SRC, 'big.bin') }, { path: 'noise.bin', abs: join(SRC, 'noise.bin') },
    { path: 'data/hello.json', abs: join(SRC, 'hello.json') }], { title: 'unit', chunkSize: 65536 });
  srv = await createAssetServer({ port: 8856, assetDir: ASSETS, webDir: WEB, rateRps: 0 }, {});
});
after(async () => { await srv?.close(); rmSync(TMP, { recursive: true, force: true }); });

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.equal(parseRange('bytes=9-1', 100), null);
});

test('pickEncoding', () => {
  assert.equal(pickEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(pickEncoding('gzip'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(undefined), null);
});

test('manifest: no-cache, ETag, 304, COOP/COEP/CORP', async () => {
  const r = await get('/assets/manifest.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(r.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(JSON.parse(r.body).files.length, 3);
  const again = await get('/assets/manifest.json', { 'if-none-match': r.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
});

test('object: immutable, ETag = sha256, full body, HEAD', async () => {
  const r = await get(obj('big.bin'));
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(r.headers.etag, `"${man.files.find((f) => f.path === 'big.bin').sha256}"`);
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.ok(r.body.equals(BIG));
  const h = await get(obj('big.bin'), {}, { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(Number(h.headers['content-length']), BIG.length);
  assert.equal(h.body.length, 0);
  const n = await get(obj('big.bin'), { 'if-none-match': r.headers.etag });
  assert.equal(n.status, 304);
});

test('Range: 206 with the right bytes, suffix, If-Range, 416, multi-range', async () => {
  const r = await get(obj('big.bin'), { range: 'bytes=1000-1999', 'accept-encoding': 'br' });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 1000-1999/${BIG.length}`);
  assert.equal(r.headers['content-encoding'], undefined, 'ranges are never compressed');
  assert.ok(r.body.equals(BIG.subarray(1000, 2000)));
  const s = await get(obj('big.bin'), { range: 'bytes=-100' });
  assert.ok(s.body.equals(BIG.subarray(BIG.length - 100)));
  const etag = `"${man.files.find((f) => f.path === 'big.bin').sha256}"`;
  const ok = await get(obj('big.bin'), { range: 'bytes=10-19', 'if-range': etag });
  assert.equal(ok.status, 206);
  const stale = await get(obj('big.bin'), { range: 'bytes=10-19', 'if-range': '"something-else"' });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.length, BIG.length);
  const bad = await get(obj('big.bin'), { range: `bytes=${BIG.length}-` });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers['content-range'], `bytes */${BIG.length}`);
  const multi = await get(obj('big.bin'), { range: 'bytes=0-1,5-6' });
  assert.equal(multi.status, 200);
});

test('compression: br / gzip where it helps, identity otherwise', async () => {
  const br = await get(obj('big.bin'), { 'accept-encoding': 'gzip, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.ok(br.body.length < BIG.length / 4);
  assert.ok(brotliDecompressSync(br.body).equals(BIG));
  assert.match(br.headers.vary, /accept-encoding/i);
  assert.notEqual(br.headers.etag, `"${man.files.find((f) => f.path === 'big.bin').sha256}"`, 'the encoded body has its own ETag');
  const gz = await get(obj('big.bin'), { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.ok(gunzipSync(gz.body).equals(BIG));
  const noise = await get(obj('noise.bin'), { 'accept-encoding': 'br' });
  assert.equal(noise.headers['content-encoding'], undefined, 'random bytes are not marked compressible by the pipeline');
  const js = await get('/app.js', { 'accept-encoding': 'br' });
  assert.equal(js.headers['content-encoding'], 'br');
});

test('logical paths (files/<path>) map through the manifest, no-cache', async () => {
  const r = await get('/assets/files/data/hello.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(JSON.parse(r.body).hello.length, 2000);
  assert.equal((await get('/assets/files/data/nope.json')).status, 404);
});

test('web root: index, CSP on HTML, directory redirect', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal((await get('/index.html')).status, 200);
  assert.equal((await get('/healthz')).status, 200);
});

test('path traversal and odd paths never escape the roots', async () => {
  const attempts = ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt',
    '/assets/objects/..%2f..%2f..%2fsecret.txt', '/..%5csecret.txt', '/%252e%252e/secret.txt', '/assets/objects/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/.%2e/secret.txt', '/assets/..\\..\\secret.txt', '/%00', '/a%00b', '/.git/config', '/.env', '//secret.txt', '/assets//manifest.json',
    '/assets/objects/00/' + '0'.repeat(64), '/assets/manifest.json/..', '/%ZZ', `/${'a/'.repeat(600)}`, '/C:/Windows/win.ini', '/assets/objects'];
  for (const p of attempts) {
    const r = await get(p);
    assert.ok([400, 404, 414].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!r.body.toString().includes('outside the roots'), `${p} leaked a file`);
  }
  assert.throws(() => safeSegments('/a/../b'), /dot segment/);
  assert.throws(() => safeSegments('/a%2fb'), /encoded slash/);
  assert.deepEqual(safeSegments('/assets/objects/ab/cd'), ['assets', 'objects', 'ab', 'cd']);
});

test('only GET and HEAD', async () => {
  const r = await get('/assets/manifest.json', {}, { method: 'POST' });
  assert.equal(r.status, 405);
  assert.equal((await get('/', {}, { method: 'DELETE' })).status, 405);
});

test('an object on disk but not in the manifest is not served', async () => {
  const extra = join(ASSETS, 'objects', 'ff', 'f'.repeat(64));
  mkdirSync(dirname(extra), { recursive: true });
  writeFileSync(extra, 'sneaky');
  try { assert.equal((await get(`/assets/objects/ff/${'f'.repeat(64)}`)).status, 404); }
  finally { rmSync(dirname(extra), { recursive: true, force: true }); }
});

test('rate limiting: 429 with Retry-After per client, others unaffected', async () => {
  const s = await createAssetServer({ port: 8857, assetDir: ASSETS, rateRps: 5, rateBurst: 5, trustProxy: true, trustProxyHops: 1 }, {});
  try {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await get('/assets/manifest.json', { 'x-forwarded-for': '203.0.113.7' }, { port: 8857 })).status);
    assert.equal(codes.filter((c) => c === 200).length, 5, codes.join(','));
    const limited = await get('/assets/manifest.json', { 'x-forwarded-for': '203.0.113.7' }, { port: 8857 });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal((await get('/assets/manifest.json', { 'x-forwarded-for': '198.51.100.9' }, { port: 8857 })).status, 200, 'another client');
  } finally { await s.close(); }
});

test('CDN: redirect and proxy (Range passes through)', async () => {
  const red = await createAssetServer({ port: 8855, assetDir: ASSETS, rateRps: 0, cdnBase: 'http://127.0.0.1:8856/assets/', cdnMode: 'redirect' }, {});
  try {
    const r = await get(obj('big.bin'), {}, { port: 8855 });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `http://127.0.0.1:8856${obj('big.bin')}`);
    assert.equal((await get('/assets/manifest.json', {}, { port: 8855 })).status, 200, 'the manifest stays local');
  } finally { await red.close(); }
  const prx = await createAssetServer({ port: 8855, assetDir: ASSETS, rateRps: 0, cdnBase: 'http://127.0.0.1:8856/assets/', cdnMode: 'proxy' }, {});
  try {
    const r = await get(obj('big.bin'), { range: 'bytes=5-14' }, { port: 8855 });
    assert.equal(r.status, 206);
    assert.ok(r.body.equals(BIG.subarray(5, 15)));
    assert.equal(r.headers['cross-origin-embedder-policy'], 'require-corp');
  } finally { await prx.close(); }
});

test('refuses a non-loopback bind unless allowed, and test hooks off loopback', async () => {
  await assert.rejects(createAssetServer({ host: '0.0.0.0', port: 8857, assetDir: ASSETS }, {}), /refusing to bind/);
  await assert.rejects(createAssetServer({ host: '0.0.0.0', allowPublic: true, testHooks: true, port: 8857, assetDir: ASSETS }, {}), /local tests only/);
});

test('refuses to start on an asset folder that fails the scan', async () => {
  const bad = join(TMP, 'bad-assets');
  const fake = join(TMP, 'atv2.wasm');
  writeFileSync(fake, Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(64)]));   // a made-up module header, not the game
  // writeLayout itself refuses the name...
  assert.throws(() => writeLayout(bad, [{ path: 'atv2.wasm', abs: fake }], { title: 'x' }), /named like the game module|forbidden file type/);
  // ...so plant it by hand, as someone copying files onto the server would.
  writeLayout(bad, [{ path: 'ok.bin', abs: join(SRC, 'noise.bin') }], { title: 'x' });
  const m = JSON.parse(readFileSync(join(bad, 'manifest.json'), 'utf8'));
  const sha = 'a'.repeat(64);
  m.files.push({ path: 'atv2.wasm', size: 72, sha256: sha, url: `objects/aa/${sha}`, type: 'application/wasm' });
  writeFileSync(join(bad, 'manifest.json'), JSON.stringify(m));
  mkdirSync(join(bad, 'objects', 'aa'), { recursive: true });
  writeFileSync(join(bad, 'objects', 'aa', sha), readFileSync(fake));
  await assert.rejects(createAssetServer({ port: 8857, assetDir: bad }, {}), (e) => {
    assert.match(e.message, /refusing to serve: the scan failed/);
    assert.match(e.message, /named like the game module/);
    assert.match(e.message, /not a declared artifact/);
    return true;
  });
  // and an undeclared wasm under an innocent name
  const bad2 = join(TMP, 'bad-assets-2');
  writeLayout(bad2, [{ path: 'level1.dat', abs: fake }], { title: 'x' });
  await assert.rejects(createAssetServer({ port: 8857, assetDir: bad2 }, {}), /wasm module that is not a declared artifact/);
});
