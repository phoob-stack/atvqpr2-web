// Saves in the browser: persistence in OPFS, export/import, backups.
//
// The game's saves are what the runtime puts under UDATA\ and TDATA\ of its
// save dir (xbox_path_init; natively %LOCALAPPDATA%\xboxrecomp or
// RECOMP_SAVE_DIR): UDATA\4143000a\<save>\... (profiles, records, settings,
// unlocks) and TDATA\4143000a\. The rest of the save dir (Partition*.img,
// Cache, TitleCache, SystemData...) is scratch the runtime recreates.
//
// In the browser /save is in memory (vfs.js MemFile); this file keeps its
// UDATA and TDATA in OPFS (SAVE_DIR, same layout):
//   - the I/O worker copies SAVE_DIR into /save before the game starts
//     (loadSaves), then after every guest file call compares UDATA/TDATA with
//     what it last sent (SaveSync, cheap: one counter compare unless a file in
//     /save changed) and posts the changed files to the page as
//     {type:'saves', ops}: on close/sync/rename/unlink/mkdir at once, else at
//     most every 250 ms;
//   - the page writes them (SaveStore, in order; createWritable swaps a file
//     in whole on close()).
// The I/O worker cannot do this itself: it sits in a synchronous loop
// answering guest calls (io.js), and OPFS directory calls are async.
//
// Export: one .zip in the Windows build's layout (UDATA/4143000a/...,
// TDATA/4143000a/..., plus atv2-saves.json describing it). Extracted into
// %LOCALAPPDATA%\xboxrecomp (or a RECOMP_SAVE_DIR) the native build uses it.
// Import: that zip, any zip of a native save dir, or a native save folder
// picked on disk. Everything is checked first (zip structure, CRC-32, paths,
// names, sizes, that there are ATV 2 saves at all). Then the current saves
// are copied to BACKUP_DIR/<time>/ (the newest KEEP_BACKUPS are kept), the
// new ones are written to INCOMING_DIR with a marker written last, and the
// page reloads; the next I/O worker swaps INCOMING_DIR in before it loads
// (commitIncoming), so an interrupted import leaves the old saves in place.
//
// Saves are never in the game-files import (loader.js skips UDATA/TDATA in a
// game folder) and "Forget game files" never touches them.
//
// ?saves=off: saves in memory only, starting empty (the tools' routes need
// the no-save menus).
import { Dir, MemFile, memGen } from './vfs.js';
import { readZip, writeZip } from './zip.js';

export const SAVE_DIR = 'atv2-saves';
export const BACKUP_DIR = 'atv2-saves-backups';
export const INCOMING_DIR = 'atv2-saves-incoming';
export const ROOTS = ['UDATA', 'TDATA'];
export const TITLE_ID = '4143000a';            // ATV Quad Power Racing 2
const COMPLETE = '.complete';                  // INCOMING_DIR's marker, written last
const MANIFEST = 'atv2-saves.json';            // in the export zip
const KEEP_BACKUPS = 5;
const MAX_FILES = 4096, MAX_BYTES = 64 << 20;
const FATX_NAME_MAX = 42;

const opfsRoot = () => navigator.storage.getDirectory();
const isNotFound = (e) => e?.name === 'NotFoundError';

async function dirAt(top, parts, create) {
  let d = top;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return d;
}

/** Every file and directory under an OPFS directory: [{ path, dir, data?, mtime }]. */
export async function readTree(dir, prefix = '', out = []) {
  for await (const h of dir.values()) {
    const path = prefix + h.name;
    if (h.kind === 'directory') { out.push({ path, dir: true }); await readTree(h, path + '/', out); }
    else { const f = await h.getFile(); out.push({ path, dir: false, data: new Uint8Array(await f.arrayBuffer()), mtime: f.lastModified }); }
  }
  return out;
}

async function writeTree(top, files) {
  for (const f of files) {
    const parts = f.path.split('/');
    if (f.dir) { await dirAt(top, parts, true); continue; }
    const fh = await (await dirAt(top, parts.slice(0, -1), true)).getFileHandle(parts.at(-1), { create: true });
    const w = await fh.createWritable();
    try { await w.write(f.data); await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; }
  }
}

async function removeDir(root, name) {
  try { await root.removeEntry(name, { recursive: true }); } catch (e) { if (!isNotFound(e)) throw e; }
}

// ---- the I/O worker's side ---------------------------------------------------

