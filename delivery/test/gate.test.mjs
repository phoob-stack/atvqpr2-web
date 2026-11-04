// The pipeline's no-game-content gate: the build fails when forbidden files
// are dropped into its inputs (or come in through the site), and --out is
// left untouched. Every "forbidden" file here is a few made-up bytes in the
// right shape (a wasm/XBE header, a lifter banner); no game data is read.
//   node --test test/gate.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyPackage } from '../pipeline/verify-package.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.test', 'gate');
const WASM = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.from('made-up module for the gate test')]);
const XBE = Buffer.concat([Buffer.from('XBEH'), Buffer.alloc(252)]);
const LIFTED_C = '/**\n * Some Game - Recompiled code chunk 1\n * Functions: 2 (0x00011000 - 0x00011050)\n */\n\n#define RECOMP_GENERATED_CODE\n' +
  '/**\n * sub_00011000\n * Original: 0x00011000 - 0x00011030 (48 bytes, 22 insns)\n */\nvoid sub_00011000(void)\n{\n}\n';
// (split so this file itself does not match the rule: the pipeline scans test/ too)
const GEN_WGSL = ['struct V', 'sC { c: array<vec4f, 192> };\n@group(0) @binding(0) var<uniform> K: V', 'sC;\n@vertex fn main() {}\n'].join('');

