// titles/orbit/build.mjs - the second test title ("Orbit", ours): orbit.wasm
// from src/orbit.c with wasi-sdk (the same toolchain lookup as Box Quad's
// title/build.mjs) and its procedural assets. Called by pipeline/build.mjs
// through the profile (profiles/orbit.json, build.dir); nothing in the
// pipeline, the client or the site is specific to it.
//
//   node titles/orbit/build.mjs <outDir> [--wasi-sdk <dir>]
//
// Assets (deterministic: same inputs -> same bytes):
//   config/orbit.json   bodies, seed, step, colours
//   palette.bin         256 x RGB8 (a gradient), required
//   sky/stars.bin       u32 'STAR', u32 n, n x (f32 x, f32 y, f32 brightness): the on-demand group "sky"
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clangPath, DEFAULT_WASI_SDK } from '../../title/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const posix = (p) => p.split('\\').join('/');

function buildWasm(outFile, wasiSdk) {
  const clang = clangPath(wasiSdk);
  const src = join(HERE, 'src', 'orbit.c');
  const flags = ['--target=wasm32', '-O2', '-nostdlib', '-Wall', '-Werror', `-ffile-prefix-map=${REPO}=.`,
    '-Wl,--no-entry', '-Wl,--strip-debug', '-Wl,--initial-memory=131072', '-Wl,--max-memory=131072'];
  mkdirSync(dirname(outFile), { recursive: true });
  execFileSync(clang, [...flags, src, '-o', outFile], { stdio: ['ignore', 'pipe', 'inherit'], cwd: REPO });
  const version = execFileSync(clang, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
  const bytes = readFileSync(outFile);
  return { size: bytes.length, sha256: sha(bytes), source: [{ path: posix(relative(REPO, src)), sha256: sha(readFileSync(src)) }],
    toolchain: `wasi-sdk ${posix(wasiSdk).split('/').pop()} (${version})`,
    command: ['clang', ...flags.map((f) => f.replace(REPO, '<repo>')), posix(relative(REPO, src)), '-o', 'orbit.wasm'].join(' ') };
}

function rng(seed) {             // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function assets(outDir) {
  const put = (rel, body) => { mkdirSync(dirname(join(outDir, rel)), { recursive: true }); writeFileSync(join(outDir, rel), body); return rel; };
  const cfg = { bodies: 160, seed: 20261104, step: 1 / 240, stepsPerFrame: 4, background: '#0b0d12', trail: 0.18 };
  const pal = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) { const t = i / 255; pal[i * 3] = Math.round(80 + 175 * t); pal[i * 3 + 1] = Math.round(140 + 100 * Math.sin(t * Math.PI)); pal[i * 3 + 2] = Math.round(255 - 150 * t); }
  const r = rng(7), n = 12000;
  const stars = Buffer.alloc(8 + n * 12);
  stars.write('STAR', 0, 'latin1'); stars.writeUInt32LE(n, 4);
  for (let i = 0; i < n; i++) { stars.writeFloatLE(r() * 2 - 1, 8 + i * 12); stars.writeFloatLE(r() * 2 - 1, 12 + i * 12); stars.writeFloatLE(0.2 + 0.8 * r() ** 3, 16 + i * 12); }
  return [put('config/orbit.json', JSON.stringify(cfg, null, 1) + '\n'), put('palette.bin', pal), put('sky/stars.bin', stars)];
}

/** Build everything into outDir; returns { files, artifacts: { 'orbit.wasm': record } }. */
export function buildTitle(outDir, { wasiSdk = DEFAULT_WASI_SDK } = {}) {
  const art = buildWasm(join(outDir, 'orbit.wasm'), wasiSdk);
  return { files: ['orbit.wasm', ...assets(outDir)], artifacts: { 'orbit.wasm': art } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const out = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!out) { console.error('usage: node titles/orbit/build.mjs <outDir> [--wasi-sdk dir]'); process.exit(2); }
  console.log(JSON.stringify(buildTitle(resolve(out), { wasiSdk: opt('--wasi-sdk') }), null, 2));
}
