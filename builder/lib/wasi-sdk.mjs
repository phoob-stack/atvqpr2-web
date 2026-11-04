// wasi-sdk 34: find it, or download the official release archive, check its
// size and SHA-256, and unpack it. The download happens only when the caller
// allows it (the builder asks the player first, or --yes), and only for an
// archive whose SHA-256 is pinned below.
//
// A mirror (--wasi-sdk-mirror <base url>) replaces the GitHub release URL:
// http://, https:// or file://, holding the same file name. The unit tests use
// a 127.0.0.1 server and file:// for this.
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync, createReadStream, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tarExe, run, ensureDir, isWin, sha256File } from './util.mjs';

export const WASI_SDK_VERSION = '34.0';
export const OFFICIAL_BASE = 'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/';

// Release archives by host. size/sha256 null = not pinned: the builder will not
// download it and asks for --wasi-sdk instead.
//
// x86_64-windows: SHA-256 computed on the owner's PC (2026-11-03) from the
// official archive downloaded from the release page with the owner's
// approval (atv2-web NOTES.md, "third_party"); it matches the hash recorded at
// download time (cccb5c32...e71d8f). Cross-checked 2026-11-03 against the
// release's asset list (github.com/WebAssembly/wasi-sdk/releases, wasi-sdk-34):
// wasi-sdk-34.0-x86_64-windows.tar.gz, sha256 cccb5c32...e71d8f -- matches.
// TODO(release-notes): fill in the other hosts from the same asset list.
export const ARCHIVES = {
  'x86_64-windows': { file: 'wasi-sdk-34.0-x86_64-windows.tar.gz', size: 619003408,
    sha256: 'cccb5c323a9b34f0349a9b09e8804a0a7632c68c3310f4b5f437ed57d7e71d8f' },
  'x86_64-linux': { file: 'wasi-sdk-34.0-x86_64-linux.tar.gz', size: null, sha256: null /* TODO(release-notes) */ },
  'arm64-linux': { file: 'wasi-sdk-34.0-arm64-linux.tar.gz', size: null, sha256: null /* TODO(release-notes) */ },
  'x86_64-macos': { file: 'wasi-sdk-34.0-x86_64-macos.tar.gz', size: null, sha256: null /* TODO(release-notes) */ },
  'arm64-macos': { file: 'wasi-sdk-34.0-arm64-macos.tar.gz', size: null, sha256: null /* TODO(release-notes) */ },
};

export function hostKey(platform = process.platform, arch = process.arch) {
  const a = { x64: 'x86_64', arm64: 'arm64' }[arch];
  const p = { win32: 'windows', linux: 'linux', darwin: 'macos' }[platform];
  return a && p ? `${a}-${p}` : null;
}

export const sdkDirName = (key) => `wasi-sdk-${WASI_SDK_VERSION}-${key}`;

// { ok, why, version, clang }
export function checkSdk(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, why: `not found: ${dir}` };
  const clang = join(dir, 'bin', isWin ? 'clang.exe' : 'clang');
  if (!existsSync(clang)) return { ok: false, why: `no bin/clang in ${dir}` };
  const ar = join(dir, 'bin', isWin ? 'llvm-ar.exe' : 'llvm-ar');
  if (!existsSync(ar)) return { ok: false, why: `no bin/llvm-ar in ${dir}` };
  let version = null;
  try { version = readFileSync(join(dir, 'VERSION'), 'utf8').split(/\r?\n/)[0].trim(); } catch { /* none */ }
  if (version !== WASI_SDK_VERSION) return { ok: false, why: `${dir} is wasi-sdk ${version ?? '(no VERSION file)'}, need ${WASI_SDK_VERSION}`, version, clang };
  return { ok: true, version, clang };
}

