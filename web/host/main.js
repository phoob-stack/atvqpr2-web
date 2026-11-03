// The browser host page: loads the game module, starts the guest main thread
// on a worker (game-worker.js), and owns display, input and audio.
//
//   index.html?env=K=V,K=V   extra/overriding environment variables
//             &trace=1        log every WASI call
//             &wasm=<name|url> module (default atv2.wasm, from build-wasm/)
//             &args=a,b       argv[1..]
//             &threads=0      single-threaded even when threads.js is there
//
// Served by web/host/serve.mjs (127.0.0.1 only, COOP/COEP so that
// SharedArrayBuffer and shared WebAssembly.Memory exist). The game files are
// the player's own folder, read through /data/ by the worker (vfs.js).
import { Host, hostView, stageName } from './abi.js';
import { Presenter } from './present.js';
import { Input } from './input.js';
import { requestDevice } from '../gpu/layout.js';
import { IO_BYTES, IO_HOST_PTR } from './io.js';

// What run.ps1 sets for a native run, minus the Win32-only parts.
export const DEFAULT_ENV = {
  RECOMP_VBLANK: 'paced', RECOMP_TITLE_KEVENTS: '1', RECOMP_PB_EXEC: '1',
  RECOMP_AC97_READY: '1', RECOMP_USB: '1', RECOMP_KEYBOARD: '1', RECOMP_FB_WINDOW: '1',
  RECOMP_GPU: '1', RECOMP_FLIP_PACING: 'edge',
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
    const i = kv.indexOf('=');
    env[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? '1' : kv.slice(i + 1);
  }

  const gpu = await requestDevice();
  log(`[page] WebGPU: ${gpu.adapterName}; features: ${gpu.features.join(', ')}`);

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
    };
    ioWorker.postMessage({ type: 'init', memory, io, dataBase: '/data', traceWasi: q.get('trace') === '1' });
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
    while (!(hostPtr = Atomics.load(w, IO_HOST_PTR))) await Atomics.waitAsync(w, IO_HOST_PTR, 0).value;
    hostView(memory, hostPtr);
    input = new Input(memory, hostPtr);
    presenter = new Presenter({ device: gpu.device, features: gpu.features, canvas: $('screen'),
      memory, hostPtr, onError: (s) => log(`[page] ${s}`, 'err') });
    window.atv.presenter = presenter; window.atv.input = input;
    log(`[page] host block at 0x${hostPtr.toString(16)}`);
  })();

  // Audio starts on the first gesture (autoplay policy); until then the game
  // drains its ring by wall clock.
  let audioCtx = null;
  const startAudio = async () => {
    if (audioCtx || !hostPtr) return;
    const ring = new Int32Array(memory.buffer, hostPtr, Host.words)[Host.at.audio_ring] >>> 0;
    if (!ring) return;
    audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await audioCtx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
    const node = new AudioWorkletNode(audioCtx, 'atv2-ring', { numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { buffer: memory.buffer, ring } });
    node.connect(audioCtx.destination);
    await audioCtx.resume();
    state.audio = `${audioCtx.state} ${audioCtx.sampleRate} Hz`;
    log(`[page] audio: ${state.audio}`);
  };
  addEventListener('pointerdown', startAudio);
  addEventListener('keydown', startAudio);

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

window.atv = {
  state, log: logLines,
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
