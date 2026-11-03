// Where the game files come from, and the "load your game folder" flow.
//
// The page ships no game data. The player picks the folder of their own copy
// of ATV Quad Power Racing 2 (USA): the one with default.xbe, ATV.bah/ATV.bad,
// Fonts, Licensed, Movies, Music, Sound, user.xml. Before anything is copied,
// default.xbe must be the retail USA build (size and SHA-256) and ATV.bah and
// ATV.bad must be there. The folder is then copied into this origin's OPFS
// (GAME_DIR, in 8 MiB chunks; files already there with the right size are
// skipped, so an interrupted import resumes), and the I/O worker reads it from
// there (vfs.js mountOpfsGame). Nothing is uploaded: the files go from the
// player's disk to the browser's private storage on the same machine.
//
// prepareGame() picks the source:
//   ?forget=1         first deletes the imported files (and the dev cache)
//   ?dev=1            the dev server's /data/ (serve.mjs --game <folder>)
//   ?dev=0            never the dev server
//   otherwise         /data/ when the dev server serves a game folder, else
//                     the imported files, else the import UI (resolves once
//                     an import has finished)
// /save (saves) is not touched by any of this.

export const GAME_DIR = 'atv2-game';           // the player's import
export const CACHE_DIR = 'atv2-game-cache';    // vfs.js block cache of the dev server's /data/
const XBE_SIZE = 1904640;
const XBE_SHA256 = '1e3c2fcebf62709f2f867da846942470ef3455da6c46a0f3eb2f18aec93bd22f';
const CHUNK = 8 << 20;
const MANIFEST = '.import.json';

const $ = (id) => document.getElementById(id);
const MB = (n) => (n / 1048576).toFixed(0);
const isMovie = (path) => /^movies\/[^/]+\.xmv$/i.test(path);
const skipName = (name) => name.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(name);

/** What tests (web/tools/import.mjs) and the page read: phase, message, progress. */
export const loaderState = { phase: 'idle', error: null, progress: null, result: null };

async function opfsRoot() { return navigator.storage.getDirectory(); }

/** The finished import's manifest, or null. */
export async function importedGame() {
  try {
    const dir = await (await opfsRoot()).getDirectoryHandle(GAME_DIR);
    const m = JSON.parse(await (await (await dir.getFileHandle(MANIFEST)).getFile()).text());
    return m.complete ? m : null;
  } catch { return null; }
}

/** Is any game data (finished or partial import, dev cache) in OPFS? */
export async function hasGameData() {
  const root = await opfsRoot();
  for (const n of [GAME_DIR, CACHE_DIR]) { try { await root.getDirectoryHandle(n); return true; } catch { /* none */ } }
  return false;
}