// Fetch url (http/https/file) to dest, hashing on the way; check size and
// SHA-256; rename into place only when both match. A failed or mismatched
// download leaves nothing behind.
export async function fetchVerified(url, dest, { size, sha256, onProgress } = {}) {
  if (!sha256) throw new Error(`no pinned SHA-256 for ${url}; refusing to download`);
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  const h = createHash('sha256');
  let got = 0;
  let last = 0;
  const tap = new Transform({ transform(chunk, _e, cb) {
    h.update(chunk); got += chunk.length;
    if (onProgress && got - last >= Math.max(64 << 20, (size ?? 0) / 10)) { last = got; onProgress(got, size); }
    cb(null, chunk);
  } });
  try {
    let src;
    const u = new URL(url);
    if (u.protocol === 'file:') src = createReadStream(fileURLToPath(u));
    else if (u.protocol === 'http:' || u.protocol === 'https:') {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      const len = Number(res.headers.get('content-length'));
      if (size && len && len !== size) throw new Error(`${url} is ${len} bytes, expected ${size}`);
      src = Readable.fromWeb(res.body);
    } else throw new Error(`unsupported URL ${url}`);
    await pipeline(src, tap, createWriteStream(part));
    if (size && got !== size) throw new Error(`downloaded ${got} bytes, expected ${size}`);
    const hex = h.digest('hex');
    if (hex !== sha256.toLowerCase()) throw new Error(`SHA-256 mismatch for ${url}: got ${hex}, expected ${sha256}`);
    renameSync(part, dest);
    return { bytes: got, sha256: hex };
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

// Unpack a .tar.gz into parent/<topDir>. Extracts to a scratch folder first,
// so a half-unpacked SDK is never mistaken for a good one.
export async function extractSdk(archive, parent, topDir, { log } = {}) {
  const scratch = join(parent, `.unpack-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  ensureDir(scratch);
  try {
    const code = await run(tarExe(), ['-x', '-z', '-f', archive, '-C', scratch], { log });
    if (code !== 0) throw new Error(`tar failed (${code}) on ${archive}`);
    const top = readdirSync(scratch);
    const inner = top.includes(topDir) ? join(scratch, topDir) : top.length === 1 ? join(scratch, top[0]) : scratch;
    const dest = join(parent, topDir);
    rmSync(dest, { recursive: true, force: true });
    renameSync(inner, dest);
    return dest;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Find or install wasi-sdk 34.
//   explicit:   --wasi-sdk <dir> (must be good; never downloads)
//   toolchains: where downloaded SDKs live (<data dir>/toolchains)
//   mirror:     base URL instead of the GitHub release
//   confirm:    async (message) => boolean, asked before any download
//   releases/key: overridable for tests
export async function ensureWasiSdk({ explicit, toolchains, mirror, confirm, log, say = console.log,
  releases = ARCHIVES, key = hostKey(), envDir = process.env.WASI_SDK_PATH } = {}) {
  if (explicit) {
    const c = checkSdk(explicit);
    if (!c.ok) throw new Error(`--wasi-sdk: ${c.why}`);
    return { dir: explicit, source: 'given', ...c };
  }
  const candidates = [envDir, toolchains && key && join(toolchains, sdkDirName(key))].filter(Boolean);
  for (const d of candidates) {
    const c = checkSdk(d);
    if (c.ok) return { dir: d, source: d === envDir ? 'WASI_SDK_PATH' : 'toolchains', ...c };
  }
  const rel = key && releases[key];
  if (!rel) throw new Error(`no wasi-sdk ${WASI_SDK_VERSION} release for this host (${process.platform}/${process.arch}); pass --wasi-sdk <dir>`);
  if (!rel.sha256) throw new Error(`wasi-sdk ${WASI_SDK_VERSION} for ${key}: no pinned SHA-256 in this builder yet, so it will not download it. ` +
    `Install it yourself from ${OFFICIAL_BASE}${rel.file} and pass --wasi-sdk <dir>.`);
  if (!toolchains) throw new Error('no toolchains folder');
  const url = (mirror ? mirror.replace(/\/?$/, '/') : OFFICIAL_BASE) + rel.file;
  const mb = rel.size ? `${(rel.size / 2 ** 20).toFixed(0)} MB` : 'size unknown';
  if (!confirm || !(await confirm(`wasi-sdk ${WASI_SDK_VERSION} is not installed. Download ${rel.file} (${mb}) from\n  ${url}\ninto ${toolchains}?`)))
    throw new Error('wasi-sdk is needed to compile the game; download declined. Pass --wasi-sdk <dir> to use an installed copy.');
  ensureDir(toolchains);
  const archive = join(toolchains, rel.file);
  if (existsSync(archive) && statSync(archive).size === rel.size) {
    say(`  re-checking the archive already in ${toolchains}`);
    if ((await sha256File(archive)) !== rel.sha256) rmSync(archive);
  }
  if (!existsSync(archive)) {
    say(`  downloading ${url}`);
    await fetchVerified(url, archive, { size: rel.size, sha256: rel.sha256,
      onProgress: (n, total) => say(`    ${(n / 2 ** 20).toFixed(0)}${total ? ` / ${(total / 2 ** 20).toFixed(0)}` : ''} MB`) });
    say('  size and SHA-256 match');
  }
  say(`  unpacking into ${toolchains}`);
  const dir = await extractSdk(archive, toolchains, sdkDirName(key), { log });
  const c = checkSdk(dir);
  if (!c.ok) throw new Error(`unpacked wasi-sdk is not usable: ${c.why}`);
  rmSync(archive, { force: true });
  return { dir, source: 'downloaded', url, ...c };
}
