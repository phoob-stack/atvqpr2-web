// verify-package.mjs and lib/game.mjs against small made-up fixtures (no game
// data: the "generated" files below are a few lines in the lifter's format).
//   ATV2_TEST_TMP=<scratch dir> node --test test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { verifyPackage } from '../verify-package.mjs';
import { verifyGameFolder, GameError } from '../lib/game.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = process.env.ATV2_TEST_TMP ? join(process.env.ATV2_TEST_TMP, `verify-${process.pid}`) : mkdtempSync(join(os.tmpdir(), 'atv2-builder-test-'));
after(() => { if (!process.env.ATV2_TEST_KEEP) rmSync(TMP, { recursive: true, force: true }); });

function fixture(name, files) {
  const d = join(TMP, name);
  rmSync(d, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  return d;
}
const CLEAN = { 'README.md': '# ok\n', 'src/main.c': 'int main(void) { return 0; }\n', 'web/x.js': 'export {};\n',
  'docs/lifting.md': 'Generated files look like:\n```c\n#define RECOMP_GENERATED_CODE\nvoid sub_00011000(void) {\n}\n```\n' };
const why = (r) => r.problems.map((p) => `${p.file}: ${p.why}`).join('\n');

test('this package is clean', () => {
  const r = verifyPackage(PKG, { quiet: true });
  assert.ok(r.ok, why(r));
});

test('a clean tree passes (including docs that show one lifted function)', () => {
  const r = verifyPackage(fixture('clean', CLEAN), { quiet: true });
  assert.ok(r.ok, why(r));
});

for (const ext of ['.xbe', '.iso', '.bah', '.bad', '.xpr', '.wav', '.wasm', '.obj', '.lib', '.exe', '.XBE']) {
  test(`rejects ${ext}`, () => {
    const r = verifyPackage(fixture(`ext${ext}`, { ...CLEAN, [`data/file${ext}`]: 'x' }), { quiet: true });
    assert.equal(r.ok, false);
    assert.match(why(r), /forbidden file type/);
  });
}

test('rejects a file over 5 MB', () => {
  const r = verifyPackage(fixture('big', { ...CLEAN, 'big.txt': Buffer.alloc(5 * 1024 * 1024 + 1, 32) }), { quiet: true });
  assert.match(why(r), /over 5 MB/);
});

test('rejects anything under src/recomp/gen and lifter file names', () => {
  const r = verifyPackage(fixture('gen', { ...CLEAN, 'src/recomp/gen/notes.txt': 'x', 'other/recomp_0007.c': '/* */', 'x/recomp_funcs.h': '' }), { quiet: true });
  assert.match(why(r), /inside src\/recomp\/gen/);
  assert.match(why(r), /recomp_0007\.c: named like lifter output/);
  assert.match(why(r), /recomp_funcs\.h: named like lifter output/);
});

test('rejects lifted C by content, whatever its name', () => {
  const chunk = '/**\n * Some Game - Recompiled code chunk 3\n * Functions: 2 (0x00011000 - 0x00011050)\n */\n\n#define RECOMP_GENERATED_CODE\n';
  const fn = '/**\n * sub_00011000\n * Original: 0x00011000 - 0x00011030 (48 bytes, 22 insns)\n */\nvoid sub_00011000(void)\n{\n}\n';
  const many = Array.from({ length: 25 }, (_, i) => `void sub_${(0x11000 + i * 16).toString(16).toUpperCase().padStart(8, '0')}(void)\n{\n}\n`).join('');
  const r = verifyPackage(fixture('content', { ...CLEAN, 'a/game.c': chunk, 'b/one.c': fn, 'c/many.c': many,
    'd/table.h': '/**\n * Some Game - Recompiled Function Declarations\n */\n',
    'e/disp.c': '/**\n * Some Game - Recompiled Function Dispatch Table\n * Maps 8953 Xbox ' + 'VAs to translated function pointers.\n */\n' }), { quiet: true });
  const w = why(r);
  assert.match(w, /a\/game\.c: contains lifter chunk banner/);
  assert.match(w, /b\/one\.c: contains lifted-function header comment/);
  assert.match(w, /c\/many\.c: 25 lifted-function definitions/);
  assert.match(w, /d\/table\.h: contains lifter table banner/);
  assert.match(w, /e\/disp\.c: contains lifter dispatch banner/);
});

test('rejects a saved WebGPU pipeline list (pipelines.json), also renamed', () => {
  const body = '{"version":1,"msaa":1,"shaders":{"b738d271d11cdef211ab":' + '"struct XfC {\n  surf: vec2f };"}}';
  const r = verifyPackage(fixture('pipes', { ...CLEAN, 'build-wasm/pipelines.json': body, 'x/renamed.json': body }), { quiet: true });
  assert.match(why(r), /pipelines.json: named like/);
  assert.match(why(r), /renamed.json: contains saved WebGPU pipeline list/);
});

test('rejects game files by magic number under a harmless name', () => {
  const iso = Buffer.alloc(0x10020); iso.write('MICROSOFT*XBOX*MEDIA', 0x10000, 'latin1');
  const r = verifyPackage(fixture('magic', { ...CLEAN, 'a.txt': Buffer.concat([Buffer.from('XBEH'), Buffer.alloc(64)]),
    'b.dat': Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), 'c.dat': Buffer.from('RIFF\0\0\0\0WAVEfmt '), 'd.dat': iso }), { quiet: true });
  const w = why(r);
  for (const m of [/a\.txt: XBE header/, /b\.dat: wasm module/, /c\.dat: RIFF\/WAVE/, /d\.dat: Xbox disc image/]) assert.match(w, m);
});

test('game check: wrong size, missing files, ISO instead of folder, parent folder', async () => {
  const g = fixture('game-wrong', { 'default.xbe': Buffer.alloc(1000), 'ATV.bah': '', 'ATV.bad': '' });
  await assert.rejects(verifyGameFolder(g), (e) => e instanceof GameError && /1000 bytes/.test(e.message));
  const iso = fixture('game-iso', { 'atv2.iso': 'x' });
  await assert.rejects(verifyGameFolder(join(iso, 'atv2.iso')), /disc image/);
  await assert.rejects(verifyGameFolder(join(TMP, 'game-wrong', '..')), /pass that folder/);
  await assert.rejects(verifyGameFolder(join(TMP, 'nope')), /not found/);
  // Right size, wrong bytes.
  const same = fixture('game-size', { 'default.xbe': Buffer.alloc(1904640), 'ATV.bah': '', 'ATV.bad': '' });
  await assert.rejects(verifyGameFolder(same), /SHA-256/);
});

test('game check: the real game folder (ATV2_TEST_GAME)', { skip: !process.env.ATV2_TEST_GAME && 'set ATV2_TEST_GAME' }, async () => {
  const r = await verifyGameFolder(process.env.ATV2_TEST_GAME);
  assert.equal(r.size, 1904640);
});