/**
 * A finished import waiting in INCOMING_DIR (its marker is there) replaces
 * SAVE_DIR; an unfinished one is dropped. Returns a note or ''.
 */
export async function commitIncoming() {
  const root = await opfsRoot();
  let inc;
  try { inc = await root.getDirectoryHandle(INCOMING_DIR); } catch { return ''; }
  let done = false;
  try { await inc.getFileHandle(COMPLETE); done = true; } catch { /* unfinished */ }
  if (!done) { await removeDir(root, INCOMING_DIR); return 'dropped an unfinished save import'; }
  const files = (await readTree(inc)).filter((f) => f.path !== COMPLETE);
  await removeDir(root, SAVE_DIR);
  await writeTree(await root.getDirectoryHandle(SAVE_DIR, { create: true }), files);
  await removeDir(root, INCOMING_DIR);
  return `imported saves swapped in (${files.filter((f) => !f.dir).length} files)`;
}

/** /save/UDATA and /save/TDATA always exist, so the runtime never looks for
 *  saves in the (read-only) game folder (kernel_path.c s_user_in_game). */
export function ensureRoots(saveNode) {
  for (const r of ROOTS) if (!saveNode.get(r)) saveNode.add(new Dir(r));
}

/** Copy SAVE_DIR from OPFS into the in-memory /save. Returns { files, bytes, note }. */
export async function loadSaves(saveNode) {
  let note = '';
  try { note = await commitIncoming(); } catch (e) { note = `save import not swapped in: ${e.message}`; }
  ensureRoots(saveNode);
  let top;
  try { top = await (await opfsRoot()).getDirectoryHandle(SAVE_DIR); } catch { return { files: 0, bytes: 0, note }; }
  let files = 0, bytes = 0;
  for (const f of await readTree(top)) {
    const parts = f.path.split('/');
    if (!ROOTS.includes(parts[0])) continue;
    let d = saveNode;
    for (const p of parts.slice(0, f.dir ? parts.length : -1)) d = d.get(p) ?? d.add(new Dir(p));
    if (f.dir) continue;
    const m = d.add(new MemFile(parts.at(-1)));
    m.write(0, f.data);
    m.mtime = BigInt(Math.round(f.mtime * 1e6));
    files++; bytes += f.data.length;
  }
  return { files, bytes, note };
}

const FLUSH_NOW = new Set(['fd_close', 'fd_sync', 'fd_datasync', 'path_create_directory', 'path_remove_directory',
  'path_unlink_file', 'path_rename']);

/** Watches /save's UDATA and TDATA and posts what changed (see the top). */
export class SaveSync {
  constructor(saveNode, post) {
    this.save = saveNode; this.post = post;
    this.prev = this.scan(); this.gen = memGen.gen; this.dirtyAt = 0;
    this.sent = { flushes: 0, puts: 0, rms: 0, bytes: 0 };
  }

  scan() {
    const m = new Map();
    const walk = (d, prefix) => {
      for (const n of d.children.values()) {
        const path = prefix + n.name;
        m.set(path, { node: n, kind: n.kind, gen: n.gen ?? 0 });
        if (n.kind === 'dir') walk(n, path + '/');
      }
    };
    for (const r of ROOTS) { const d = this.save.get(r); if (d?.kind === 'dir') { m.set(r, { node: d, kind: 'dir' }); walk(d, r + '/'); } }
    return m;
  }

  /** After every guest file call (`name` is the WASI call). */
  poke(name) {
    if (memGen.gen === this.gen) return;
    const now = performance.now();
    if (!this.dirtyAt) this.dirtyAt = now;
    if (FLUSH_NOW.has(name) || now - this.dirtyAt > 250) this.flush();
  }

  flush() {
    this.gen = memGen.gen; this.dirtyAt = 0;
    const cur = this.scan(), ops = [], transfer = [];
    for (const [p, e] of this.prev) {
      const c = cur.get(p);
      if (!c || c.kind !== e.kind) ops.push({ op: 'rm', path: p });
    }
    for (const [p, c] of cur) {
      const e = this.prev.get(p);
      if (e && e.kind === c.kind && (c.kind === 'dir' || (e.node === c.node && e.gen === c.gen))) continue;
      if (c.kind === 'dir') { ops.push({ op: 'mkdir', path: p }); continue; }
      const data = new Uint8Array(c.node.size);
      c.node.read(0, data);
      ops.push({ op: 'put', path: p, data });
      transfer.push(data.buffer);
      this.sent.bytes += data.length;
    }
    this.prev = cur;
    if (!ops.length) return;
    this.sent.flushes++;
    for (const o of ops) if (o.op === 'put') this.sent.puts++; else if (o.op === 'rm') this.sent.rms++;
    this.post({ type: 'saves', ops }, transfer);
  }
}

