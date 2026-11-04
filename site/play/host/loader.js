// Where the game files come from, and the "load your game folder" flow.
//
// The page ships no game data. The player picks the folder of their own copy
// of ATV Quad Power Racing 2 (USA): the one with default.xbe, ATV.bah/ATV.bad,
// Fonts, Licensed, Movies, Music, Sound, user.xml. Before anything is copied,
// the game profile's checks run (profiles/atv2.json: default.xbe must be the
// retail USA build by size and SHA-256, ATV.bah and ATV.bad must be there).
// The folder is then stored in this origin's OPFS by the shared delivery
// client (assetsource.js LocalImportSource: hashed while written, .part +
// rename, marked; files already stored from the same folder are not copied
// again, so an interrupted import resumes), and the I/O worker reads it from
// there (vfs.js mountStore). Nothing is uploaded: the files go from the
// player's disk to the browser's private storage on the same machine.
//
// prepareGame() picks the asset source (assetsource.js):
//   ?forget=1         first deletes the stored files (and the dev cache)
//   ?dev=1            the dev server's /data/ (serve.mjs --game <folder>)
//   ?dev=0            never the dev server
//   otherwise         /data/ when the dev server serves a game folder, else
//                     the stored import, else the import UI (resolves once
//                     an import has finished)
// /save (saves) is not touched by any of this. Saves never go into the game
// files either: a game folder's own UDATA/TDATA/CACHE/TitleCache (older
// native builds kept saves there) is left out of the import (the profile's
// skipFolders); saves.js imports saves.
//
// [siteplay] On the project site (deploy.js mode 'site') there is no server
// with /data/ or /wasm/: the player picks the play folder their builder made,
// which also holds their game build (atv2.wasm, gamebuild.js). It is checked
// after default.xbe and stored with the game files (catalog path
// build/atv2.wasm), and the game is ready only when both are there and the
// build is one this page accepts. importFolder() is the whole pick -> check
// -> store, used by this page's import panel and by the site's own Play panel
// (same origin, same OPFS).
import { SITE } from './deploy.js';
import { BuildError, STALE_TEXT } from './gamebuild.js';
import { localSource, gameProfile, DevServerSource, CACHE_DIR } from './assetsource.js';
import { runChecks, skipped } from './delivery/profile.js';

/** The store's folders before the shared delivery store (migrated by assetsource.js); kept for the Game data names. */
export const GAME_DIR = 'atv2-game';
export { CACHE_DIR };

const $ = (id) => document.getElementById(id);
const MB = (n) => (n / 1048576).toFixed(0);
const skipName = (name) => name.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(name);
/** Top-level folders of a game folder that hold saves or scratch, not game files (the profile's skipFolders). */
export const SAVE_FOLDERS = /^(udata|tdata|cache|titlecache)$/i;
const notSaves = async (entries) => {
  const p = await gameProfile();
  const keep = entries.filter((e) => !skipped(p, e.path));
  loaderState.savesLeftOut = entries.length - keep.length;
  keep.skippedSaves = loaderState.savesLeftOut;
  return keep;
};

/** What tests (web/tools/import.mjs) and the page read: phase, message, progress. */
export const loaderState = { phase: 'idle', error: null, progress: null, result: null };

/** The finished import's record ({ complete, game, xbeSha256, skipMovies, importedAt, files }), or null. */
export async function importedGame() {
  const src = await localSource();
  const cat = await src.catalog().catch(() => null);
  return cat ? src.record(cat) : null;
}

/** Is any game data (a store, an older layout, the dev cache) in OPFS? */
export async function hasGameData() { return (await localSource()).hasData(); }

/** Delete the stored game files, the game build and the dev cache. Saves stay. */
export async function forgetGame(log = () => {}) { return (await localSource()).forget(log); }

/** Game files ready to play: the import's record (on the site only with an accepted game build kept too), else null. */
export async function readyGame() {
  const s = await (await localSource()).status({ fresh: true });
  return s.ready ? { ...s.record, build: s.build } : null;
}

/** Why the game is not ready, without a new check: { ready, reason } ('none' | 'stale' | 'nobuild' | 'damaged'). */
export async function gameState() {
  const s = await (await localSource()).status();
  return { ready: s.ready, reason: s.reason };
}

// ---- reading the picked folder ---------------------------------------------
// An entry: { path: 'Movies/Climax.xmv' (relative to the game root), size, file: () => Promise<File> }.

