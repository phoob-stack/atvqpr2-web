// The I/O worker: owns the filesystem (vfs.js: /game from the player's import
// in OPFS, or from the dev server via the OPFS block cache; /save in memory) and the process's one fd table, and
// answers every guest thread's WASI file and stdio calls (io.js). stdout and
// stderr lines go to the page as {type:'log', fd, text}.
//
// init: { type:'init', memory, io, game, traceWasi }
//   game: { source:'opfs', dir:'atv2-game' } or { source:'server', base:'/data' } -> {type:'ready', ...}
import { Vfs } from './vfs.js';
import { Wasi } from './wasi.js';
import { ioServe } from './io.js';

const post = (m) => self.postMessage(m);

self.onmessage = async ({ data }) => {
  if (data.type !== 'init') return;
  const { memory, io, game, traceWasi } = data;
  try {
    const vfs = new Vfs();
    const g = game.source === 'opfs' ? await vfs.mountOpfsGame(game.dir) : await vfs.mountGame(game.base);
    vfs.mountMem('save');
    let statsAt = 0;
    const onLog = (fd, text) => {
      post({ type: 'log', fd, text });
      const now = performance.now();
      if (now - statsAt > 1000) { statsAt = now; post({ type: 'stats', vfs: vfs.cache?.stats }); vfs.cache?.flush(); }
    };
    const wasi = new Wasi({ vfs, onLog });
    wasi.memory = memory;
    wasi.trace = !!traceWasi;
    post({ type: 'ready', note: `game folder (${game.source === 'opfs' ? 'imported, OPFS' : `dev server ${game.base}`}): ${g.files} files, ${(g.bytes / 1048576).toFixed(0)} MiB; ${g.note}` });
    ioServe(io, wasi.imports(), (e) => post({ type: 'log', fd: 2, text: `[io] ${e.stack ?? e}` }));
  } catch (e) {
    post({ type: 'error', message: String(e.stack ?? e) });
  }
};
