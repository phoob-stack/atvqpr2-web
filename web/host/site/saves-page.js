// The start page's "Saves" tab: the profiles kept in this browser, a backup
// .zip download, restoring one, importing the Windows build's save folder,
// deleting a profile (or all), and the automatic backups.
//
// The storage itself is the saves worker's web/host/saves.js (SaveStore,
// checkSaveEntries, scanSaveFolder, commitIncoming...). `hooks` below is the
// whole contract between this page and that module: each hook is a small
// function over saves.js. When saves.js is not in this build (it is merged
// separately), available() is false, the page says so and the buttons stay
// off; nothing else changes.
//
// The tab only changes saves while no game runs on this origin: the game tab
// holds the 'atv2-saves' Web Lock (SaveStore.lock()), and the hooks refuse
// while it is held. An import or delete backs the current saves up first
// (saves.js keeps the newest 5 under atv2-saves-backups/).
import { h } from './settings-ui.js';
import { downloadBlob, stamp, siteLog } from './logs.js';

let mod = null, store = null, loaded = false;
async function saves() {
  if (!loaded) {
    loaded = true;
    try {
      mod = await import('../saves.js');
      store = new mod.SaveStore({ log: (t) => siteLog(t) });
    } catch (e) { mod = null; store = null; siteLog(`saves: web/host/saves.js is not in this build (${e.message.split('\n')[0]})`); }
  }
  return mod;
}

async function gameRunning() {
  try { const s = await navigator.locks?.query?.(); return !!s?.held?.some((l) => l.name === 'atv2-saves'); } catch { return false; }
}
async function mustBeIdle() {
  if (await gameRunning()) throw new Error('The game is running in another tab of this page. Quit it there first, then change the saves here.');
}

// saves.js's backup names (UTC, sortable): 20261103-055724Z-before-...
const utcStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

const utf16 = (u8) => {
  try { return new TextDecoder('utf-16le').decode(u8); } catch { return ''; }
};

// ---- the hooks ------------------------------------------------------------------

export const hooks = {
  /** Is the saves module in this build? */
  async available() { return !!(await saves()); },

  /** The profiles: [{ id (save folder), name, files, bytes, mtime }], plus { other } files outside a profile. */
  async list() {
    if (!await saves()) return { profiles: [], other: { files: 0, bytes: 0 } };
    const tree = (await store.current()).filter((f) => !f.dir);
    const by = new Map();
    const other = { files: 0, bytes: 0 };
    for (const f of tree) {
      const s = f.path.split('/');
      if (s[0] === 'UDATA' && s[1]?.toLowerCase() === mod.TITLE_ID && s.length > 3) {
        const p = by.get(s[2]) ?? { id: s[2], name: s[2], files: 0, bytes: 0, mtime: 0 };
        p.files++; p.bytes += f.data.length; p.mtime = Math.max(p.mtime, f.mtime ?? 0);
        if (s[3].toLowerCase() === 'savemeta.xbx') {
          const m = /Name=([^\r\n\0]*)/.exec(utf16(f.data));
          if (m?.[1]) p.name = m[1].trim();
        }
        by.set(s[2], p);
      } else { other.files++; other.bytes += f.data.length; }
    }
    return { profiles: [...by.values()].sort((a, b) => b.mtime - a.mtime), other };
  },

  /** A backup .zip of every save (Uint8Array), or null when there are none. */
  async exportZip() { return (await saves()) ? store.exportZip() : null; },

  /** Restore from a backup .zip the player picked. */
  async importZip(u8, name) {
    if (!await saves()) throw new Error('Saves are not in this build yet.');
    await mustBeIdle();
    const r = await store.importZip(u8, name);
    await mod.commitIncoming();
    return r;
  },

  /** Import the Windows build's save folder: a directory handle or an <input webkitdirectory> FileList. */
  async importFolder(source) {
    if (!await saves()) throw new Error('Saves are not in this build yet.');
    await mustBeIdle();
    const raw = typeof source?.values === 'function' && source.kind === 'directory'
      ? await mod.scanSaveFolder(source) : await mod.scanSaveFileList([...source]);
    const r = await store.importEntries(raw, source.name ? `The folder ${source.name}` : 'That folder');
    await mod.commitIncoming();
    return r;
  },

  /** Delete one profile (its save folder id), or every save (id null). The current saves are backed up first. */
  async remove(id) {
    if (!await saves()) throw new Error('Saves are not in this build yet.');
    await mustBeIdle();
    const tree = await store.current();
    const keep = id === null ? [] : tree.filter((f) => {
      const s = f.path.split('/');
      return !(s[0] === 'UDATA' && s[1]?.toLowerCase() === mod.TITLE_ID && s[2] === id);
    });
    if (keep.some((f) => !f.dir && f.path.split('/')[0] === 'UDATA' && f.path.split('/').length > 3)) {
      const c = mod.checkSaveEntries(keep, 'The remaining saves');
      await store.replace(c.files, { reason: 'delete' });
      await mod.commitIncoming();
      return { left: c.count };
    }
    // Nothing (or only title data) left: back the saves up, then empty the folder.
    const root = await navigator.storage.getDirectory();
    if (tree.some((f) => !f.dir)) {
      const b = await (await root.getDirectoryHandle(mod.BACKUP_DIR, { create: true })).getDirectoryHandle(`${utcStamp()}-before-delete`, { create: true });
      for (const f of tree) {
        const parts = f.path.split('/');
        let d = b;
        for (const p of parts.slice(0, f.dir ? parts.length : -1)) d = await d.getDirectoryHandle(p, { create: true });
        if (f.dir) continue;
        const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(f.data); await w.close();
      }
    }
    await root.removeEntry(mod.SAVE_DIR, { recursive: true }).catch((e) => { if (e.name !== 'NotFoundError') throw e; });
    return { left: 0 };
  },

  /** The automatic backups, newest first. */
  async backups() { return (await saves()) ? store.backups() : []; },

  async restoreBackup(name) {
    if (!await saves()) throw new Error('Saves are not in this build yet.');
    await mustBeIdle();
    const r = await store.restoreBackup(name);
    await mod.commitIncoming();
    return r;
  },
};