async function walkHandle(dir, prefix, out) {
  for await (const h of dir.values()) {
    if (skipName(h.name)) continue;
    const path = prefix + h.name;
    if (h.kind === 'directory') await walkHandle(h, path + '/', out);
    else { const f = await h.getFile(); out.push({ path, size: f.size, file: async () => f }); }
  }
  return out;
}

async function hasRoot(dir, marker) {
  for await (const h of dir.values()) if (h.kind === 'file' && h.name.toLowerCase() === marker) return true;
  return false;
}

/** showDirectoryPicker's handle: its own files, or (if the player picked the
 *  folder above) the one subfolder that has the profile's root file (default.xbe). */
export async function scanHandle(dir) {
  const marker = (await gameProfile()).local.root.toLowerCase();
  let root = dir;
  if (!await hasRoot(dir, marker)) {
    for await (const h of dir.values()) if (h.kind === 'directory' && await hasRoot(h, marker)) { root = h; break; }
  }
  return notSaves(await walkHandle(root, '', []));
}

/** <input webkitdirectory>'s files. Paths are '<picked>/<...>'; the game root
 *  is the folder of the shallowest root file (default.xbe). */
export async function scanFileList(files) {
  const marker = (await gameProfile()).local.root.toLowerCase();
  const all = [...files].map((f) => ({ f, rel: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }));
  const roots = all.filter(({ rel }) => rel.split('/').at(-1).toLowerCase() === marker)
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length);
  const base = roots.length ? roots[0].rel.slice(0, -marker.length) : '';
  return notSaves(all.filter(({ rel }) => rel.startsWith(base) && !rel.slice(base.length).split('/').some(skipName))
    .map(({ f, rel }) => ({ path: rel.slice(base.length), size: f.size, file: async () => f })));
}

// ---- validation --------------------------------------------------------------

/** The profile's checks (default.xbe, ATV.bah/.bad): throws an Error with a message for the player, or returns default.xbe's SHA-256. */
export async function validate(entries) {
  const p = await gameProfile();
  return (await runChecks(p, entries))[p.local.checks[0].path];
}

// ---- import ------------------------------------------------------------------

/**
 * Check a picked folder and store it: default.xbe, then (on the site) the
 * game build, then the store (assetsource.js LocalImportSource.importFolder).
 * scan: () => entries (scanHandle / scanFileList). onPhase(phase, text)
 * follows it ('validating', 'importing', 'done'); onProgress({ file, files,
 * path, done, total, copied, mbps }). Throws an Error (a BuildError for the
 * build) whose message is for the player. Returns { files, bytes, copied,
 * skipped, secs, mbps, persisted, sha, build }.
 */
export async function importFolder(scan, opts = {}) {
  return (await localSource()).importFolder(scan, opts);
}

/**
 * Open the folder picker: showDirectoryPicker, which resolves with a scan
 * function for importFolder (null when the player closed it); else, or when
 * it is refused, the <input webkitdirectory> `input` is clicked and null
 * returned: the caller's input.onchange takes it from there (inputScan).
 */
export async function pickFolder(input) {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ id: SITE ? 'atv2-play' : 'atv2-game', mode: 'read' });
      return () => scanHandle(dir);
    } catch (e) {
      if (e.name === 'AbortError') return null;      // the player closed the picker
      /* e.g. not allowed here: the classic picker below */
    }
  }
  input.click();
  return null;
}

/** The <input webkitdirectory>'s files as a scan function (null when empty); clears the input. */
export function inputScan(input) {
  const files = [...input.files];
  input.value = '';
  return files.length ? () => scanFileList(files) : null;
}

// ---- the page's UI -----------------------------------------------------------

function showError(msg, link = null) {
  loaderState.phase = 'error'; loaderState.error = msg;
  const m = $('imp-msg'); m.textContent = msg; m.className = 'err';
  if (link) { const a = document.createElement('a'); a.href = link.href; a.textContent = link.text; m.append(' ', a); }
}