// ---- checking an import ----------------------------------------------------------

const BAD_CHARS = /[\u0000-\u001f<>:"|?*\\]/;

/**
 * Raw entries from a zip or a folder ([{ path, dir, data, mtime }], any
 * prefix, '\' or '/') -> the ATV 2 save files in SAVE_DIR's layout:
 * { files: [{ path: 'UDATA/4143000a/...', dir, data, mtime }], notes: [] }.
 * Throws an Error with a message for the player; nothing has been written
 * when it does.
 */
export function checkSaveEntries(raw, what = 'This file') {
  const notes = [], files = [], seen = new Set(), others = new Set();
  let prefix = null, manifest = null;
  for (const e of raw) {
    const segs = e.path.replace(/\\/g, '/').split('/').filter((s, i, a) => s !== '' || i === a.length - 1).filter((s) => s !== '.');
    if (segs.at(-1) === '') segs.pop();
    if (!segs.length) continue;
    if (segs.some((s) => s === '..') || /^[a-z]:$/i.test(segs[0])) throw new Error(`${what} has an unsafe path (${e.path}); it was not imported.`);
    const ri = segs.findIndex((s) => ROOTS.includes(s.toUpperCase()));
    if (ri < 0) {
      if (!e.dir && segs.at(-1) === MANIFEST) manifest = e;
      continue;                                  // Partition*.img, Cache, ... : not saves
    }
    const pre = segs.slice(0, ri).join('/').toLowerCase();
    if (prefix === null) prefix = pre;
    else if (prefix !== pre) throw new Error(`${what} has more than one save folder (${prefix || '(top)'} and ${pre || '(top)'}); import one at a time.`);
    const rest = segs.slice(ri);
    rest[0] = rest[0].toUpperCase();
    if (rest.length === 1) continue;             // UDATA/ itself
    if (rest[1].toLowerCase() !== TITLE_ID) { others.add(`${rest[0]}/${rest[1]}`); continue; }
    rest[1] = TITLE_ID;
    for (const s of rest.slice(2)) {
      if (BAD_CHARS.test(s) || s.length > FATX_NAME_MAX || /[. ]$/.test(s))
        throw new Error(`${what} has a name the Xbox cannot store (${JSON.stringify(s)}); it was not imported.`);
    }
    const path = rest.join('/'), key = path.toLowerCase();
    if (seen.has(key)) { if (e.dir) continue; throw new Error(`${what} has ${path} twice; it was not imported.`); }
    seen.add(key);
    files.push({ path, dir: !!e.dir, data: e.dir ? undefined : e.data, mtime: e.mtime ?? Date.now() });
  }
  if (manifest) {
    let m;
    try { m = JSON.parse(new TextDecoder().decode(manifest.data)); } catch { throw new Error(`${what}: its ${MANIFEST} is damaged.`); }
    if (m.format !== 'atv2-saves') throw new Error(`${what}: ${MANIFEST} is not an ATV 2 save archive's.`);
    if (m.version > 1) throw new Error(`${what} was made by a newer version of this page (format ${m.version}); update the page first.`);
    if (m.titleId && m.titleId.toLowerCase() !== TITLE_ID) throw new Error(`${what} holds saves of another game (title ${m.titleId}).`);
  }
  const real = files.filter((f) => !f.dir);
  if (others.size) notes.push(`skipped other games' saves: ${[...others].join(', ')}`);
  if (!real.length) throw new Error(`${what} has no ATV Quad Power Racing 2 saves (no files under UDATA\\${TITLE_ID} or TDATA\\${TITLE_ID}).` +
    (others.size ? ` It has saves of other games only (${[...others].join(', ')}).` : ''));
  if (real.length > MAX_FILES) throw new Error(`${what} has ${real.length} save files; that is not an ATV 2 save.`);
  const bytes = real.reduce((a, f) => a + f.data.length, 0);
  if (bytes > MAX_BYTES) throw new Error(`${what} has ${(bytes / 1048576).toFixed(0)} MB of saves; that is not an ATV 2 save.`);
  // Every save folder of the title has its SaveMeta.xbx (the dashboard's name for it).
  const saveDirs = new Set(real.map((f) => f.path.split('/')).filter((s) => s[0] === 'UDATA' && s.length > 3).map((s) => s[2].toLowerCase()));
  for (const d of saveDirs)
    if (!real.some((f) => f.path.toLowerCase() === `udata/${TITLE_ID}/${d}/savemeta.xbx`)) notes.push(`save folder ${d} has no SaveMeta.xbx`);
  // Directories the files need (a zip may list only files).
  const dirs = new Set(files.filter((f) => f.dir).map((f) => f.path));
  for (const f of [...files]) {
    const s = f.path.split('/');
    for (let i = 1; i < s.length; i++) {
      const p = s.slice(0, i).join('/');
      if (!dirs.has(p)) { dirs.add(p); files.push({ path: p, dir: true }); }
    }
  }
  files.sort((a, b) => (a.dir === b.dir ? a.path.localeCompare(b.path) : a.dir ? -1 : 1));
  return { files, notes, count: real.length, bytes };
}

/** A native save folder picked with showDirectoryPicker: only its UDATA/TDATA
 *  of this title are read (never the multi-GB Partition*.img next to them). */
export async function scanSaveFolder(dir) {
  const out = [];
  const take = async (d, prefix) => {
    for await (const h of d.values()) {
      const path = `${prefix}/${h.name}`;
      if (h.kind === 'directory') { out.push({ path, dir: true }); await take(h, path); }
      else { const f = await h.getFile(); out.push({ path, dir: false, data: new Uint8Array(await f.arrayBuffer()), mtime: f.lastModified }); }
    }
  };
  const roots = async (d, prefix) => {
    let found = false;
    for await (const h of d.values()) {
      if (h.kind !== 'directory' || !ROOTS.includes(h.name.toUpperCase())) continue;
      found = true;
      for await (const t of h.values())
        if (t.kind === 'directory' && t.name.toLowerCase() === TITLE_ID) await take(t, `${prefix}${h.name}/${t.name}`);
        else out.push({ path: `${prefix}${h.name}/${t.name}`, dir: t.kind === 'directory', data: new Uint8Array(0) });
    }
    return found;
  };
  if (await roots(dir, '')) return out;
  // The player may have picked the folder above (e.g. ...\Local with xboxrecomp in it).
  for await (const h of dir.values()) if (h.kind === 'directory' && await roots(h, `${h.name}/`)) return out;
  throw new Error('That folder has no UDATA or TDATA folder. Choose the save folder of the Windows build ' +
    '(%LOCALAPPDATA%\\xboxrecomp, or the folder RECOMP_SAVE_DIR names).');
}

/** <input webkitdirectory>'s files: only UDATA/TDATA ones are read. */
export async function scanSaveFileList(list) {
  const out = [];
  for (const f of list) {
    const path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    if (!path.split('/').some((s) => ROOTS.includes(s.toUpperCase()))) continue;
    out.push({ path, dir: false, data: new Uint8Array(await f.arrayBuffer()), mtime: f.lastModified });
  }
  return out;
}

// ---- the page's side -------------------------------------------------------------

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

export class SaveStore {
  constructor({ log = () => {}, mode = 'opfs' } = {}) {
    this.log = log; this.mode = mode;
    this.q = Promise.resolve();
    this.frozen = mode === 'off' ? 'saves are off (?saves=off)' : null;
    this.stats = { flushes: 0, puts: 0, rms: 0, bytes: 0, lastAt: 0, errors: 0, dropped: 0 };
  }

  /** One tab writes the saves; a second one would overwrite the first's. */
  async lock() {
    if (this.mode === 'off' || !navigator.locks) return true;
    return new Promise((resolve) => {
      navigator.locks.request('atv2-saves', { ifAvailable: true }, (l) => {
        if (!l) { this.frozen = 'another tab of this page has the saves'; resolve(false); return undefined; }
        resolve(true);
        return new Promise(() => {});           // held until the page goes away
      });
    });
  }

  /** {type:'saves', ops} from the I/O worker. */
  apply(ops) {
    if (this.frozen) { this.stats.dropped += ops.length; return; }
    this.q = this.q.then(async () => {
      const top = await (await opfsRoot()).getDirectoryHandle(SAVE_DIR, { create: true });
      for (const o of ops) {
        const parts = o.path.split('/');
        if (o.op === 'rm') {
          try { await (await dirAt(top, parts.slice(0, -1), false)).removeEntry(parts.at(-1), { recursive: true }); this.stats.rms++; }
          catch (e) { if (!isNotFound(e)) throw e; }
        } else if (o.op === 'mkdir') await dirAt(top, parts, true);
        else if (o.op === 'put') { await writeTree(top, [{ path: o.path, data: o.data }]); this.stats.puts++; this.stats.bytes += o.data.length; }
      }
      this.stats.flushes++; this.stats.lastAt = Date.now();
    }).catch((e) => { this.stats.errors++; this.log(`[saves] could not write the saves to browser storage: ${e.message}`, 'err'); });
  }

  /** Resolves once everything posted so far is in OPFS. */
  idle() { return this.q; }

  async current() {
    await this.idle();
    try { return await readTree(await (await opfsRoot()).getDirectoryHandle(SAVE_DIR)); } catch { return []; }
  }

  async summary() {
    const t = await this.current(), files = t.filter((f) => !f.dir);
    const saves = new Set(files.map((f) => f.path.split('/')).filter((s) => s[0] === 'UDATA' && s.length > 3).map((s) => s[2]));
    return { files: files.length, bytes: files.reduce((a, f) => a + f.data.length, 0), saves: saves.size,
      newest: files.reduce((a, f) => Math.max(a, f.mtime), 0), paths: files.map((f) => `${f.path} ${f.data.length}`) };
  }

  /** The export zip (Uint8Array), or null when there are no saves. */
  async exportZip() {
    const t = await this.current(), files = t.filter((f) => !f.dir);
    if (!files.length) return null;
    const manifest = { format: 'atv2-saves', version: 1, game: 'ATV Quad Power Racing 2', titleId: TITLE_ID,
      exportedAt: new Date().toISOString(),
      layout: 'Extract into the Windows build\'s save folder (%LOCALAPPDATA%\\xboxrecomp, or RECOMP_SAVE_DIR) to use there.',
      files: files.map((f) => ({ path: f.path, size: f.data.length })) };
    return writeZip([{ path: MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) },
      ...t.map((f) => (f.dir ? { path: f.path + '/', mtime: Date.now() } : { path: f.path, data: f.data, mtime: f.mtime }))]);
  }

  async backups() {
    try {
      const d = await (await opfsRoot()).getDirectoryHandle(BACKUP_DIR);
      const names = [];
      for await (const h of d.values()) if (h.kind === 'directory') names.push(h.name);
      return names.sort().reverse();
    } catch { return []; }
  }

  /**
   * Replace the saves with `files` (checkSaveEntries' output): back up the
   * current ones, stage the new ones, and stop taking the running game's
   * writes. The caller reloads the page; the next I/O worker swaps them in.
   */
  async replace(files, { reason = 'import' } = {}) {
    if (this.mode === 'off') throw new Error('Saves are off on this page (?saves=off).');
    if (this.frozen && this.frozen !== 'importing') throw new Error(`Saves cannot be changed: ${this.frozen}.`);
    await this.idle();
    this.frozen = 'importing';
    const root = await opfsRoot();
    let backup = null;
    const cur = await this.current();
    if (cur.some((f) => !f.dir)) {
      backup = `${stamp(Date.now())}-before-${reason}`;
      await writeTree(await dirAt(root, [BACKUP_DIR, backup], true), cur);
      const all = await this.backups();
      const bd = await root.getDirectoryHandle(BACKUP_DIR);
      for (const old of all.slice(KEEP_BACKUPS)) await bd.removeEntry(old, { recursive: true }).catch(() => {});
    }
    await removeDir(root, INCOMING_DIR);
    const inc = await root.getDirectoryHandle(INCOMING_DIR, { create: true });
    await writeTree(inc, files);
    await writeTree(inc, [{ path: COMPLETE, data: new TextEncoder().encode(String(Date.now())) }]);
    this.log(`[saves] ${reason}: ${files.filter((f) => !f.dir).length} files staged` +
      (backup ? `; the previous saves are in browser storage as ${BACKUP_DIR}/${backup}` : '; there were no saves before'));
    return { backup };
  }

  async importZip(u8, what = 'This file') {
    const raw = await readZip(u8, { maxEntries: MAX_FILES * 2, maxBytes: MAX_BYTES,
      keep: (p) => p.replace(/\\/g, '/').split('/').some((s) => ROOTS.includes(s.toUpperCase())) || p.endsWith(MANIFEST) });
    const c = checkSaveEntries(raw, what);
    const r = await this.replace(c.files, { reason: 'import' });
    return { ...c, ...r };
  }

  async importEntries(raw, what = 'That folder') {
    const c = checkSaveEntries(raw, what);
    const r = await this.replace(c.files, { reason: 'folder-import' });
    return { ...c, ...r };
  }

  async restoreBackup(name) {
    const d = await dirAt(await opfsRoot(), [BACKUP_DIR, name], false);
    const c = checkSaveEntries(await readTree(d), `Backup ${name}`);
    const r = await this.replace(c.files, { reason: 'restore' });
    return { ...c, ...r };
  }
}

