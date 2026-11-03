// The browser host page: loads the game module, starts the guest main thread
// on a worker (game-worker.js), and owns display, input and audio.
//
//   index.html?env=K=V,K=V   extra/overriding environment variables (-K unsets K)
//             &trace=1        log every WASI call
//             &wasm=<name|url> module (default atv2.wasm, from build-wasm/)
//             &args=a,b       argv[1..]
//             &threads=0      single-threaded even when threads.js is there
//             &dev=1|0        game files from the dev server's /data/ (1) or
//                             never from it (0); see loader.js
//             &forget=1       delete the imported game files first (saves stay)
//             &saves=off      saves in memory only, starting empty (saves.js)
//             &res=1|2|3|4|<n>|window   internal resolution: n times 640x480,
//                             or the size the canvas shows the picture at
//             &msaa=0|4       multisampling (WebGPU has 4; 2 asks for 4)
//             &widescreen=1   the title is told the TV is 16:9 (it renders
//                             anamorphic) and the canvas shows 16:9
//             (the site's Settings page sets these: web/host/site/settings.js)
//
// Served by web/host/serve.mjs (127.0.0.1 only, COOP/COEP so that
// SharedArrayBuffer and shared WebAssembly.Memory exist). The game files are
// the player's own folder, imported into OPFS by loader.js (or, for
// developers, served by serve.mjs --game at /data/) and read by the I/O
// worker (vfs.js).
import { Host, hostView, stageName } from './abi.js';
import { Presenter } from './present.js';
import { Input } from './input.js';
import { requestDevice } from '../gpu/layout.js';
import { IO_BYTES, IO_HOST_PTR } from './io.js';
import { prepareGame, peekGame, loaderState } from './loader.js';
import { checkBasics, checkWorkerSide, checkWebGPU, checkSharedUploads, showProblem, showNotice, installWaitAsync } from './compat.js';
import { loadWasm } from './wasm-load.js';
import { startRoam } from './roam.js';

// Firefox has no Atomics.waitAsync (yet): a Worker-backed stand-in.
installWaitAsync();
import { SaveStore, wireSavesUI } from './saves.js';

// What run.ps1 sets for a native run, minus the Win32-only parts.
export const DEFAULT_ENV = {
  RECOMP_VBLANK: 'paced', RECOMP_TITLE_KEVENTS: '1', RECOMP_PB_EXEC: '1',
  RECOMP_AC97_READY: '1', RECOMP_USB: '1', RECOMP_KEYBOARD: '1', RECOMP_FB_WINDOW: '1',
  RECOMP_GPU: '1', RECOMP_FLIP_PACING: 'edge',
  // As run.ps1 / atv-mcp: the kick ack follows the KickOff store at once (without
  // it D3D's KickOff spin, 0x196FB0, takes 70% of the game thread in a race:
  // 36 fps -> 60), and the contiguous heap frees (no black squares).
  RECOMP_FAST_KICK: '1', RECOMP_HEAP_RECLAIM: '1',
  // Turns on gpu_wgsl_tap.c's WGSL-by-id store, which web_present.c puts in the
  // queue; the folder does not exist, so nothing is written.
  RECOMP_GPU_DUMP_WGSL: '/save/.no-wgsl-dump',
  HOME: '/save',
};

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);

// Display options (present.js / encoder.js; src/gpu/gpu_display.h natively).
const display = (() => {
  const r = (q.get('res') ?? '1').toLowerCase(), win = r === 'window' || r === 'w';
  const n = Number(r);
  return { window: win, scale: win || !(n >= 1) ? 1 : Math.min(8, n),
    msaa: Number(q.get('msaa') ?? 0) > 1 ? 4 : 1, widescreen: q.get('widescreen') === '1' };
})();

// F11 toggles fullscreen (the site keeps F11 for the page, settings.js
// RESERVED_CODES; its menu's Fullscreen item does the same).
addEventListener('keydown', (e) => {
  if (e.code !== 'F11' || e.repeat) return;
  e.preventDefault();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}, { capture: true });
const logLines = [];
let logPending = [];
const state = { stage: 0, exit: null, trap: null, missing: null, vfs: null, audio: 'off (click or press a key)' };

