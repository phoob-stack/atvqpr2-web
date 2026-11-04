// The player's own game build (atv2.wasm) on the project site (deploy.js mode
// 'site').
//
// The site never serves the game module: the builder makes it on the
// player's computer from their own game files and writes a play folder
// (atv2-play): the game files, atv2.wasm and atv2-build.json (builder version,
// sources, size and SHA-256). The player picks that folder; loader.js imports
// the game files into OPFS as always, and this file checks the module and
// keeps it in OPFS too (BUILD_DIR), so later visits start without a pick.
//
// The page's code and the module must match (the host ABI: imports, the host
// block, the I/O channel). deploy.js lists the builds this copy of the page
// was made for, by size and SHA-256; the builder's builds are reproducible
// (same sources, same wasi-sdk -> the same bytes on any PC), so a module that
// is not on the list was made by another builder version, or changed. It is
// checked when picked and again at every start (a newer site may need a newer
// build).
import { DEPLOY } from './deploy.js';

/** Where an earlier version of this page kept the build (migrated by assetsource.js); kept for the Game data names. */
export const BUILD_DIR = 'atv2-build';
export const WASM_NAME = 'atv2.wasm';
export const MANIFEST_NAME = 'atv2-build.json';
/** Top-level files of a play folder that are the build, not game files. */
export const BUILD_FILES = /^(atv2\.wasm|atv2-build\.json|atv2-play\.txt)$/i;

export class BuildError extends Error {
  /** kind: 'missing' (no atv2.wasm) | 'mismatch' (not a build this page works with). */
  constructor(kind, message) { super(message); this.kind = kind; this.link = DEPLOY.links?.setup ? { href: DEPLOY.links.setup, text: 'Setup: the builder' } : null; }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const short = (c) => String(c ?? '').slice(0, 7);
export const acceptedBuilds = () => DEPLOY.builds ?? [];
/** The build to ask the player for (the first one listed). */
export const wantedBuild = () => acceptedBuilds()[0] ?? null;
export function wantedText() {
  const b = wantedBuild();
  return b ? `builder ${b.builder} (atvrecomp ${short(b.atvrecomp)}, xboxrecomp ${short(b.xboxrecomp)})` : 'the current builder';
}
const rebuild = () => `Rebuild with builder ${wantedBuild()?.builder ?? '(current)'} and pick its output folder (atv2-play) again.`;
export const matchBuild = (size, sha256) => acceptedBuilds().find((b) => b.wasm?.size === size && b.wasm?.sha256 === sha256) ?? null;

export const MISSING_TEXT = 'This folder has no atv2.wasm (your game build). Run the builder once to make your game build, ' +
  'then pick its output folder (atv2-play): it has your game files and atv2.wasm together.';

/**
 * Check the build in a picked play folder. entries: loader.js's scan
 * ({ path, size, file() }, paths relative to the game root). Returns
 * { bytes, sha256, size, manifest, match } or throws a BuildError.
 */
export async function checkBuild(entries) {
  const find = (n) => entries.find((e) => e.path.toLowerCase() === n);
  const w = find(WASM_NAME);
  if (!w) throw new BuildError('missing', MISSING_TEXT);
  let manifest = null;
  const mf = find(MANIFEST_NAME);
  if (mf) { try { manifest = JSON.parse(await (await mf.file()).text()); } catch { manifest = null; } }
  const bytes = await (await w.file()).arrayBuffer();
  const u = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (u.length < 4 || u[0] !== 0 || u[1] !== 0x61 || u[2] !== 0x73 || u[3] !== 0x6d)
    throw new BuildError('mismatch', `atv2.wasm in that folder is not a WebAssembly module (${bytes.byteLength.toLocaleString('en-US')} bytes). ${rebuild()}`);
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
  const match = matchBuild(bytes.byteLength, sha256);
  if (!match) {
    const made = manifest?.builder ? `It was made by builder ${manifest.builder}${manifest.atvrecomp ? ` (atvrecomp ${short(manifest.atvrecomp)})` : ''}`
      : 'Its builder version is unknown (there is no atv2-build.json next to it)';
    const changed = manifest?.wasm?.sha256 && manifest.wasm.sha256 !== sha256 ? ' It also differs from the build its atv2-build.json lists, so it was changed after the build.' : '';
    throw new BuildError('mismatch', `This atv2.wasm does not match this site's game page. ${made}; this site needs ${wantedText()}.` +
      `${changed} (SHA-256 ${sha256.slice(0, 16)}…, ${bytes.byteLength.toLocaleString('en-US')} bytes.) ${rebuild()}`);
  }
  return { bytes, sha256, size: bytes.byteLength, manifest, match };
}

/**
 * The build kept in this browser: null when there is none, else
 * { ...record, ok } (ok false: kept for an earlier version of this page).
 */
export async function storedBuild() {
  const { localSource } = await import('./assetsource.js');
  const src = await localSource();
  const cat = await src.catalog().catch(() => null);
  return cat ? src.buildOf(cat) : null;
}

export const STALE_TEXT = () => `The game build kept in this browser was made for another version of this site. ${rebuild()}`;

/**
 * The kept module, the way wasm-load.js's loadWasm(url) gives a served one:
 * { module, limits, info() }, from the asset source (assetsource.js
 * LocalImportSource.module(): the bytes are hashed again so that only a
 * listed build ever runs, then compiled once; the Module goes to every
 * Worker by postMessage, threads.js).
 */
export function loadStoredWasm(source) { return source.module(); }
