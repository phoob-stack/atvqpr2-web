// Unit tests for the wasi-sdk download path (lib/wasi-sdk.mjs), against local
// mirrors only: a 127.0.0.1 HTTP server and file:// URLs. Nothing is fetched
// from the internet.
//
//   ATV2_TEST_TMP=<scratch dir> node --test test/
//   ATV2_TEST_REAL_ARCHIVE=<path to wasi-sdk-34.0-x86_64-windows.tar.gz>  also
//     runs the whole download -> SHA-256 -> unpack -> clang --version path on
//     the real 590 MB archive (through the 127.0.0.1 mirror).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync, rmSync, createReadStream, statSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { ensureWasiSdk, fetchVerified, checkSdk, sdkDirName, ARCHIVES, hostKey } from '../lib/wasi-sdk.mjs';
import { run, sha256File, tarExe, probe, isWin } from '../lib/util.mjs';

const TMP = process.env.ATV2_TEST_TMP ? join(process.env.ATV2_TEST_TMP, `wasi-sdk-${process.pid}`) : mkdtempSync(join(os.tmpdir(), 'atv2-builder-test-'));
const KEY = 'x86_64-windows';            // the fake archive's name, whatever the host
const MIRROR_DIR = join(TMP, 'mirror');
let srv, base, fake;

function serveDir(dir) {
  const s = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.startsWith('/redirect/')) { res.writeHead(302, { Location: '/' + path.slice(10) }); res.end(); return; }
    const file = join(dir, basename(path));
    if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': statSync(file).size, 'Content-Type': 'application/gzip' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

before(async () => {
  mkdirSync(MIRROR_DIR, { recursive: true });
  // A tiny stand-in SDK with the real archive's layout.
  const stage = join(TMP, 'stage');
  const top = join(stage, sdkDirName(KEY));
  mkdirSync(join(top, 'bin'), { recursive: true });
  writeFileSync(join(top, 'VERSION'), '34.0\nwasi-libc: test\n');
  for (const b of ['clang', 'llvm-ar']) writeFileSync(join(top, 'bin', isWin ? `${b}.exe` : b), 'stand-in');
  const archive = join(MIRROR_DIR, `wasi-sdk-34.0-${KEY}.tar.gz`);
  assert.equal(await run(tarExe(), ['-c', '-z', '-f', archive, '-C', stage, sdkDirName(KEY)]), 0);
  fake = { file: basename(archive), size: statSync(archive).size, sha256: await sha256File(archive) };
  srv = await serveDir(MIRROR_DIR);
  base = `http://127.0.0.1:${srv.address().port}/`;
});
after(() => { srv?.close(); if (!process.env.ATV2_TEST_KEEP) rmSync(TMP, { recursive: true, force: true }); });

const fresh = (name) => { const d = join(TMP, name); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };
const quiet = () => {};

test('pinned table: the Windows archive is pinned, the others are TODO (null) and refused', () => {
  assert.match(ARCHIVES['x86_64-windows'].sha256, /^[0-9a-f]{64}$/);
  assert.equal(ARCHIVES['x86_64-windows'].size, 619003408);
  for (const k of ['x86_64-linux', 'arm64-linux', 'x86_64-macos', 'arm64-macos']) assert.equal(ARCHIVES[k].sha256, null);
  assert.equal(hostKey('win32', 'x64'), 'x86_64-windows');
  assert.equal(hostKey('darwin', 'arm64'), 'arm64-macos');
});

test('downloads from a 127.0.0.1 mirror, checks SHA-256, unpacks', async () => {
  const tc = fresh('tc-http');
  const r = await ensureWasiSdk({ toolchains: tc, mirror: base, confirm: async () => true, say: quiet, releases: { [KEY]: fake }, key: KEY, envDir: null });
  assert.equal(r.source, 'downloaded');
  assert.equal(r.dir, join(tc, sdkDirName(KEY)));
  assert.ok(checkSdk(r.dir).ok);
  assert.deepEqual(readdirSync(tc), [sdkDirName(KEY)], 'archive and scratch folders are removed');
  // second call finds it without asking
  const again = await ensureWasiSdk({ toolchains: tc, confirm: async () => { throw new Error('asked again'); }, say: quiet, releases: { [KEY]: fake }, key: KEY, envDir: null });
  assert.equal(again.source, 'toolchains');
});