function log(text, cls = '') {
  for (const line of String(text).split('\n')) {
    logLines.push(line);
    logPending.push(line);
    const div = document.createElement('div');
    div.textContent = line;
    if (cls) div.className = cls;
    const el = $('log');
    el.appendChild(div);
    while (el.childElementCount > 400) el.firstChild.remove();
    el.scrollTop = el.scrollHeight;
  }
}
// The dev server keeps the log in a file for whoever runs it (localhost only).
setInterval(() => {
  if (!logPending.length) return;
  const body = logPending.join('\n') + '\n';
  logPending = [];
  fetch('/log', { method: 'POST', body }).catch(() => {});
}, 500);

// Load-time marks (ms since navigation start), for web/tools/loadtime.mjs.
const timings = {};
const mark = (k) => { if (timings[k] === undefined) timings[k] = Math.round(performance.now()); };

/** A boot failure the player should see: the message box, the log, and boot.mjs's state.error. */
class Shown extends Error {}
function fail(title, items, details = '', lead = 'Missing:') {
  showProblem({ title, items, details, lead });
  return new Shown(`${title}: ${items.map((i) => i.what).join('; ')}${details ? ` (${details.split('\n')[0]})` : ''}`);
}

async function boot() {
  mark('boot');
  // What the browser must have, before anything is fetched (compat.js).
  const basics = checkBasics();
  for (const n of basics.notes) log(`[page] ${n}`);
  if (basics.problems.length) throw fail("This browser can't run the game", basics.problems);
  // A bare name is a module in build-wasm/ (served at /wasm/).
  const wasmUrl = ((w) => (w.includes('/') ? w : `/wasm/${w}`))(q.get('wasm') ?? 'atv2.wasm');
  // The module downloads and compiles while the GPU and the game files are
  // set up (and while the player picks the game folder, the first time).
  const wasm = loadWasm(wasmUrl);
  const args = ['atv2', ...(q.get('args') ?? '').split(',').filter(Boolean)];
  const env = { ...DEFAULT_ENV };
  // [site] the player's settings (site/settings.js via site/shell.js), between the defaults and ?env=; null unsets.
  for (const [k, v] of Object.entries(window.atvSite?.env ?? {})) { if (v === null) delete env[k]; else env[k] = v; }
  for (const kv of (q.get('env') ?? '').split(',').filter(Boolean)) {
    if (kv[0] === '-') { delete env[kv.slice(1)]; continue; }   // -NAME unsets
    const i = kv.indexOf('=');
    env[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? '1' : kv.slice(i + 1);
  }
  // Widescreen is the title's own 16:9 mode (dashboard video setting, read by
  // XGetVideoFlags and D3D): the kernel reports it (kernel_xbox.c).
  if (display.widescreen) env.RECOMP_WIDESCREEN = '1';
  else display.widescreen = !!env.RECOMP_WIDESCREEN && env.RECOMP_WIDESCREEN !== '0';
  log(`[page] display: ${display.window ? 'window-sized' : `${display.scale}x`} internal resolution, ` +
    `MSAA ${display.msaa > 1 ? `${display.msaa}x` : 'off'}, ${display.widescreen ? '16:9' : '4:3'}`);

  // The GPU (and the Worker-side checks) come up while the module compiles
  // and, when the game files are already there, while the threads start.
  const gpuP = (async () => {
    const [ws, wg] = await Promise.all([checkWorkerSide().finally(() => mark('workerCheck')),
      checkWebGPU().finally(() => mark('gpuCheck'))]);
    for (const n of wg.notes) { log(`[page] ${n}`, 'err'); showNotice(n); }
    if (ws.problems.length || wg.problems.length) throw fail("This browser can't run the game", [...ws.problems, ...wg.problems]);
    let g;
    try { g = await requestDevice(); } catch (e) {
      throw fail('WebGPU did not start', [{ what: `a WebGPU device (${e.message})`,
        fix: 'Update the graphics driver and the browser, and check edge://gpu or chrome://gpu.' }]);
    }
    g.device.lost?.then((i) => {
      if (i.reason === 'destroyed') return;
      log(`[page] WebGPU device lost: ${i.message}`, 'err');
      showProblem({ title: 'The GPU device was lost', lead: 'What happened:', items: [{ what: i.message || 'WebGPU device lost',
        fix: 'The graphics driver reset or the GPU was removed. Reload the page.' }] });
    });
    // Uploads straight from the shared wasm memory, or through a copy where
    // the browser's WebGPU refuses shared views.
    const su = await checkSharedUploads(g.device);
    if (su.patched) log(`[page] WebGPU refuses shared-memory uploads (writeBuffer ${su.writeBuffer ? 'ok' : 'no'}, ` +
      `writeTexture ${su.writeTexture ? 'ok' : 'no'}): copying through a staging buffer`, 'err');
    mark('gpu');
    log(`[page] WebGPU: ${g.adapterName}; features: ${g.features.join(', ')}`);
    return g;
  })();
  gpuP.catch(() => {});

  // Guest threads: wasm-threads' worker pool when it is there, else the
  // single-threaded bring-up runner (guest main thread only).
  const onExit = (code, missing) => {
    state.exit = code; state.missing = missing;
    log(`[page] guest main thread ended: ${code}` +
      (missing && Object.keys(missing).length ? `; missing imports called: ${JSON.stringify(missing)}` : ''), 'err');
  };
  const onTrap = (m) => {
    state.trap = m;
    log(`[page] TRAP${m.tid !== undefined ? ` (thread ${m.tid})` : ''}: ${m.message}\n${m.stack ?? ''}`, 'err');
    showProblem({ title: 'The game stopped', lead: 'What happened:', items: [{ what: `a crash in thread ${m.tid ?? '?'}: ${m.message}`,
      fix: 'Reload the page to start again. The log (F2) has the details.' }], details: m.stack ?? '' });
  };

  // The module, the shared memory, the I/O channel and the thread Workers
  // (instantiated and idle: no guest code runs before runMain). The
  // environment goes to every Worker at start and depends on the game import
  // (movies skipped or not), so this starts once the game files are known.
  const io = new SharedArrayBuffer(IO_BYTES);
  const host = { io };
  // Returns { mem: Promise<{ module, memory }>, pool: Promise<WasmThreads|null>,
  // io: Promise<Worker> (the I/O worker, ready) }.
  const startThreads = (game) => {
    const mem = makeMemory(game);
    const pool = mem.then(startPool);
    const io = mem.then(({ memory }) => startIo(memory, game));
    for (const p of [mem, pool, io]) p.catch(() => {});
    return { mem, pool, io, stop: () => { pool.then((wt) => wt?.terminate(), () => {}); io.then((w) => w.terminate(), () => {}); } };
  };
  // The I/O worker: it owns the files and the fd table every thread uses.
  // It starts while the thread Workers instantiate and must be up before _start.
  const startIo = (memory, game) => new Promise((resolve, reject) => {
    const ioWorker = new Worker(new URL('./io-worker.js', import.meta.url), { type: 'module', name: 'io' });
    ioWorker.onmessage = ({ data: m }) => {
      if (m.type === 'ready') { log(`[page] ${m.note}`); mark('ioReady'); resolve(ioWorker); }
      else if (m.type === 'error') { log(`[page] I/O worker: ${m.message}`, 'err'); reject(new Error(m.message)); }
      else if (m.type === 'log') log(m.text, m.fd === 2 ? 'err' : '');
      else if (m.type === 'stats') state.vfs = m.vfs;
      else if (m.type === 'saves') saves.apply(m.ops);
    };
    ioWorker.postMessage({ type: 'init', memory, io, traceWasi: q.get('trace') === '1', saves: saves.mode,
      game: game.source === 'opfs' ? { source: 'opfs', dir: game.dir } : { source: 'server', base: game.base } });
  });
  const makeMemory = async (game) => {
    if (game.manifest?.skipMovies && !('RECOMP_SKIP_MOVIES' in env)) env.RECOMP_SKIP_MOVIES = '1';
    let module;
    try { module = await wasm.module; } catch (e) {
      if (e instanceof WebAssembly.CompileError)
        throw fail("This browser can't compile the game module", [{ what: 'a WebAssembly feature the module uses',
          fix: 'Use a current Edge, Chrome or Firefox.' }], e.message);
      throw fail('The game module did not load', [{ what: wasmUrl, fix: 'Is the local server still running?' }], e.message, 'Could not load:');
    }
    mark('wasmCompiled');
    const lim = await wasm.limits;
    if (!lim?.shared) throw new Error('the module does not import a shared memory');
    let memory;
    try { memory = new WebAssembly.Memory({ initial: lim.min, maximum: lim.max ?? 65536, shared: true }); } catch (e) {
      throw fail('Not enough memory for the game', [{ what: `${(lim.min / 16384).toFixed(1)} GB of WebAssembly memory (${e.message})`,
        fix: 'The game reserves about 2.2 GB up front. Close other tabs and programs, use a 64-bit browser, and reload.' }], '', 'Could not reserve:');
    }
    const wi = wasm.info();
    log(`[page] ${wasmUrl}: ${(wi.bytes / 1048576).toFixed(1)} MiB (${wi.cache || 'size unknown'}` +
        `${wi.transfer ? `, ${(wi.transfer / 1048576).toFixed(2)} MiB over the wire` : ''}), ${wi.mode}, ` +
        `compiled in ${wi.ms.toFixed(0)} ms since boot; memory ${lim.min} pages (max ${lim.max ?? 65536}, from ${lim.from})`);
    log(`[page] env: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    return { module, memory };
  };
  const startPool = async ({ module, memory }) => {
    let threads = null;
    try { threads = await import('./threads.js'); } catch { /* not merged yet */ }
    if (!threads?.WasmThreads || q.get('threads') === '0') return null;
    const wt = new threads.WasmThreads({ module, memory, importsUrl: new URL('./imports.js', import.meta.url).href,
      env, args, host, pool: 14, spare: 2, max: 64, onExit: (c) => onExit(c), onTrap });
    // A browser that cannot start the module Workers would wait here forever.
    let started = false;
    await Promise.race([wt.start().then(() => { started = true; }),
      new Promise((r) => setTimeout(r, 30000))]);
    if (!started) {
      wt.terminate();
      throw fail('The game threads did not start', [{ what: 'module Web Workers with shared WebAssembly memory',
        fix: 'No Worker answered within 30 s. Use a current Edge, Chrome or Firefox; see the log (F2).' }], '', 'Not working:');
    }
    mark('workersUp');
    return wt;
  };
  // Already imported (or the dev server's /data/): the threads start now.
  const early = await peekGame(q).catch(() => null);
  let threadsP = early ? startThreads(early) : null;
  let gpu;
  try { gpu = await gpuP; } catch (e) { threadsP?.stop(); throw e; }

  // The game files: the player's import in OPFS (the import UI first if there
  // is none yet), or the dev server's /data/.
  const game = await prepareGame({ q, log });
  mark('game');
  if (early && (early.source !== game.source || early.dir !== game.dir || early.base !== game.base)) {
    // Changed in between (should not happen): start over with what prepareGame found.
    threadsP.stop();
    threadsP = null;
  }
  threadsP ??= startThreads(game);
  $('status').textContent = 'loading…';

  const { module, memory } = await threadsP.mem;
  await threadsP.io;
  const wt = await threadsP.pool;
  if (wt) {
    log('[page] threads: worker pool up; running _start');
    wt.runMain().catch((e) => log(`[page] runMain: ${e.message}`, 'err'));
  } else {
    const worker = new Worker(new URL('./game-worker.js', import.meta.url), { type: 'module', name: 'guest main thread' });
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'log') log(m.text, 'err');
      else if (m.type === 'trap') onTrap(m);
      else if (m.type === 'exit') onExit(m.code, m.missing);
    };
    worker.onerror = (e) => log(`[page] worker error: ${e.message}`, 'err');
    worker.postMessage({ type: 'start', module, memory, env, args, host });
    log('[page] threads: none (single-threaded bring-up)');
  }
  // No picture long after the start: say so (not fatal; the game may still come up).
  setTimeout(() => {
    if (timings.firstFrame === undefined && !state.error && !state.trap && state.exit === null)
      showNotice('Still no picture 45 s after the game started. The log (F2) shows where it is; a reload may help.');
  }, 45000);

  // web_main.c reports its host block through the I/O channel.
  let presenter = null, input = null, hostPtr = 0;
  (async () => {
    const w = new Int32Array(io);
    while (!(hostPtr = Atomics.load(w, IO_HOST_PTR) >>> 0)) await Atomics.waitAsync(w, IO_HOST_PTR, 0).value;
    hostView(memory, hostPtr);
    input = new Input(memory, hostPtr);
    presenter = new Presenter({ device: gpu.device, features: gpu.features, canvas: $('screen'),
      memory, hostPtr, onError: (s) => log(`[page] ${s}`, 'err'), display });
    window.atv.presenter = presenter; window.atv.input = input;
    log(`[page] host block at 0x${hostPtr.toString(16)}`);
    // RECOMP_ROAM: the page is free roam's WebSocket transport (roam.js).
    startRoam({ memory, hostPtr, env, canvas: $('screen'), log, display });
  })();

  // Audio. The autoplay policy lets an AudioContext run only after a user
  // gesture, so the first pointerdown/keydown/touch creates it and calls
  // resume() inside the handler; later gestures resume it again if it got
  // suspended. The worklet node is attached as soon as both the context and
  // the game's ring (xa2_init) exist, whichever comes last. Until the worklet
  // runs, web_audio.c drains the ring by wall clock.
  const audio = { ctx: null, node: null, analyser: null, stats: null, captures: [], graph: { rms: 0, peak: 0 } };
  const audioState = () => {
    const c = audio.ctx;
    state.audio = !c ? 'off (click or press a key)' :
      `${c.state} ${c.sampleRate} Hz${audio.node ? '' : ', waiting for the game'}` +
      (audio.stats ? `, ${audio.stats.underruns} short/s, ${(audio.stats.fill.avg / 48).toFixed(0)} ms queued` : '');
  };
  const ringAddr = () => (hostPtr ? new Int32Array(memory.buffer, hostPtr, Host.words)[Host.at.audio_ring] >>> 0 : 0);
  let attaching = null;
  const attachAudio = async () => {
    const ring = ringAddr();
    if (!audio.ctx || audio.node || !ring) return;
    await audio.ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
    const node = new AudioWorkletNode(audio.ctx, 'atv2-ring', { numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { buffer: memory.buffer, ring } });
    node.port.onmessage = ({ data: m }) => {
      if (m.type === 'stats') { audio.stats = m; audioState(); }
      else if (m.type === 'capture') audio.captures.shift()?.(m.data);
    };
    // A tap on what reaches the destination (the page's audio check reads it).
    const an = new AnalyserNode(audio.ctx, { fftSize: 2048 });
    // [site] volume: a gain between the worklet and the speakers (site settings / in-game menu).
    audio.gain = new GainNode(audio.ctx, { gain: window.atvSite?.volume?.() ?? 1 });
    node.connect(audio.gain).connect(audio.ctx.destination);
    node.connect(an);
    audio.node = node; audio.analyser = an;
    const buf = new Float32Array(an.fftSize);
    setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sq = 0, pk = 0;
      for (const v of buf) { sq += v * v; if (Math.abs(v) > pk) pk = Math.abs(v); }
      audio.graph = { rms: Math.sqrt(sq / buf.length), peak: pk };
    }, 100);
    log(`[page] audio: worklet on the game's ring at 0x${ring.toString(16)}; ${audio.ctx.state} ${audio.ctx.sampleRate} Hz, ` +
      `base latency ${(audio.ctx.baseLatency * 1000).toFixed(1)} ms, output latency ${((audio.ctx.outputLatency ?? 0) * 1000).toFixed(1)} ms`);
    audioState();
  };
  const tryAttach = () => {
    if (!attaching && audio.ctx && !audio.node)
      attaching = attachAudio().catch((e) => log(`[page] audio: ${e.message}`, 'err')).finally(() => { attaching = null; });
    return attaching;
  };
  const onGesture = () => {
    if (!audio.ctx) {
      audio.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      audio.ctx.onstatechange = () => { audioState(); log(`[page] audio: ${audio.ctx.state}`); };
    }
    if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
    audioState();
    tryAttach();
  };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, onGesture, { capture: true });
  // The game may set up its ring after the first gesture.
  const ringPoll = setInterval(() => { if (audio.node) clearInterval(ringPoll); else if (ringAddr()) tryAttach(); }, 250);
  // Scripted start (boot.mjs --audio). Without a real gesture the context
  // stays suspended; the audio check sends a real input event instead.
  window.atv.startAudio = async () => { onGesture(); await tryAttach(); await new Promise((r) => setTimeout(r, 200)); audioState(); };
  window.atv.audio = {
    setVolume: (v) => { if (audio.gain) audio.gain.gain.value = v; },   // [site] 0..1
    state: () => ({ ctx: audio.ctx?.state ?? 'none', rate: audio.ctx?.sampleRate ?? 0, attached: !!audio.node,
      baseLatency: audio.ctx?.baseLatency ?? 0, outputLatency: audio.ctx?.outputLatency ?? 0,
      ring: ringAddr(), stats: audio.stats, graph: audio.graph,
      activation: navigator.userActivation ? { has: navigator.userActivation.hasBeenActive, active: navigator.userActivation.isActive } : null }),
    // The next `secs` seconds of what the worklet outputs, as 16-bit PCM
    // (interleaved stereo, base64): the audio check writes it to a local WAV.
    capture: (secs) => new Promise((resolve, reject) => {
      if (!audio.node) { reject(new Error('audio not running')); return; }
      audio.captures.push((f32) => {
        const pcm = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32768)));
        const u8 = new Uint8Array(pcm.buffer);
        let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        resolve({ rate: audio.ctx.sampleRate, frames: f32.length / 2, pcm: btoa(s) });
      });
      audio.node.port.postMessage({ type: 'capture', frames: Math.round(secs * audio.ctx.sampleRate) });
    }),
  };

  let frames = 0, lastT = performance.now(), fps = 0;
  const tick = () => {
    if (presenter) { input.pollGamepad(); presenter.draw(); if (presenter.stats.frames > 0) mark('firstFrame'); }
    if (hostPtr) {
      const i = new Int32Array(memory.buffer, hostPtr, Host.words);
      state.stage = i[Host.at.boot_stage];
      const now = performance.now();
      if (now - lastT > 1000) { fps = (i[Host.at.flips] - frames) * 1000 / (now - lastT); frames = i[Host.at.flips]; lastT = now; }
      const s = presenter?.stats ?? {};
      $('status').textContent = `${stageName(state.stage)} | flips ${i[Host.at.flips]} (${fps.toFixed(0)}/s) | ` +
        `GPU frames ${s.frames ?? 0}, draws ${s.lastDraws ?? 0}, dropped ${i[Host.at.gp_dropped]}, errors ${s.errors ?? 0} | ` +
        `${s.shown ?? ''} | audio ${state.audio} | pads ${input?.status() ?? 'keyboard'}` +
        (state.vfs ? ` | data ${state.vfs.fetched} blocks fetched, ${state.vfs.opfsHits} from OPFS` : '');
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { memory };
}

// Saves (saves.js): kept in OPFS, the "Saves" panel exports and imports them.
const saves = new SaveStore({ log, mode: q.get('saves') === 'off' ? 'off' : 'opfs' });
saves.lock().then((ok) => { if (!ok) log(`[saves] not kept by this tab: ${saves.frozen}`, 'err'); });
wireSavesUI(saves);

window.atv = {
  state, log: logLines, loader: loaderState, timings, saves, display,
  stage: () => stageName(state.stage),
  snapshot: async () => {
    const png = await window.atv.presenter?.snapshot();
    if (!png) return null;
    let s = ''; for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode(...png.subarray(i, i + 0x8000));
    return 'data:image/png;base64,' + btoa(s);
  },
  key: (vk, down) => window.atv.input?.key(vk, down),
};
window.ready = boot().catch((e) => {
  log(`[page] boot failed: ${e.stack ?? e}`, 'err');
  state.error = String(e.message ?? e);
  if (!(e instanceof Shown)) showProblem({ title: 'The game failed to start', details: String(e.stack ?? e) });
});
