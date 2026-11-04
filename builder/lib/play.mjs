// The play folder: what the player picks on the project site ("Select local
// game files"). One folder with their game files and the atv2.wasm built from
// them, plus atv2-build.json (builder version, sources, sizes and SHA-256s)
// and a short atv2-play.txt. The site serves only its own page code; the page
// reads this folder from the player's disk and keeps a copy in the browser.
//
// The game files are hard links to the player's own files when the play
// folder is on the same drive (no extra space; nothing is ever written
// through them: a changed file is deleted and linked again), else copies.
// The player's game folder is only read. Saves and scratch folders in it
// (UDATA, TDATA, CACHE, TitleCache) and system files are left out, as the
// page's own import does.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, lstatSync, linkSync, copyFileSync, rmSync, rmdirSync, utimesSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { ensureDir, toPosix, sha256File } from './util.mjs';

export const WASM_NAME = 'atv2.wasm';
export const MANIFEST_NAME = 'atv2-build.json';
export const README_NAME = 'atv2-play.txt';
const OURS = new Set([WASM_NAME, MANIFEST_NAME, README_NAME].map((n) => n.toLowerCase()));
const SAVE_FOLDERS = /^(udata|tdata|cache|titlecache)$/i;
const SKIP_NAME = (n) => n.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(n);

export class PlayError extends Error {}

/** The game folder's files to put in the play folder: [{ rel, abs, size, mtimeMs }]. */
export function gameFiles(gameDir) {
  const out = [];
  const rec = (d, top) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_NAME(e.name)) continue;
      const abs = join(d, e.name);
      const rel = toPosix(relative(gameDir, abs));
      if (e.isSymbolicLink()) continue;                       // never followed
      if (e.isDirectory()) { if (!(top && SAVE_FOLDERS.test(e.name))) rec(abs, false); continue; }
      if (!e.isFile()) continue;
      if (top && OURS.has(e.name.toLowerCase())) continue;     // a play folder's own names
      const st = statSync(abs);
      out.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev });
    }
  };
  rec(gameDir, true);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

const README = (m) => `ATV: Quad Power Racing 2 - your play folder
==========================================

Made by the atv2 builder ${m.builder} on ${m.madeAt.slice(0, 10)} from your own game files.

To play in the browser on the project site: open the site, Play, "Select local
game files", and choose this folder. The page checks default.xbe (USA retail)
and atv2.wasm (the build its page was made for), then copies them into the
browser's own storage once; nothing is uploaded.

  ${WASM_NAME}        the game program, compiled on this computer from your disc
  ${MANIFEST_NAME}  builder version, sources and SHA-256 of ${WASM_NAME}
  everything else   your game files (${m.game.how === 'hardlinks' ? 'hard links to your game folder: they take no extra space' : m.game.how === 'copies' ? 'copies of your game folder' : 'hard links or copies of your game folder'})

The builder remakes this folder on every run. It is made from your game:
do not share it. Deleting it does not touch your game folder.
`;

/**
 * Make or refresh the play folder. Returns { dir, files, bytes, linked,
 * copied, kept, removed, how, manifest }.
 *   gameDir: the checked game folder; game: verifyGameFolder's result
 *   wasm: the built module; memoryJson: build.sh's atv2.memory.json (optional)
 *   info: { builder, atvrecomp, xboxrecomp, wasiSdk, reference }
 */
export async function makePlayFolder({ dir, gameDir, game, wasm, memoryJson, info, say = () => {} }) {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new PlayError(`${dir} is a file; pass another --play-dir`);
    const names = readdirSync(dir);
    if (names.length && !names.some((n) => n.toLowerCase() === MANIFEST_NAME))
      throw new PlayError(`${dir} already has other files in it and is not a play folder made by this builder; ` +
        'pass an empty or new folder with --play-dir');
  }
  ensureDir(dir);
  // The manifest goes first, so that an interrupted run leaves a folder this
  // builder recognises again (the page refuses a folder without a build anyway).
  const files = gameFiles(gameDir);
  let linked = 0, copied = 0, kept = 0, removed = 0, bytes = 0;
  const want = new Set();
  for (const f of files) {
    const to = join(dir, ...f.rel.split('/'));
    want.add(f.rel.toLowerCase());
    bytes += f.size;
    let st = null;
    try { st = lstatSync(to); } catch { /* not there */ }
    if (st?.isFile() && st.size === f.size && ((st.ino === f.ino && st.dev === f.dev && st.ino !== 0) || Math.floor(st.mtimeMs) === Math.floor(f.mtimeMs))) {
      kept++; if (st.nlink > 1) linked++; else copied++;
      continue;
    }
    if (st) rmSync(to, { recursive: true, force: true });
    ensureDir(dirname(to));
    try { linkSync(f.abs, to); linked++; } catch {
      copyFileSync(f.abs, to);                // another drive, or links not allowed there
      utimesSync(to, new Date(), new Date(f.mtimeMs));   // so that the next run sees it is the same
      copied++;
    }
  }
  // Remove what the game folder no longer has (never our own three files).
  const prune = (d, top) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = toPosix(relative(dir, p)).toLowerCase();
      if (top && OURS.has(e.name.toLowerCase())) continue;
      if (e.isDirectory() && !e.isSymbolicLink()) { prune(p, false); if (!readdirSync(p).length) rmdirSync(p); }
      else if (!want.has(rel)) { rmSync(p, { force: true }); removed++; }
    }
  };
  prune(dir, true);

  // The module: copied (the work folder's build is replaced on a rebuild).
  const wasmTo = join(dir, WASM_NAME);
  const wsize = statSync(wasm).size;
  const wsha = await sha256File(wasm);
  let have = null;
  try { if (statSync(wasmTo).size === wsize) have = await sha256File(wasmTo); } catch { /* none */ }
  if (have !== wsha) { rmSync(wasmTo, { force: true }); copyFileSync(wasm, wasmTo); }
  let memory = null;
  try { memory = JSON.parse(readFileSync(memoryJson, 'utf8')); } catch { /* optional */ }

  const how = !copied ? 'hardlinks' : !linked ? 'copies' : 'mixed';
  const manifest = {
    format: 'atv2-play', formatVersion: 1,
    builder: info.builder, atvrecomp: info.atvrecomp, xboxrecomp: info.xboxrecomp, wasiSdk: info.wasiSdk,
    wasm: { name: WASM_NAME, size: wsize, sha256: wsha, reference: info.reference ?? null,
      ...(memory ? { memory: { initialPages: memory.initialPages, maximumPages: memory.maximumPages, shared: !!memory.shared } } : {}) },
    game: { defaultXbe: { size: game.size, sha256: game.sha256 }, files: files.length, bytes, how },
    madeAt: new Date().toISOString(),
    note: 'Made on this computer from your own game files. Pick this folder on the project site (Select local game files). Do not share it.',
  };
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dir, README_NAME), README(manifest).replace(/\n/g, process.platform === 'win32' ? '\r\n' : '\n'));
  return { dir, files: files.length, bytes, linked, copied, kept, removed, how, manifest, wasmSha256: wsha, wasmSize: wsize };
}