test('follows redirects (as GitHub release downloads do)', async () => {
  const tc = fresh('tc-redirect');
  const r = await ensureWasiSdk({ toolchains: tc, mirror: base + 'redirect/', confirm: async () => true, say: quiet, releases: { [KEY]: fake }, key: KEY, envDir: null });
  assert.ok(checkSdk(r.dir).ok);
});

test('downloads from a file:// mirror', async () => {
  const tc = fresh('tc-file');
  const r = await ensureWasiSdk({ toolchains: tc, mirror: pathToFileURL(MIRROR_DIR).href, confirm: async () => true, say: quiet, releases: { [KEY]: fake }, key: KEY, envDir: null });
  assert.ok(checkSdk(r.dir).ok);
});

test('a wrong SHA-256 is rejected and leaves nothing behind', async () => {
  const tc = fresh('tc-badsha');
  const bad = { ...fake, sha256: '0'.repeat(64) };
  await assert.rejects(ensureWasiSdk({ toolchains: tc, mirror: base, confirm: async () => true, say: quiet, releases: { [KEY]: bad }, key: KEY, envDir: null }), /SHA-256 mismatch/);
  assert.deepEqual(readdirSync(tc), []);
});

test('a wrong size is rejected', async () => {
  const dest = join(fresh('tc-badsize'), 'x.tar.gz');
  await assert.rejects(fetchVerified(base + fake.file, dest, { size: fake.size + 1, sha256: fake.sha256 }), /expected/);
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(dest + '.part'), false);
});

test('a missing file (404) is an error', async () => {
  await assert.rejects(fetchVerified(base + 'nope.tar.gz', join(fresh('tc-404'), 'n'), { sha256: fake.sha256 }), /HTTP 404/);
});

test('no pinned SHA-256 -> no download, even when allowed', async () => {
  const tc = fresh('tc-nosha');
  await assert.rejects(ensureWasiSdk({ toolchains: tc, mirror: base, confirm: async () => true, say: quiet, releases: { [KEY]: { ...fake, sha256: null } }, key: KEY, envDir: null }), /no pinned SHA-256/);
  await assert.rejects(fetchVerified(base + fake.file, join(tc, 'x'), {}), /refusing/);
});

test('declined download -> error, nothing fetched', async () => {
  const tc = fresh('tc-declined');
  await assert.rejects(ensureWasiSdk({ toolchains: tc, mirror: base, confirm: async () => false, say: quiet, releases: { [KEY]: fake }, key: KEY, envDir: null }), /declined/);
  assert.deepEqual(readdirSync(tc), []);
});

test('--wasi-sdk <dir> is used as is and must be a wasi-sdk 34', async () => {
  const tc = fresh('tc-explicit');
  const r = await ensureWasiSdk({ toolchains: tc, mirror: base, confirm: async () => true, say: quiet, releases: { [KEY]: fake }, key: KEY, envDir: null });
  const g = await ensureWasiSdk({ explicit: r.dir, confirm: async () => { throw new Error('no'); }, say: quiet });
  assert.equal(g.source, 'given');
  writeFileSync(join(r.dir, 'VERSION'), '33.0\n');
  await assert.rejects(ensureWasiSdk({ explicit: r.dir, say: quiet }), /need 34\.0/);
  await assert.rejects(ensureWasiSdk({ explicit: join(tc, 'missing'), say: quiet }), /not found/);
});

test('real wasi-sdk 34 archive through the 127.0.0.1 mirror (ATV2_TEST_REAL_ARCHIVE)', { skip: !process.env.ATV2_TEST_REAL_ARCHIVE && 'set ATV2_TEST_REAL_ARCHIVE' }, async () => {
  const real = process.env.ATV2_TEST_REAL_ARCHIVE;
  const s = await serveDir(dirname(real));
  try {
    const tc = fresh('tc-real');
    const r = await ensureWasiSdk({ toolchains: tc, mirror: `http://127.0.0.1:${s.address().port}/`, confirm: async () => true,
      say: (m) => console.log(`# ${m}`), key: 'x86_64-windows', envDir: null });
    assert.equal(r.source, 'downloaded');
    const v = probe(r.clang, ['--version']);
    assert.ok(v.ok, v.out);
    assert.match(v.out, /clang version/);
    console.log(`# ${v.out.split('\n')[0]}`);
  } finally { s.close(); }
});
