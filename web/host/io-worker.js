// The I/O worker: owns the filesystem (vfs.js: /game from the player's import
// in OPFS, or from the dev server via the OPFS block cache; /save in memory) and the process's one fd table, and
// answers every guest thread's WASI file and stdio calls (io.js). stdout and
// stderr lines go to the page as {type:'log', fd, text}.
//
// The game's saves (/save/UDATA, /save/TDATA) are loaded from OPFS first and
// every change is posted to the page as {type:'saves', ops} (saves.js).
//
// init: { type:'init', memory, io, game, traceWasi, saves }
//   game: { source:'opfs', dir:'atv2-game' } or { source:'server', base:'/data' } -> {type:'ready', ...}
//   saves: 'opfs' (default) or 'off' (in memory only, starting empty)
import { Vfs } from './vfs.js';
import { Wasi } from './wasi.js';
import { ioServe } from './io.js';
import { loadSaves, ensureRoots, SaveSync } from './saves.js';

const post = (m) => self.postMessage(m);

self.onmessage = async ({ data }) => {
  if (data.type !== 'init') return;
  const { memory, io, game, traceWasi, saves = 'opfs' } = data;
  try {
    const vfs = new Vfs();
    const g = game.source === 'opfs' ? await vfs.mountOpfsGame(game.dir) : await vfs.mountGame(game.base);
    const save = vfs.mountMem('save');
    let sync = null, saveNote = 'saves: off (in memory only)';
    if (saves === 'off') ensureRoots(save);
    else {
      const s = await loadSaves(save);
      sync = new SaveSync(save, (m, transfer) => self.postMessage(m, transfer));
      saveNote = `saves: ${s.files} files, ${(s.bytes / 1024).toFixed(0)} KB from browser storage${s.note ? ` (${s.note})` : ''}`;
    }
    let statsAt = 0;
    const onLog = (fd, text) => {
      post({ type: 'log', fd, text });
      const now = performance.now();
      if (now - statsAt > 1000) { statsAt = now; post({ type: 'stats', vfs: vfs.cache?.stats }); vfs.cache?.flush(); }
    };
    const wasi = new Wasi({ vfs, onLog });
    wasi.memory = memory;
    wasi.trace = !!traceWasi;
    post({ type: 'ready', note: `game folder (${game.source === 'opfs' ? 'imported, OPFS' : `dev server ${game.base}`}): ${g.files} files, ${(g.bytes / 1048576).toFixed(0)} MiB; ${g.note}; ${saveNote}` });
    const calls = wasi.imports();
    if (sync) for (const [name, fn] of Object.entries(calls)) calls[name] = (...a) => { const r = fn(...a); sync.poke(name); return r; };
    ioServe(io, calls, (e) => post({ type: 'log', fd: 2, text: `[io] ${e.stack ?? e}` }));
  } catch (e) {
    post({ type: 'error', message: String(e.stack ?? e) });
  }
};