/** Delete the imported game files and the dev cache. Saves stay. */
export async function forgetGame(log = () => {}) {
  const root = await opfsRoot();
  for (const n of [GAME_DIR, CACHE_DIR]) {
    // The previous page's I/O worker may still hold its file handles for a moment.
    for (let tries = 0; ; tries++) {
      try { await root.removeEntry(n, { recursive: true }); log(`[loader] deleted ${n} from this browser's storage`); break; } catch (e) {
        if (e.name === 'NotFoundError') break;
        if (tries > 40) throw new Error(`could not delete ${n}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
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

async function hasXbe(dir) {
  for await (const h of dir.values()) if (h.kind === 'file' && h.name.toLowerCase() === 'default.xbe') return true;
  return false;
}

/** showDirectoryPicker's handle: its own files, or (if the player picked the
 *  folder above) the one subfolder that has default.xbe. */
export async function scanHandle(dir) {
  let root = dir;
  if (!await hasXbe(dir)) {
    for await (const h of dir.values()) if (h.kind === 'directory' && await hasXbe(h)) { root = h; break; }
  }
  return walkHandle(root, '', []);
}

/** <input webkitdirectory>'s files. Paths are '<picked>/<...>'; the game root
 *  is the folder of the shallowest default.xbe. */
export function scanFileList(files) {
  const all = [...files].map((f) => ({ f, rel: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }));
  const xbes = all.filter(({ rel }) => rel.split('/').at(-1).toLowerCase() === 'default.xbe')
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length);
  const base = xbes.length ? xbes[0].rel.slice(0, -'default.xbe'.length) : '';
  return all.filter(({ rel }) => rel.startsWith(base) && !rel.slice(base.length).split('/').some(skipName))
    .map(({ f, rel }) => ({ path: rel.slice(base.length), size: f.size, file: async () => f }));
}

// ---- validation --------------------------------------------------------------

const find = (entries, path) => entries.find((e) => e.path.toLowerCase() === path.toLowerCase());
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const NOT_ATV2 = "This doesn't look like ATV Quad Power Racing 2 (USA).";

/** Throws an Error with a message for the player, or returns the SHA-256. */
export async function validate(entries) {
  const xbe = find(entries, 'default.xbe');
  if (!xbe) throw new Error('There is no default.xbe in that folder. Choose the folder that contains default.xbe ' +
    '(the top folder of your ATV Quad Power Racing 2 disc copy).');
  if (xbe.size !== XBE_SIZE) throw new Error(`${NOT_ATV2} Its default.xbe is ${xbe.size.toLocaleString('en-US')} bytes; ` +
    `the retail USA release's is ${XBE_SIZE.toLocaleString('en-US')} bytes. Only that release is supported.`);
  const sha = hex(await crypto.subtle.digest('SHA-256', await (await xbe.file()).arrayBuffer()));
  if (sha !== XBE_SHA256) throw new Error(`${NOT_ATV2} Its default.xbe has the right size but different contents ` +
    `(SHA-256 ${sha.slice(0, 16)}…), so it is another release or a modified copy. Only the retail USA release is supported.`);
  const missing = ['ATV.bah', 'ATV.bad'].filter((p) => !find(entries, p)?.size);
  if (missing.length) throw new Error(`default.xbe is the right one, but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} ` +
    'missing or empty. Copy the whole disc folder and choose it again.');
  return sha;
}

// ---- import ------------------------------------------------------------------

async function dirFor(top, path) {
  let d = top;
  for (const p of path.split('/').slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  return d;
}

/** Delete what is not part of this import: an interrupted write's temporary
 *  file, or the movies of an earlier import when they are skipped now. */
async function prune(dir, prefix, keep) {
  const gone = [];
  for await (const h of dir.values()) {
    const path = prefix + h.name;
    if (h.kind === 'directory') await prune(h, path + '/', keep);
    else if (path !== MANIFEST && !keep.has(path)) gone.push(h.name);
  }
  for (const n of gone) await dir.removeEntry(n).catch(() => {});
}

/** Copy `entries` into OPFS. onProgress({ file, files, path, done, total, mbps }). */
export async function importEntries(entries, { sha, skipMovies = false, onProgress = () => {} } = {}) {
  const list = entries.filter((e) => !(skipMovies && isMovie(e.path)));
  const total = list.reduce((a, e) => a + e.size, 0);
  const top = await (await opfsRoot()).getDirectoryHandle(GAME_DIR, { create: true });
  try { await top.removeEntry(MANIFEST); } catch { /* none yet */ }

  // What is already there (an interrupted import) and what is left.
  const handles = [];
  let need = 0;
  for (const e of list) {
    const fh = await (await dirFor(top, e.path)).getFileHandle(e.path.split('/').at(-1), { create: true });
    const have = (await fh.getFile()).size;
    handles.push({ e, fh, skip: have === e.size });
    if (have !== e.size) need += e.size;
  }
  const est = await navigator.storage.estimate?.().catch(() => null);
  if (est?.quota && est.quota - est.usage < need) throw new Error(`Not enough browser storage: ${MB(need)} MB needed, ` +
    `${MB(est.quota - est.usage)} MB available. Free some disk space and try again.`);
  const persisted = await navigator.storage.persist?.().catch(() => false);

  const t0 = performance.now();
  let done = 0, copied = 0, skipped = 0, last = 0;
  const report = (i, path, force) => {
    const now = performance.now();
    if (!force && now - last < 100) return;
    last = now;
    onProgress({ file: i, files: list.length, path, done, total, copied, mbps: copied / 1048576 / Math.max(0.001, (now - t0) / 1000) });
  };
  for (let i = 0; i < handles.length; i++) {
    const { e, fh, skip } = handles[i];
    if (skip) { done += e.size; skipped++; report(i + 1, e.path); continue; }
    const file = await e.file();
    if (file.size !== e.size) throw new Error(`${e.path} changed while importing; choose the folder again.`);
    const w = await fh.createWritable();       // written to a temporary file, swapped in on close()
    try {
      for (let at = 0; at < e.size; at += CHUNK) {
        const buf = await file.slice(at, Math.min(e.size, at + CHUNK)).arrayBuffer();
        await w.write(buf);
        done += buf.byteLength; copied += buf.byteLength;
        report(i, e.path);
      }
      await w.close();
    } catch (err) { await w.abort().catch(() => {}); throw err; }
    report(i + 1, e.path, true);
  }
  await prune(top, '', new Set(list.map((e) => e.path)));
  const secs = (performance.now() - t0) / 1000;
  const manifest ={ version: 1, complete: true, game: 'ATV Quad Power Racing 2 (USA)', xbeSha256: sha, skipMovies,
    importedAt: Date.now(), files: list.map((e) => ({ path: e.path, size: e.size })) };
  const mw = await (await top.getFileHandle(MANIFEST, { create: true })).createWritable();
  await mw.write(JSON.stringify(manifest)); await mw.close();
  return { files: list.length, bytes: total, copied, skipped, secs, mbps: copied / 1048576 / Math.max(0.001, secs), persisted };
}

// ---- the page's UI -----------------------------------------------------------

function showError(msg) {
  loaderState.phase = 'error'; loaderState.error = msg;
  const m = $('imp-msg'); m.textContent = msg; m.className = 'err';
}

/** Show the import panel; resolves once a valid folder has been imported. */
function runImporter(log) {
  const panel = $('importer'), pick = $('pick'), input = $('gamedir'), bar = $('imp-bar'), stats = $('imp-stats');
  panel.hidden = false;
  loaderState.phase = 'waiting';
  return new Promise((resolve) => {
    let busy = false;
    const go = async (scan) => {
      if (busy) return;
      busy = true; pick.disabled = true; $('skipmovies').disabled = true;
      $('imp-msg').className = ''; $('imp-msg').textContent = 'Checking the folder…';
      loaderState.phase = 'validating'; loaderState.error = null;
      try {
        const entries = await scan();
        const sha = await validate(entries);
        const skipMovies = $('skipmovies').checked;
        log(`[loader] default.xbe is the retail USA build (SHA-256 ${sha.slice(0, 16)}…); ${entries.length} files`);
        $('imp-msg').textContent = 'This is ATV Quad Power Racing 2 (USA). Copying the files into this browser…';
        loaderState.phase = 'importing';
        bar.hidden = false;
        const r = await importEntries(entries, { sha, skipMovies, onProgress: (p) => {
          loaderState.progress = p;
          bar.max = p.total; bar.value = p.done;
          stats.textContent = `${p.file} / ${p.files} files · ${MB(p.done)} / ${MB(p.total)} MB · ${p.mbps.toFixed(0)} MB/s · ${p.path}`;
        } });
        loaderState.result = r;
        log(`[loader] imported ${r.files} files, ${MB(r.bytes)} MB (${MB(r.copied)} MB copied, ${r.skipped} already there) ` +
          `in ${r.secs.toFixed(1)} s, ${r.mbps.toFixed(0)} MB/s; persistent storage ${r.persisted ? 'granted' : 'not granted'}`);
        stats.textContent = `${r.files} files, ${MB(r.bytes)} MB in ${r.secs.toFixed(1)} s`;
        $('imp-msg').textContent = 'Done. Starting the game…';
        loaderState.phase = 'done';
        panel.hidden = true;
        resolve();
      } catch (e) {
        log(`[loader] ${e.message}`, 'err');
        showError(e.message);
      } finally {
        busy = false; pick.disabled = false; $('skipmovies').disabled = false;
      }
    };
    pick.onclick = async () => {
      if (window.showDirectoryPicker) {
        let dir;
        try { dir = await window.showDirectoryPicker({ id: 'atv2-game', mode: 'read' }); } catch (e) {
          if (e.name === 'AbortError') return;      // the player closed the picker
          input.click(); return;                    // e.g. not allowed here: the classic picker
        }
        go(() => scanHandle(dir));
      } else input.click();
    };
    input.onchange = () => { if (input.files.length) go(() => scanFileList(input.files)); input.value = ''; };
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
 * Decide where /game comes from (see the top of this file). Returns
 * { source: 'server', base } or { source: 'opfs', dir, manifest }.
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
    const r = await fetch('/data/manifest.json', { method: 'HEAD', cache: 'no-store' }).catch(() => null);
    if (r?.ok) { loaderState.phase = 'dev'; return { source: 'server', base: '/data' }; }
    if (dev === '1') throw new Error('?dev=1, but the dev server serves no game folder (start serve.mjs with --game <folder>)');
  }
  let m = await importedGame();
  if (!m) {
    if (await hasGameData()) $('forget').hidden = false;
    $('status').textContent = 'Choose your ATV 2 game folder to start';
    await runImporter(log);
    m = await importedGame();
    if (!m) throw new Error('the import finished but its file list is missing');
  }
  loaderState.phase = 'ready';
  $('forget').hidden = false;
  return { source: 'opfs', dir: GAME_DIR, manifest: m };
}