function workspace(name) {
  const ws = join(TMP, name);
  rmSync(ws, { recursive: true, force: true });
  for (const d of ['profiles', 'title', 'titles', 'client', 'web', 'server', 'hub', 'pipeline']) cpSync(join(ROOT, d), join(ws, d), { recursive: true });
  cpSync(join(ROOT, 'LICENSE'), join(ws, 'LICENSE'));
  return ws;
}
function build(ws, ...args) {
  const r = spawnSync(process.execPath, [join(ws, 'pipeline', 'build.mjs'), '--root', ws, '--out', join(ws, 'out'), '--no-site', ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
function drop(ws, rel, body) { mkdirSync(dirname(join(ws, rel)), { recursive: true }); writeFileSync(join(ws, rel), body); }

before(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
after(() => { if (!process.env.KEEP) rmSync(TMP, { recursive: true, force: true }); });

test('a clean workspace builds and its output passes the gate', () => {
  const ws = workspace('clean');
  const r = build(ws);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /gate passed/);
  const out = join(ws, 'out');
  assert.ok(existsSync(join(out, 'assets', 'manifest.json')));
  assert.ok(verifyPackage(join(out, 'assets'), { quiet: true, delivery: true, assets: true, sourceRoot: ws }).ok);
  assert.ok(!existsSync(`${out}.staging`));
});

// The three the task names, then more of the same kinds.
const CASES = [
  ['atv2.wasm dropped next to the title sources', 'title/atv2.wasm', WASM, [/atv2\.wasm: .*named like the game module/, /not a declared artifact/]],
  ['atv2.wasm dropped into the title\'s static files', 'title/static/atv2.wasm', WASM, [/named like the game module/]],
  ['a generated recomp_*.c among the C sources', 'title/src/recomp_0001.c', LIFTED_C, [/recomp_0001\.c: named like lifter output/, /lifter chunk banner/, /lifted-function header comment/]],
  ['a .xbe in the inputs', 'title/static/default.xbe', XBE, [/forbidden file type \.xbe/, /XBE header/]],
  ['a wasm module under an innocent name', 'title/static/level1.dat', WASM, [/level1\.dat: wasm module that is not a declared artifact/]],
  ['a .wav', 'title/static/engine.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]), [/forbidden file type \.wav/, /RIFF\/WAVE/]],
  ['a .bah', 'title/static/ATV.bah', 'x', [/forbidden file type \.bah/]],
  ['a .bad', 'web/ATV.bad', 'x', [/forbidden file type \.bad/]],
  ['a .xpr', 'web/app/tex.xpr', 'x', [/forbidden file type \.xpr/]],
  ['an .iso', 'title/static/disc.iso', 'x', [/forbidden file type \.iso/]],
  ['generated WGSL from the game', 'web/app/pipes.wgsl', GEN_WGSL, [/generated WGSL/]],
  ['a file under src/recomp/gen', 'title/static/src/recomp/gen/notes.txt', 'x', [/inside src\/recomp\/gen/]],
  ['a build-wasm folder', 'title/static/build-wasm/x.json', '{}', [/game's build or storage/]],
  ['recompiled function names in a binary', 'title/static/symbols.bin',
    Buffer.from(Array.from({ length: 30 }, (_, i) => `sub_${(0x11000 + i * 16).toString(16).toUpperCase().padStart(8, '0')}\0`).join('')), [/30 recompiled-function names/]],
];
for (const [name, rel, body, expect] of CASES) {
  test(`the build fails: ${name}`, () => {
    const ws = workspace(`case-${rel.replace(/[^\w]+/g, '-')}`);
    drop(ws, rel, body);
    const r = build(ws);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /build FAILED: the inputs hold forbidden files/);
    for (const re of expect) assert.match(r.out, re);
    assert.ok(!existsSync(join(ws, 'out')), 'nothing written to --out');
    assert.ok(!existsSync(join(ws, 'out.staging')), 'staging removed');
  });
}

test('a failed build leaves the previous output untouched', () => {
  const ws = workspace('keep-previous');
  assert.equal(build(ws).status, 0);
  const before = readFileSync(join(ws, 'out', 'build.json'));
  drop(ws, 'title/atv2.wasm', WASM);
  const r = build(ws);
  assert.equal(r.status, 1);
  assert.ok(readFileSync(join(ws, 'out', 'build.json')).equals(before));
});

test('forbidden files coming in through the site bundle fail the output gate', () => {
  const ws = workspace('site');
  const site = join(TMP, 'site-fixture');
  rmSync(site, { recursive: true, force: true });
  mkdirSync(join(site, 'play'), { recursive: true });
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>x</title>\n');
  writeFileSync(join(site, 'play', 'atv2.wasm'), WASM);
  const g = (...a) => execFileSync('git', ['-C', site, '-c', 'user.name=gate-test', '-c', 'user.email=gate-test@invalid', '-c', 'core.autocrlf=false', ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'fixture');
  const r = spawnSync(process.execPath, [join(ws, 'pipeline', 'build.mjs'), '--root', ws, '--out', join(ws, 'out'), '--site', site], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.match(out, /no-game-content gate failed/);
  assert.match(out, /site\/play\/atv2\.wasm: .*named like the game module/);
  assert.ok(!existsSync(join(ws, 'out')));
});

test('--with-atv-runtime is refused', () => {
  const ws = workspace('runtime');
  const r = build(ws, '--with-atv-runtime');
  assert.equal(r.status, 2);
  assert.match(r.out, /not supported/);
});

test('the game\'s build trees are refused as inputs or outputs', () => {
  const ws = workspace('paths');
  const r = spawnSync(process.execPath, [join(ws, 'pipeline', 'build.mjs'), '--root', ws, '--out', join(ws, 'build-wasm', 'out'), '--no-site'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /path of the game's build or storage/);
  const r2 = spawnSync(process.execPath, [join(ws, 'pipeline', 'build.mjs'), '--root', ws, '--out', join(ws, 'out'), '--site', join(ROOT, '..', 'atvrecomp')], { encoding: 'utf8' });
  assert.equal(r2.status, 1);
  assert.match(`${r2.stdout}${r2.stderr}`, /never reads or writes/);
});

test('a declared wasm needs a recorded, unchanged source', () => {
  const d = join(TMP, 'declared');
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.c'), 'int f(void) { return 1; }\n');
  writeFileSync(join(d, 'mod.wasm'), WASM);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const rec = (source) => JSON.stringify({ artifacts: { 'mod.wasm': { size: WASM.length, sha256: sha(WASM), toolchain: 'wasi-sdk 34', source } } });
  const out = join(TMP, 'declared-out');
  rmSync(out, { recursive: true, force: true }); mkdirSync(out);
  cpSync(join(d, 'mod.wasm'), join(out, 'mod.wasm'));
  writeFileSync(join(out, 'artifacts.json'), rec([{ path: 'src/a.c', sha256: sha(readFileSync(join(d, 'src', 'a.c'))) }]));
  assert.ok(verifyPackage(out, { quiet: true, delivery: true, sourceRoot: d }).ok);
  writeFileSync(join(d, 'src', 'a.c'), 'int f(void) { return 2; }\n');
  assert.match(verifyPackage(out, { quiet: true, delivery: true, sourceRoot: d }).problems.map((p) => p.why).join('\n'), /changed since the build/);
  writeFileSync(join(out, 'artifacts.json'), rec([]));
  assert.match(verifyPackage(out, { quiet: true, delivery: true }).problems.map((p) => p.why).join('\n'), /no recorded source/);
  writeFileSync(join(out, 'artifacts.json'), rec([{ path: 'gen/recomp_0001.c', sha256: 'a'.repeat(64) }]));
  assert.match(verifyPackage(out, { quiet: true, delivery: true }).problems.map((p) => p.why).join('\n'), /named like lifter output/);
  rmSync(join(out, 'artifacts.json'));
  assert.match(verifyPackage(out, { quiet: true, delivery: true }).problems.map((p) => p.why).join('\n'), /not a declared artifact/);
  assert.match(verifyPackage(out, { quiet: true }).problems.map((p) => p.why).join('\n'), /forbidden file type \.wasm/, 'without --delivery, rule 1 as in the builder');
});

test('known game files by SHA-256 are refused whatever their name', async () => {
  const { DENY_SHA256 } = await import('../pipeline/verify-package.mjs');
  assert.ok(DENY_SHA256.has('a211cd18508fe02122d554feffe4830948edf513ffce33d2125481c75ed4181e'));
  assert.ok(DENY_SHA256.has('1e3c2fcebf62709f2f867da846942470ef3455da6c46a0f3eb2f18aec93bd22f'));
});

test('the asset layout: unlisted or changed objects and forbidden logical names fail', async () => {
  const { writeLayout } = await import('../pipeline/manifest.mjs');
  const src = join(TMP, 'layout-src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'a.bin'), 'aaaa');
  const dir = join(TMP, 'layout');
  rmSync(dir, { recursive: true, force: true });
  const m = writeLayout(dir, [{ path: 'a.bin', abs: join(src, 'a.bin') }], { title: 't' });
  assert.ok(verifyPackage(dir, { quiet: true, delivery: true, assets: true }).ok);
  writeFileSync(join(dir, 'objects', 'stray'), 'x');
  writeFileSync(join(dir, m.files[0].url), 'bbbb');
  const why = verifyPackage(dir, { quiet: true, delivery: true, assets: true }).problems.map((p) => `${p.file}: ${p.why}`).join('\n');
  assert.match(why, /objects\/stray: not an object listed in manifest\.json/);
  assert.match(why, /SHA-256 differs from the manifest's/);
  assert.throws(() => writeLayout(join(TMP, 'layout2'), [{ path: 'default.xbe', abs: join(src, 'a.bin') }], { title: 't' }), /forbidden file type \.xbe/);
  assert.throws(() => writeLayout(join(TMP, 'layout3'), [{ path: '../x.bin', abs: join(src, 'a.bin') }], { title: 't' }), /unsafe asset path/);
});
