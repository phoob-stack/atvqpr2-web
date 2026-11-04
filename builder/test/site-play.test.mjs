// verify-package.mjs --site (the project site's deploy scan) and lib/play.mjs (the play folder),
// against small made-up fixtures (no game data).
//   ATV2_TEST_TMP=<scratch dir> node --test test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { verifyPackage } from '../verify-package.mjs';
import { makePlayFolder, PlayError } from '../lib/play.mjs';

const TMP = process.env.ATV2_TEST_TMP ? join(process.env.ATV2_TEST_TMP, `siteplay-${process.pid}`) : mkdtempSync(join(os.tmpdir(), 'atv2-siteplay-test-'));
after(() => { if (!process.env.ATV2_TEST_KEEP) rmSync(TMP, { recursive: true, force: true }); });
const sha = (b) => createHash('sha256').update(b).digest('hex');
function fixture(name, files) {
  const d = join(TMP, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(d, rel)), { recursive: true }); writeFileSync(join(d, rel), body); }
  return d;
}
const why = (r) => r.problems.map((p) => `${p.file}: ${p.why}`).join('\n');
const PAGE = { 'play/host/main.js': 'export {};\n', 'play/gpu/encoder.js': 'const s = `@vertex fn vs() {}\n@fragment fn fs() {}`;\n' };
const SYNC = (files) => JSON.stringify({ files: Object.entries(files).map(([p, b]) => ({ path: p.replace(/^play\//, ''), size: Buffer.byteLength(b), sha256: sha(b) })) });
const SITE = { 'index.html': '<!doctype html><title>x</title>', '_headers': '/*\n  X: y\n', 'js/a.js': 'export {};\n', 'docs/x.md': '# doc\n',
  LICENSE: 'MIT', ...PAGE, 'play/sync.json': SYNC(PAGE) };

test('site: a clean site with its synced game page passes', () => {
  const r = verifyPackage(fixture('site-clean', SITE), { quiet: true, site: true });
  assert.ok(r.ok, why(r));
});

test('site: images, audio, video and archives are refused unless allowed by path', () => {
  const d = fixture('site-media', { ...SITE, 'img/title.png': 'x', 'a/b.ogg': 'x', 'c.webm': 'x', 'd.zip': 'x', 'e.svg': '<svg/>' });
  const w = why(verifyPackage(d, { quiet: true, site: true }));
  for (const f of ['img/title.png', 'a/b.ogg', 'c.webm', 'd.zip', 'e.svg']) assert.match(w, new RegExp(`${f.replace('.', '\\.')}: media or archive`));
  const r2 = verifyPackage(d, { quiet: true, site: true, allowMedia: ['img/title.png', 'a/b.ogg', 'c.webm', 'd.zip', 'e.svg'] });
  assert.ok(r2.ok, why(r2));
});

test('site: generated WGSL, shader dumps, base64 blobs and save files are refused', () => {
  const gen = 'struct VsC { c: array<vec4f, 192> };\n@group(0) @binding(1) var<uniform> K: VsC;\n';
  const dump = Array.from({ length: 6 }, (_, i) => `@fragment fn f${i}() {}`).join('\n');
  const r = verifyPackage(fixture('site-gen', { ...SITE, 'data/shaders.json': JSON.stringify({ a: gen }), 'x.txt': dump,
    'y.json': JSON.stringify({ tex: 'A'.repeat(20000) }), 'z.html': `<img src="data:image/png;base64,${'Q'.repeat(5000)}">`,
    'saves/Records': 'x', 'saves/SaveMeta.xbx': 'x' }), { quiet: true, site: true });
  const w = why(r);
  assert.match(w, /data\/shaders\.json: contains generated WGSL/);
  assert.match(w, /x\.txt: 6 WGSL entry points/);
  assert.match(w, /y\.json: a long base64 run/);
  assert.match(w, /z\.html: a large base64 data: URL/);
  assert.match(w, /saves\/Records: named like a save file/);
  assert.match(w, /saves\/SaveMeta\.xbx: named like a save file/);
});

test('site: play/ must be exactly what sync-play wrote', () => {
  const w = why(verifyPackage(fixture('site-play', { ...SITE, 'play/host/main.js': 'export const x = 1;\n', 'play/host/extra.js': '//\n' }), { quiet: true, site: true }));
  assert.match(w, /play\/host\/main\.js: changed since tools\/sync-play\.mjs wrote it/);
  assert.match(w, /play\/host\/extra\.js: in play\/ but not written by tools\/sync-play\.mjs/);
  const { 'play/sync.json': _, ...noSync } = SITE;
  assert.match(why(verifyPackage(fixture('site-nosync', noSync), { quiet: true, site: true })), /no play\/sync\.json/);
  const { 'play/gpu/encoder.js': __, ...missing } = SITE;
  assert.match(why(verifyPackage(fixture('site-missing', missing), { quiet: true, site: true })), /play\/gpu\/encoder\.js: listed in play\/sync\.json but missing/);
});

test('site: the package rules still apply (a wasm module, a 1 MB file)', () => {
  const w = why(verifyPackage(fixture('site-wasm', { ...SITE, 'play/atv2.wasm': Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    'js/big.js': Buffer.alloc(1024 * 1024 + 1, 32) }), { quiet: true, site: true }));
  assert.match(w, /play\/atv2\.wasm: forbidden file type \.wasm/);
  assert.match(w, /js\/big\.js: over 1 MB/);
});

// ---- the play folder ----------------------------------------------------------------------
const GAME = { 'default.xbe': 'XBEH-not-really', 'ATV.bah': 'bah', 'ATV.bad': 'bad', 'Movies/intro.xmv': 'mv', 'UDATA/4143000a/save': 's',
  'Thumbs.db': 't', 'atv2.wasm': 'a stray one' };
const info = { builder: '9.9.9', atvrecomp: 'a'.repeat(40), xboxrecomp: 'b'.repeat(40), wasiSdk: '34.0', reference: true };

test('play folder: game files linked, saves and system files left out, the build and manifest written', async () => {
  const game = fixture('pf-game', GAME);
  const work = fixture('pf-work', { 'atv2.wasm': 'MODULE', 'atv2.memory.json': '{"initialPages":2,"maximumPages":4,"shared":true}' });
  const dir = join(TMP, 'pf-play');
  rmSync(dir, { recursive: true, force: true });
  const r = await makePlayFolder({ dir, gameDir: game, game: { size: 15, sha256: 'x' }, wasm: join(work, 'atv2.wasm'),
    memoryJson: join(work, 'atv2.memory.json'), info });
  assert.equal(r.files, 4);
  assert.deepEqual(readdirSync(dir).sort(), ['ATV.bad', 'ATV.bah', 'Movies', 'atv2-build.json', 'atv2-play.txt', 'atv2.wasm', 'default.xbe']);
  assert.equal(readFileSync(join(dir, 'atv2.wasm'), 'utf8'), 'MODULE');        // the build, not the game folder's stray file
  const m = JSON.parse(readFileSync(join(dir, 'atv2-build.json'), 'utf8'));
  assert.equal(m.builder, '9.9.9');
  assert.equal(m.wasm.sha256, sha('MODULE'));
  assert.equal(m.wasm.memory.initialPages, 2);
  assert.equal(m.game.files, 4);
  if (r.how === 'hardlinks') assert.ok(statSync(join(dir, 'ATV.bad')).nlink >= 2);
  // The game folder is untouched.
  assert.equal(readFileSync(join(game, 'atv2.wasm'), 'utf8'), 'a stray one');
  // Again: nothing to do; a file gone from the game folder goes from the play folder.
  rmSync(join(game, 'Movies'), { recursive: true });
  const r2 = await makePlayFolder({ dir, gameDir: game, game: { size: 15, sha256: 'x' }, wasm: join(work, 'atv2.wasm'), info });
  assert.equal(r2.kept, 3);
  assert.equal(r2.removed, 1);
  assert.ok(!existsSync(join(dir, 'Movies')));
});

test('play folder: refuses a folder with other files in it', async () => {
  const game = fixture('pf-game2', GAME);
  const dir = fixture('pf-other', { 'my-notes.txt': 'mine' });
  const work = fixture('pf-work2', { 'atv2.wasm': 'MODULE' });
  await assert.rejects(makePlayFolder({ dir, gameDir: game, game: { size: 1, sha256: 'x' }, wasm: join(work, 'atv2.wasm'), info }),
    (e) => e instanceof PlayError && /not a play folder/.test(e.message));
  assert.equal(readFileSync(join(dir, 'my-notes.txt'), 'utf8'), 'mine');
});