// ---- the page's UI ---------------------------------------------------------------

/** The "Saves" button and panel (index.html). `reload` restarts the page. */
export function wireSavesUI(store, { reload = () => location.reload() } = {}) {
  const $ = (id) => document.getElementById(id);
  const btn = $('saves-btn'), panel = $('saves');
  if (!btn || !panel) return;
  btn.hidden = false;
  const msg = (text, cls = '') => { $('saves-msg').textContent = text; $('saves-msg').className = cls; };
  const refresh = async () => {
    const s = await store.summary();
    $('saves-info').textContent = store.mode === 'off' ? 'Saves are off on this page (?saves=off): nothing is kept.' :
      s.files ? `${s.saves} save${s.saves === 1 ? '' : 's'} (${s.files} files, ${(s.bytes / 1024).toFixed(0)} KB) kept in this browser; ` +
        `last written ${new Date(s.newest).toLocaleString()}.` : 'No saves in this browser yet.';
    $('saves-export').disabled = !s.files;
    const b = await store.backups();
    $('saves-restore').hidden = !b.length;
    $('saves-restore').textContent = b.length ? `Restore the saves from before the last import (${b[0].slice(0, 15)})` : '';
    $('saves-restore').dataset.name = b[0] ?? '';
  };
  btn.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) { msg(''); refresh().catch((e) => msg(e.message, 'err')); } };
  $('saves-close').onclick = () => { panel.hidden = true; };
  const busy = (on) => { for (const b of panel.querySelectorAll('button')) b.disabled = on; };
  const done = (r, from) => {
    msg(`Imported ${r.count} save files from ${from}.` + (r.backup ? ' Your previous saves are kept as a backup.' : '') +
      (r.notes.length ? ` (${r.notes.join('; ')})` : '') + ' Restarting the game…', 'ok');
    setTimeout(reload, 1200);
  };
  const run = async (fn) => {
    busy(true);
    try { await fn(); } catch (e) { msg(e.message, 'err'); store.log(`[saves] ${e.message}`, 'err'); await refresh().catch(() => {}); }
    finally { busy(false); }
  };

  $('saves-export').onclick = () => run(async () => {
    const z = await store.exportZip();
    if (!z) { msg('There are no saves to export yet.'); return; }
    const name = `atv2-saves-${stamp(Date.now())}.zip`;
    const url = URL.createObjectURL(new Blob([z], { type: 'application/zip' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    msg(`Saved ${name} (${(z.length / 1024).toFixed(0)} KB) to your downloads.`, 'ok');
    store.log(`[saves] exported ${name}, ${z.length} bytes`);
  });
  $('saves-import').onclick = () => $('saves-file').click();
  $('saves-file').onchange = () => {
    const f = $('saves-file').files[0];
    $('saves-file').value = '';
    if (!f) return;
    run(async () => {
      msg(`Checking ${f.name}…`);
      if (f.size > 4 * MAX_BYTES) throw new Error(`${f.name} is ${(f.size / 1048576).toFixed(0)} MB; an ATV 2 save archive is a few KB.`);
      done(await store.importZip(new Uint8Array(await f.arrayBuffer()), f.name), f.name);
    });
  };
  $('saves-folder').onclick = () => run(async () => {
    if (!window.showDirectoryPicker) { $('saves-dir').click(); return; }
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'atv2-native-saves', mode: 'read' }); } catch (e) {
      if (e.name === 'AbortError') return;
      $('saves-dir').click(); return;
    }
    msg(`Checking ${dir.name}…`);
    done(await store.importEntries(await scanSaveFolder(dir), `The folder ${dir.name}`), dir.name);
  });
  $('saves-dir').onchange = () => {
    const list = [...$('saves-dir').files];
    $('saves-dir').value = '';
    if (!list.length) return;
    run(async () => done(await store.importEntries(await scanSaveFileList(list), 'That folder'), 'the folder'));
  };
  $('saves-restore').onclick = () => run(async () => {
    const name = $('saves-restore').dataset.name;
    if (name) done(await store.restoreBackup(name), `the backup ${name}`);
  });
}
