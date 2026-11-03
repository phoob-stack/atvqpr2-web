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
import { prepareGame, loaderState } from './loader.js';
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

/** The shared memory's limits from the module's import section. */
function memoryImportLimits(bytes) {
  const u = new Uint8Array(bytes);
  let p = 8;
  const leb = () => { let r = 0, s = 0, b; do { b = u[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  const name = () => { const n = leb(); p += n; };
  while (p < u.length) {
    const id = u[p++], size = leb(), end = p + size;
    if (id === 2) {
      for (let n = leb(); n--;) {
        name(); name();
        const kind = u[p++];
        if (kind === 0) leb();
        else if (kind === 1) { p++; const f = u[p++]; leb(); if (f & 1) leb(); }
        else if (kind === 2) { const f = u[p++]; const min = leb(); const max = f & 1 ? leb() : undefined; return { min, max, shared: !!(f & 2) }; }
        else if (kind === 3) { p += 2; }
        else if (kind === 4) { p++; leb(); }
      }
    }
    p = end;
  }
  return null;
}

async function boot() {
  if (!crossOriginIsolated) throw new Error('not cross-origin isolated: serve with web/host/serve.mjs (COOP/COEP)');
  // A bare name is a module in build-wasm/ (served at /wasm/).
  const wasmUrl = ((w) => (w.includes('/') ? w : `/wasm/${w}`))(q.get('wasm') ?? 'atv2.wasm');
  const args = ['atv2', ...(q.get('args') ?? '').split(',').filter(Boolean)];
  const env = { ...DEFAULT_ENV };
  for (const kv of (q.get('env') ?? '').split(',').filter(Boolean)) {
    if (kv[0] === '-') { delete env[kv.slice(1)]; continue; }   // -NAME unsets
    const i = kv.indexOf('=');
    env[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? '1' : kv.slice(i + 1);
  }

  const gpu = await requestDevice();
  log(`[page] WebGPU: ${gpu.adapterName}; features: ${gpu.features.join(', ')}`);

  // The game files: the player's import in OPFS (the import UI first if there
  // is none yet), or the dev server's /data/.
  const game = await prepareGame({ q, log });
  if (game.manifest?.skipMovies && !('RECOMP_SKIP_MOVIES' in env)) env.RECOMP_SKIP_MOVIES = '1';
  $('status').textContent = 'loading…';

  const t0 = performance.now();
  const bytes = await (await fetch(wasmUrl)).arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  const lim = memoryImportLimits(bytes);
  if (!lim?.shared) throw new Error('the module does not import a shared memory');
  const memory = new WebAssembly.Memory({ initial: lim.min, maximum: lim.max ?? 65536, shared: true });
  log(`[page] ${wasmUrl}: ${(bytes.byteLength / 1048576).toFixed(1)} MiB, compiled in ${(performance.now() - t0).toFixed(0)} ms; ` +
      `memory ${lim.min} pages (max ${lim.max ?? 65536})`);
  log(`[page] env: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // The I/O worker first: it owns the files and the fd table every thread uses.
  const io = new SharedArrayBuffer(IO_BYTES);
  const ioWorker = new Worker(new URL('./io-worker.js', import.meta.url), { type: 'module', name: 'io' });
  await new Promise((resolve, reject) => {
    ioWorker.onmessage = ({ data: m }) => {
      if (m.type === 'ready') { log(`[page] ${m.note}`); resolve(); }
      else if (m.type === 'error') { log(`[page] I/O worker: ${m.message}`, 'err'); reject(new Error(m.message)); }
      else if (m.type === 'log') log(m.text, m.fd === 2 ? 'err' : '');
      else if (m.type === 'stats') state.vfs = m.vfs;
      else if (m.type === 'saves') saves.apply(m.ops);
    };
    ioWorker.postMessage({ type: 'init', memory, io, traceWasi: q.get('trace') === '1', saves: saves.mode,
      game: game.source === 'opfs' ? { source: 'opfs', dir: game.dir } : { source: 'server', base: game.base } });
  });
  const host = { io };

  // Guest threads: wasm-threads' worker pool when it is there, else the
  // single-threaded bring-up runner (guest main thread only).
  const onExit = (code, missing) => {
    state.exit = code; state.missing = missing;
    log(`[page] guest main thread ended: ${code}` +
      (missing && Object.keys(missing).length ? `; missing imports called: ${JSON.stringify(missing)}` : ''), 'err');
  };
  const onTrap = (m) => { state.trap = m; log(`[page] TRAP${m.tid !== undefined ? ` (thread ${m.tid})` : ''}: ${m.message}
${m.stack ?? ''}`, 'err'); };
  let threads = null;
  try { threads = await import('./threads.js'); } catch { /* not merged yet */ }
  if (threads?.WasmThreads && q.get('threads') !== '0') {
    const wt = new threads.WasmThreads({ module, memory, importsUrl: new URL('./imports.js', import.meta.url).href,
      env, args, host, pool: 14, spare: 2, max: 64, onExit: (c) => onExit(c), onTrap });
    await wt.start();
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

  // web_main.c reports its host block through the I/O channel.
  let presenter = null, input = null, hostPtr = 0;
  (async () => {
    const w = new Int32Array(io);
    while (!(hostPtr = Atomics.load(w, IO_HOST_PTR) >>> 0)) await Atomics.waitAsync(w, IO_HOST_PTR, 0).value;
    hostView(memory, hostPtr);
    input = new Input(memory, hostPtr);
    presenter = new Presenter({ device: gpu.device, features: gpu.features, canvas: $('screen'),
      memory, hostPtr, onError: (s) => log(`[page] ${s}`, 'err') });
    window.atv.presenter = presenter; window.atv.input = input;
    log(`[page] host block at 0x${hostPtr.toString(16)}`);
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
    node.connect(audio.ctx.destination);
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
    if (presenter) { input.pollGamepad(); presenter.draw(); }
    if (hostPtr) {
      const i = new Int32Array(memory.buffer, hostPtr, Host.words);
      state.stage = i[Host.at.boot_stage];
      const now = performance.now();
      if (now - lastT > 1000) { fps = (i[Host.at.flips] - frames) * 1000 / (now - lastT); frames = i[Host.at.flips]; lastT = now; }
      const s = presenter?.stats ?? {};
      $('status').textContent = `${stageName(state.stage)} | flips ${i[Host.at.flips]} (${fps.toFixed(0)}/s) | ` +
        `GPU frames ${s.frames ?? 0}, draws ${s.lastDraws ?? 0}, dropped ${i[Host.at.gp_dropped]}, errors ${s.errors ?? 0} | ` +
        `${s.shown ?? ''} | audio ${state.audio} | pad ${input?.padName || 'keyboard'}` +
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
  state, log: logLines, loader: loaderState, saves,
  stage: () => stageName(state.stage),
  snapshot: async () => {
    const png = await window.atv.presenter?.snapshot();
    if (!png) return null;
    let s = ''; for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode(...png.subarray(i, i + 0x8000));
    return 'data:image/png;base64,' + btoa(s);
  },
  key: (vk, down) => window.atv.input?.key(vk, down),
};
window.ready = boot().catch((e) => { log(`[page] boot failed: ${e.stack ?? e}`, 'err'); state.error = String(e); });