/** Show the import panel; resolves once a valid folder has been imported. */
function runImporter(log, note = '') {
  const panel = $('importer'), pick = $('pick'), input = $('gamedir'), bar = $('imp-bar'), stats = $('imp-stats');
  panel.hidden = false;
  loaderState.phase = 'waiting';
  if (note) { $('imp-msg').textContent = note; $('imp-msg').className = 'err'; }
  return new Promise((resolve) => {
    let busy = false;
    const go = async (scan) => {
      if (busy) return;
      busy = true; pick.disabled = true; $('skipmovies').disabled = true;
      $('imp-msg').className = ''; $('imp-msg').textContent = 'Checking the folder…';
      loaderState.phase = 'validating'; loaderState.error = null; loaderState.errorKind = null;
      try {
        const r = await importFolder(scan, { skipMovies: $('skipmovies').checked, log,
          onPhase: (phase, text) => {
            loaderState.phase = phase;
            $('imp-msg').textContent = phase === 'done' ? 'Done. Starting the game…' : text;
            if (phase === 'importing') bar.hidden = false;
          },
          onProgress: (p) => {
            loaderState.progress = p;
            bar.max = p.total; bar.value = p.done;
            stats.textContent = `${p.file} / ${p.files} files · ${MB(p.done)} / ${MB(p.total)} MB · ${p.mbps.toFixed(0)} MB/s · ${p.path}`;
          } });
        loaderState.result = r;
        stats.textContent = `${r.files} files, ${MB(r.bytes)} MB in ${r.secs.toFixed(1)} s`;
        loaderState.phase = 'done';
        panel.hidden = true;
        resolve();
      } catch (e) {
        log(`[loader] ${e.message}`, 'err');
        loaderState.errorKind = e instanceof BuildError ? e.kind : 'game';
        showError(e.message, e.link);
      } finally {
        busy = false; pick.disabled = false; $('skipmovies').disabled = false;
      }
    };
    pick.onclick = async () => {
      const scan = await pickFolder(input);
      if (scan) go(scan);
    };
    input.onchange = () => { const scan = inputScan(input); if (scan) go(scan); };
  });
}

/** The "Forget game files" button: a second click within 4 s confirms; the
 *  page reloads with ?forget=1 so that no worker holds the files open. */
function wireForget() {
  const b = $('forget');
  if (!b) return;
  let armed = 0;
  b.onclick = () => {
    if (Date.now() - armed > 4000) { armed = Date.now(); b.textContent = 'Click again to delete the game files from this browser';
      setTimeout(() => { if (Date.now() - armed >= 4000) b.textContent = 'Forget game files'; }, 4100); return; }
    const u = new URL(location.href); u.searchParams.set('forget', '1');
    location.replace(u);
  };
}

/**
 * The asset source prepareGame() will return when it needs no UI and deletes
 * nothing (the dev server's /data/, or a ready import), else null. No side
 * effects beyond a one-time move of an older store layout: main.js uses it
 * to start the game threads while the GPU comes up.
 */
export async function peekGame(q) {
  if (q.has('forget')) return null;
  const dev = q.get('dev');
  if (dev !== '0') {
    if (await DevServerSource.available()) return new DevServerSource(await gameProfile());
    if (dev === '1') return null;
  }
  // A catalog with an accepted build: the threads start now; the stored files'
  // check (status()) runs meanwhile and must pass before the I/O worker mounts them.
  const src = await localSource();
  return (await src.quick()) ? src : null;
}

export const DAMAGED_TEXT = 'Some of the game files kept in this browser are missing or damaged. Select your local game files again (the files that are still good are not copied again).';

/**
 * Decide where the game comes from (see the top of this file). Returns the
 * asset source (assetsource.js): a DevServerSource or the LocalImportSource,
 * ready to boot.
 */
export async function prepareGame({ q, log }) {
  wireForget();
  if (q.has('forget')) {
    await forgetGame(log);
    const u = new URL(location.href); u.searchParams.delete('forget'); history.replaceState(null, '', u);
    q.delete('forget');
  }
  const dev = q.get('dev');
  if (dev !== '0') {
    if (await DevServerSource.available()) { loaderState.phase = 'dev'; return new DevServerSource(await gameProfile()); }
    if (dev === '1') throw new Error('?dev=1, but the dev server serves no game folder (start serve.mjs with --game <folder>)');
  }
  const src = await localSource();
  let st = await src.status();
  if (src.migrated) log(`[loader] moved the game files kept by an earlier version of this page into the shared store (${src.migrated.files} files, ${src.migrated.ms} ms)`);
  if (!st.ready) {
    if (await hasGameData()) $('forget').hidden = false;
    $('status').textContent = SITE ? 'Select your local game files to start' : 'Choose your ATV 2 game folder to start';
    // Game files kept, but a build for an earlier version of the page, or damaged files.
    await runImporter(log, st.reason === 'stale' ? STALE_TEXT() : st.reason === 'damaged' ? DAMAGED_TEXT : '');
    st = await src.status({ fresh: true });
    if (!st.ready) throw new Error(`the import finished but the stored files are not ready (${st.reason})`);
  }
  loaderState.phase = 'ready';
  loaderState.verify = st.verify ?? null;
  $('forget').hidden = false;
  return src;
}
