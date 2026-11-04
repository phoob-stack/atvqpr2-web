// build.mjs - build the placeholder title: title.wasm from title/src/*.c with
// the local wasi-sdk, and its assets (gen-assets.mjs) into one folder.
//
//   node title/build.mjs <outDir> [--variant N] [--wasi-sdk <dir>]
//
// Returns/prints the artifact record the pipeline puts in artifacts.json and
// the manifest: the module's size and SHA-256, every source file with its
// SHA-256, the compiler and the exact command. Only files of this repository
// are read.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate } from './gen-assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// wasi-sdk 34: --wasi-sdk <dir>, else WASI_SDK_PATH / WASI_SDK, else the first
// third_party/wasi-sdk/wasi-sdk-34* folder in this repository's folder or one above it.
function findWasiSdk() {
  for (let d = REPO, i = 0; i < 6; i++, d = dirname(d)) {
    const base = join(d, 'third_party', 'wasi-sdk');
    if (!existsSync(base)) continue;
    const hit = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('wasi-sdk-34')).map((e) => e.name).sort()[0];
    if (hit) return join(base, hit);
  }
  return join(REPO, '..', 'third_party', 'wasi-sdk', 'wasi-sdk-34.0-x86_64-windows');
}
export const DEFAULT_WASI_SDK = process.env.WASI_SDK_PATH ?? process.env.WASI_SDK ?? findWasiSdk();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const posix = (p) => p.split('\\').join('/');

export function clangPath(wasiSdk = DEFAULT_WASI_SDK) {
  const exe = join(wasiSdk, 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
  if (!existsSync(exe)) throw new Error(`wasi-sdk clang not found at ${exe} (pass --wasi-sdk <dir> or set WASI_SDK)`);
  return exe;
}

export function buildWasm(outFile, { wasiSdk = DEFAULT_WASI_SDK } = {}) {
  const clang = clangPath(wasiSdk);
  const srcDir = join(HERE, 'src');
  const sources = readdirSync(srcDir).filter((f) => f.endsWith('.c')).sort().map((f) => join(srcDir, f));
  const flags = ['--target=wasm32', '-O2', '-nostdlib', '-fno-builtin-memset', '-Wall', '-Werror',
    `-ffile-prefix-map=${REPO}=.`, '-Wl,--no-entry', '-Wl,--export-dynamic', '-Wl,--strip-debug', '-Wl,--initial-memory=1048576',
    '-Wl,--max-memory=67108864'];
  mkdirSync(dirname(outFile), { recursive: true });
  execFileSync(clang, [...flags, ...sources, '-o', outFile], { stdio: ['ignore', 'pipe', 'inherit'], cwd: REPO });
  const version = execFileSync(clang, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
  const bytes = readFileSync(outFile);
  return {
    size: bytes.length,
    sha256: sha(bytes),
    source: sources.map((s) => ({ path: posix(relative(REPO, s)), sha256: sha(readFileSync(s)) })),
    toolchain: `wasi-sdk ${posix(wasiSdk).split('/').pop()} (${version})`,
    command: ['clang', ...flags.map((f) => f.replace(REPO, '<repo>')), ...sources.map((s) => posix(relative(REPO, s))), '-o', 'title.wasm'].join(' '),
  };
}

/** Build everything into outDir; returns { files: [rel...], artifacts: { 'title.wasm': record } }. */
export function buildTitle(outDir, { variant = 0, wasiSdk } = {}) {
  const art = buildWasm(join(outDir, 'title.wasm'), { wasiSdk });
  const files = ['title.wasm', ...generate(outDir, { variant })];
  return { files, artifacts: { 'title.wasm': art } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const out = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!out) { console.error('usage: node title/build.mjs <outDir> [--variant N] [--wasi-sdk dir]'); process.exit(2); }
  const r = buildTitle(resolve(out), { variant: Number(opt('--variant') ?? 0), wasiSdk: opt('--wasi-sdk') });
  console.log(JSON.stringify(r, null, 2));
}