// ---- the tab ----------------------------------------------------------------------

export async function renderSaves(root) {
  root.textContent = '';
  const msg = h('div', { class: 'set-msg', role: 'status' });
  const say = (t, cls = '') => { msg.textContent = t; msg.className = `set-msg ${cls}`; };
  const draw = () => renderSaves(root).then(() => root.querySelector('.set-msg').replaceWith(msg));
  const avail = await hooks.available();
  const running = await gameRunning();
  const run = (fn) => async (e) => {
    const b = e?.currentTarget;
    if (b) b.disabled = true;
    try { await fn(); } catch (err) { say(err.message, 'warn'); siteLog(`saves: ${err.message}`); } finally { if (b) b.disabled = false; }
  };

  if (!avail) {
    root.append(h('div', { class: 'notice' },
      h('strong', {}, 'Saves are kept for this session only in this build.'),
      ' Keeping saves in the browser, backups and imports come with the saves update (web/host/saves.js); this page lights up when it is there.'));
  } else if (running) {
    root.append(h('div', { class: 'notice warn' }, 'The game is running in another tab: saves can be looked at here, but not changed until it quits.'));
  }

  const { profiles, other } = await hooks.list();
  const table = h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'Profile'), h('th', {}, 'Files'), h('th', {}, 'Last saved'), h('th', {}, ''))));
  const tb = h('tbody');
  if (!profiles.length) tb.append(h('tr', {}, h('td', { colSpan: 4, class: 'muted' }, avail ? 'No profiles in this browser yet. Create one in the game (SAVED PROFILES).' : 'Not available in this build.')));
  for (const p of profiles) {
    let armed = 0;
    const del = h('button', { class: 'btn small danger', disabled: running, onclick: run(async () => {
      if (Date.now() - armed > 4000) { armed = Date.now(); del.textContent = 'Click again'; return; }
      await hooks.remove(p.id); say(`Deleted ${p.name}. A backup of the saves before it is kept (Backups below).`, 'ok'); await draw();
    }) }, 'Delete');
    tb.append(h('tr', {}, h('td', {}, h('strong', {}, p.name), h('div', { class: 'muted small' }, p.id)),
      h('td', {}, `${p.files} (${(p.bytes / 1024).toFixed(0)} KB)`),
      h('td', {}, p.mtime ? new Date(p.mtime).toLocaleString() : ''), h('td', { class: 'acts' }, del)));
  }
  table.append(tb);
  root.append(h('h3', {}, 'Profiles in this browser'), table);
  if (other.files) root.append(h('p', { class: 'small muted' }, `Plus ${other.files} game data files (${(other.bytes / 1024).toFixed(0)} KB) outside the profiles (settings, records).`));

  const zipIn = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  const dirIn = h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true });
  zipIn.onchange = run(async () => {
    const f = zipIn.files[0]; zipIn.value = '';
    if (!f) return;
    say(`Checking ${f.name}…`);
    const r = await hooks.importZip(new Uint8Array(await f.arrayBuffer()), f.name);
    say(`Restored ${r.count} save files from ${f.name}.${r.backup ? ' The saves before it are kept as a backup.' : ''}`, 'ok'); await draw();
  });
  dirIn.onchange = run(async () => {
    const list = dirIn.files; if (!list.length) return;
    const r = await hooks.importFolder(list); dirIn.value = '';
    say(`Imported ${r.count} save files from the folder.`, 'ok'); await draw();
  });
  let allArmed = 0;
  const delAll = h('button', { class: 'btn danger', disabled: !avail || running || !profiles.length, onclick: run(async () => {
    if (Date.now() - allArmed > 4000) { allArmed = Date.now(); delAll.textContent = 'Click again to delete every save'; return; }
    await hooks.remove(null); say('Deleted every save. A backup is kept (Backups below).', 'ok'); await draw();
  }) }, 'Delete all saves');

  root.append(h('div', { class: 'cards' },
    h('div', { class: 'card' }, h('h3', {}, 'Download a backup'),
      h('p', { class: 'small' }, 'Every profile in one .zip, in the Windows build\'s layout: extract it into %LOCALAPPDATA%\\xboxrecomp to play the same saves there.'),
      h('button', { class: 'btn', disabled: !avail || !profiles.length, onclick: run(async () => {
        const z = await hooks.exportZip();
        if (!z) { say('There are no saves to back up yet.'); return; }
        const name = `atv2-saves-${stamp()}.zip`;
        downloadBlob(new Blob([z], { type: 'application/zip' }), name);
        say(`Saved ${name} (${(z.length / 1024).toFixed(0)} KB) to your downloads.`, 'ok');
      }) }, 'Download backup')),
    h('div', { class: 'card' }, h('h3', {}, 'Restore a backup'),
      h('p', { class: 'small' }, 'A .zip from "Download backup". It replaces the saves here; the current ones are backed up first.'),
      h('button', { class: 'btn', disabled: !avail || running, onclick: () => zipIn.click() }, 'Restore from .zip…'), zipIn),
    h('div', { class: 'card' }, h('h3', {}, 'Import from Windows'),
      h('p', { class: 'small' }, 'The Windows build\'s save folder: %LOCALAPPDATA%\\xboxrecomp (or RECOMP_SAVE_DIR). Only its UDATA/TDATA saves are read.'),
      h('button', { class: 'btn', disabled: !avail || running, onclick: run(async () => {
        if (!window.showDirectoryPicker) { dirIn.click(); return; }
        let dir;
        try { dir = await window.showDirectoryPicker({ id: 'atv2-native-saves', mode: 'read' }); } catch (e) {
          if (e.name === 'AbortError') return; dirIn.click(); return;
        }
        say(`Checking ${dir.name}…`);
        const r = await hooks.importFolder(dir);
        say(`Imported ${r.count} save files from ${dir.name}.${r.notes?.length ? ` (${r.notes.join('; ')})` : ''}`, 'ok'); await draw();
      }) }, 'Choose the save folder…'), dirIn)));

  const backups = await hooks.backups();
  const bl = h('ul', { class: 'backups' });
  for (const b of backups) {
    bl.append(h('li', {}, h('code', {}, b), ' ', h('button', { class: 'btn small ghost', disabled: running, onclick: run(async () => {
      const r = await hooks.restoreBackup(b); say(`Restored ${r.count} files from the backup ${b}.`, 'ok'); await draw();
    }) }, 'Restore')));
  }
  root.append(h('h3', {}, 'Backups'),
    backups.length ? bl : h('p', { class: 'small muted' }, avail ? 'None yet: one is made before every import or delete (the newest five are kept).' : 'Not available in this build.'),
    h('div', { class: 'set-foot' }, h('span', { class: 'small muted' }, 'Saves stay in this browser on this computer. "Forget game files" never touches them.'), delAll),
    msg);
}
