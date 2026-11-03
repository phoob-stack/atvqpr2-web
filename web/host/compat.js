// What the page needs from the browser, checked up front, and one clear
// message naming what is missing (instead of a hang or a black canvas).
//
//   const r = checkBasics();              // synchronous: isolation, wasm features, workers
//   const w = await checkWorkerSide();    // OPFS SyncAccessHandle, Atomics.wait in a Worker
//   const g = await checkWebGPU();        // adapter, limits, features
//   showProblem({ title, items: [{ what, fix }], details })   // the blocking message
//   showNotice(text)                      // a non-blocking line (e.g. no sound)
//
// Also installs an Atomics.waitAsync stand-in where the browser has none
// (Firefox, as of this writing): main.js, present.js and threads.js wait
// on shared words with it on the page's thread, where Atomics.wait throws.
//
// Nothing here is Chromium-specific: every check is a plain feature test.

const $ = (id) => document.getElementById(id);

// ---- WebAssembly feature probes ----------------------------------------------
// Tiny hand-assembled modules, one per feature the game module uses
// (llvm-objdump: its target_features section and opcodes). Only validated,
// never run.
const H = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const T0 = [0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02, 0x01, 0x00];   // type ()->(), one function
const WASM_PROBES = {
  // shared memory + an atomic read-modify-write
  threads: [...H, ...T0.slice(0, 6), 0x03, 0x02, 0x01, 0x00, 0x05, 0x04, 0x01, 0x03, 0x01, 0x01,
    0x0a, 0x0d, 0x01, 0x0b, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfe, 0x1e, 0x02, 0x00, 0x1a, 0x0b],
  // v128.const
  simd: [...H, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00,
    0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c, ...new Array(16).fill(0), 0x0b],
  // return_call
  'tail calls': [...H, ...T0, 0x0a, 0x06, 0x01, 0x04, 0x00, 0x12, 0x00, 0x0b],
  // try / throw / catch (the encoding wasm-ld emits for setjmp/longjmp here)
  'exception handling': [...H, ...T0, 0x0d, 0x03, 0x01, 0x00, 0x00,
    0x0a, 0x0b, 0x01, 0x09, 0x00, 0x06, 0x40, 0x08, 0x00, 0x07, 0x00, 0x0b, 0x0b],
  // memory.fill
  'bulk memory': [...H, ...T0, 0x05, 0x03, 0x01, 0x00, 0x01,
    0x0a, 0x0d, 0x01, 0x0b, 0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00, 0x0b],
  // i32.trunc_sat_f32_s
  'non-trapping float-to-int': [...H, ...T0, 0x0a, 0x0c, 0x01, 0x0a, 0x00, 0x43, 0x00, 0x00, 0x00, 0x00, 0xfc, 0x00, 0x1a, 0x0b],
  // a global initialised with i32.add
  'extended constant expressions': [...H, 0x06, 0x09, 0x01, 0x7f, 0x00, 0x41, 0x01, 0x41, 0x02, 0x6a, 0x0b],
};

export function wasmFeatures() {
  const missing = [];
  if (typeof WebAssembly !== 'object') return ['WebAssembly'];
  for (const [name, bytes] of Object.entries(WASM_PROBES)) {
    let ok = false;
    try { ok = WebAssembly.validate(new Uint8Array(bytes)); } catch { ok = false; }
    if (!ok) missing.push(name);
  }
  return missing;
}

// Module Workers: the options getter is read only by browsers that know `type`.
// (A blob: URL, which the site's CSP allows for workers, rather than data:.)
function moduleWorkers() {
  let seen = false, url = null;
  try {
    url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    const w = new Worker(url, { get type() { seen = true; return 'module'; } });
    w.terminate();
  } catch { /* the probe URL may be refused; `seen` is what counts */ }
  if (url) URL.revokeObjectURL(url);
  return seen;
}

const BROWSERS = 'Use a current Microsoft Edge or Google Chrome (version 114 or newer), or Firefox 141 or newer on Windows.';

/** Synchronous checks. Returns { problems: [{what, fix}], notes: [text] }. */
export function checkBasics() {
  const problems = [], notes = [];
  if (!window.isSecureContext)
    problems.push({ what: 'a secure context', fix: 'Open the page as http://127.0.0.1:<port>/ or http://localhost:<port>/ (or https).' });
  if (typeof SharedArrayBuffer !== 'function' || !window.crossOriginIsolated)
    problems.push({ what: 'cross-origin isolation (SharedArrayBuffer)',
      fix: 'The server must send "Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp". ' +
        'Start it with web/host/serve.mjs (or play-browser.cmd), not another web server or a file:// URL.' });
  const wasm = wasmFeatures();
  if (wasm.length)
    problems.push({ what: `WebAssembly ${wasm.join(', ')}`, fix: `This browser's WebAssembly is too old for the game module. ${BROWSERS}` });
  if (typeof Worker !== 'function' || !moduleWorkers())
    problems.push({ what: 'module Web Workers', fix: BROWSERS });
  if (typeof Atomics !== 'object' || typeof Atomics.wait !== 'function')
    problems.push({ what: 'Atomics', fix: BROWSERS });
  if (!navigator.storage?.getDirectory)
    problems.push({ what: 'the Origin Private File System (navigator.storage.getDirectory)',
      fix: `${BROWSERS} Private/incognito windows may not have it.` });
  if (!navigator.gpu)
    problems.push({ what: 'WebGPU (navigator.gpu)',
      fix: `${BROWSERS} On Linux, Chrome needs WebGPU turned on in chrome://flags (#enable-unsafe-webgpu); ` +
        'Firefox has it on Windows only so far. Check edge://gpu or chrome://gpu for "WebGPU: Hardware accelerated".' });
  if (typeof AudioWorkletNode !== 'function') notes.push('No AudioWorklet in this browser: the game runs without sound.');
  if (typeof navigator.getGamepads !== 'function') notes.push('No Gamepad API in this browser: use the keyboard.');
  if (typeof Atomics === 'object' && typeof Atomics.waitAsync !== 'function') notes.push('Atomics.waitAsync: using the page\'s stand-in.');
  return { problems, notes };
}

// ---- Worker-side checks ---------------------------------------------------------
// The I/O worker reads the imported game with FileSystemSyncAccessHandle,
// which only exists in Workers, so it is tested in one (a module Worker, the
// kind every other Worker of the page is).

const WORKER_PROBE = `
self.onmessage = async () => {
  const r = { atomicsWait: typeof Atomics.wait === 'function', sab: typeof SharedArrayBuffer === 'function',
    syncAccess: typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype,
    opfs: false, opfsError: null };
  try {
    const root = await navigator.storage.getDirectory();
    if (r.syncAccess) {
      const name = '.atv2-probe-' + Math.random().toString(36).slice(2);
      const h = await (await root.getFileHandle(name, { create: true })).createSyncAccessHandle();
      h.write(new Uint8Array(4), { at: 0 }); h.flush(); h.close();
      await root.removeEntry(name);
    }
    r.opfs = true;
  } catch (e) { r.opfsError = (e && (e.name + ': ' + e.message)) || String(e); }
  postMessage(r);
};`;

export async function checkWorkerSide(timeoutMs = 8000) {
  const problems = [];
  let url = null, w = null;
  try {
    url = URL.createObjectURL(new Blob([WORKER_PROBE], { type: 'text/javascript' }));
    w = new Worker(url, { type: 'module', name: 'feature check' });
    const r = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the check Worker did not answer')), timeoutMs);
      w.onmessage = ({ data }) => { clearTimeout(t); resolve(data); };
      w.onerror = (e) => { clearTimeout(t); reject(new Error(e.message || 'the check Worker failed to start')); };
      w.postMessage(0);
    });
    if (!r.atomicsWait || !r.sab) problems.push({ what: 'Atomics.wait / SharedArrayBuffer in Workers', fix: BROWSERS });
    if (!r.syncAccess) problems.push({ what: 'OPFS synchronous file access (FileSystemSyncAccessHandle)',
      fix: BROWSERS });
    else if (!r.opfs) problems.push({ what: `this browser's file storage (OPFS): ${r.opfsError}`,
      fix: 'Private/incognito windows and some privacy settings turn it off. Use a normal window, and allow this site to store data.' });
    return { problems, worker: r };
  } catch (e) {
    problems.push({ what: `module Web Workers (${e.message})`, fix: BROWSERS });
    return { problems, worker: null };
  } finally {
    w?.terminate();
    if (url) URL.revokeObjectURL(url);
  }
}

// ---- WebGPU ------------------------------------------------------------------------
// The limits the renderer needs (web/gpu/layout.js, encoder.js, the WGSL from
// gpu_shadergen_wgsl.c). All are at or below the WebGPU defaults, so any
// conforming adapter has them; a "compatibility mode" or software adapter
// might not.
export const GPU_LIMITS = {
  maxBindGroups: 2,
  maxDynamicUniformBuffersPerPipelineLayout: 4,
  maxUniformBuffersPerShaderStage: 4,
  maxUniformBufferBindingSize: 3072,
  maxSampledTexturesPerShaderStage: 4,
  maxSamplersPerShaderStage: 4,
  maxVertexBuffers: 1,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 256,
  maxInterStageShaderVariables: 9,     // 8 @location outputs (+ clip distances)
  maxColorAttachments: 1,
  maxTextureDimension2D: 4096,         // NV2A textures and targets go up to 4096
  maxBufferSize: 64 << 20,             // the per-frame arenas (vertices up to ~16 MB, x1.5)
};

/** { problems, notes, adapter, info }. */
export async function checkWebGPU() {
  const problems = [], notes = [];
  if (!navigator.gpu) return { problems, notes, adapter: null };   // reported by checkBasics
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { adapter = null; }
  if (!adapter) {
    problems.push({ what: 'a WebGPU adapter (navigator.gpu.requestAdapter() returned none)',
      fix: 'WebGPU is there but no GPU was offered: the graphics driver may be blocklisted or hardware acceleration ' +
        'is off. Turn on "Use graphics acceleration when available" in the browser settings, update the GPU driver, ' +
        'and check edge://gpu or chrome://gpu.' });
    return { problems, notes, adapter: null };
  }
  const short = [];
  for (const [k, need] of Object.entries(GPU_LIMITS)) {
    const have = adapter.limits?.[k];
    if (typeof have === 'number' && have < need) short.push(`${k} ${have} (needs ${need})`);
  }
  if (short.length)
    problems.push({ what: `WebGPU limits on this GPU: ${short.join(', ')}`, fix: 'This GPU or browser offers less than the renderer needs. Try another browser or GPU.' });
  if (!adapter.features.has('texture-compression-bc'))
    notes.push('This GPU has no BC (DXT) texture compression in WebGPU: most of the game\'s textures will be missing.');
  const info = adapter.info ?? {};
  if (info.isFallbackAdapter || adapter.isFallbackAdapter)
    notes.push('WebGPU is running on a software (fallback) adapter: expect a low frame rate.');
  return { problems, notes, adapter, info };
}

// ---- uploads from shared memory --------------------------------------------------------
// The encoder hands GPUQueue.writeBuffer/writeTexture views straight into the
// shared wasm memory (no copy; the spec's AllowSharedBufferSource). A
// browser whose WebGPU refuses shared views would throw on every upload, so
// this tries both once and, if refused, routes such calls through a reused
// non-shared staging buffer (one copy per upload, as before the encoder went
// zero-copy). Returns { writeBuffer, writeTexture, patched }.
export async function checkSharedUploads(device) {
  const src = new Uint8Array(new SharedArrayBuffer(256));
  const r = { writeBuffer: true, writeTexture: true, patched: false };
  const buf = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST });
  const tex = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST });
  device.pushErrorScope('validation');
  try { device.queue.writeBuffer(buf, 0, src, 0, 16); } catch { r.writeBuffer = false; }
  try { device.queue.writeTexture({ texture: tex }, src, { bytesPerRow: 16 }, [4, 4]); } catch { r.writeTexture = false; }
  const err = await device.popErrorScope().catch(() => null);
  if (err && /shared/i.test(err.message)) { r.writeBuffer = false; r.writeTexture = false; }
  buf.destroy(); tex.destroy();
  if (r.writeBuffer && r.writeTexture) return r;

  let stage = new Uint8Array(1 << 20);
  const staged = (u8) => {
    if (stage.length < u8.length) stage = new Uint8Array(Math.max(u8.length, stage.length * 2));
    stage.set(u8);
    return stage.subarray(0, u8.length);
  };
  const bytesOf = (d) => (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
  const isShared = (d) => typeof SharedArrayBuffer === 'function' && (ArrayBuffer.isView(d) ? d.buffer : d) instanceof SharedArrayBuffer;
  const Q = GPUQueue.prototype;
  if (!r.writeBuffer) {
    const wb = Q.writeBuffer;
    Q.writeBuffer = function (buffer, offset, data, dataOffset = 0, size) {
      if (!isShared(data)) return wb.call(this, buffer, offset, data, dataOffset, size);
      const es = data.BYTES_PER_ELEMENT ?? 1, u8 = bytesOf(data);
      const start = dataOffset * es, len = size === undefined ? u8.length - start : size * es;
      return wb.call(this, buffer, offset, staged(u8.subarray(start, start + len)));
    };
  }
  if (!r.writeTexture) {
    const wt = Q.writeTexture;
    Q.writeTexture = function (dest, data, layout, size) {
      if (!isShared(data)) return wt.call(this, dest, data, layout, size);
      const u8 = bytesOf(data), off = layout.offset ?? 0;
      const [w, h = 1, d = 1] = Array.isArray(size) ? size : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
      const rows = (layout.rowsPerImage ?? h) * (d - 1) + h;
      // Enough for any format (block formats need fewer rows); never past the source.
      const need = Math.min(u8.length - off, (layout.bytesPerRow ?? w * 16) * rows);
      return wt.call(this, dest, staged(u8.subarray(off, off + need)), { ...layout, offset: 0 }, size);
    };
  }
  r.patched = true;
  return r;
}

// ---- messages ------------------------------------------------------------------------

const CSS = `
#atv-problem { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: rgba(0,0,0,.94); font: 15px/1.5 system-ui, 'Segoe UI', sans-serif; color: #ddd; z-index: 10; }
#atv-problem .card { max-width: 640px; width: 100%; background: #1c1616; border: 1px solid #6a3b3b; border-radius: 8px; padding: 24px; }
#atv-problem h1 { margin: 0 0 8px; font-size: 20px; color: #fff; }
#atv-problem ul { padding-left: 20px; margin: 10px 0; }
#atv-problem li { margin: 8px 0; }
#atv-problem b { color: #f2a65a; }
#atv-problem .fix { color: #bbb; font-size: 14px; }
#atv-problem pre { max-height: 30vh; overflow: auto; font: 12px ui-monospace, Consolas, monospace; color: #999; white-space: pre-wrap; }
#atv-notice { position: fixed; left: 8px; right: 8px; top: 8px; padding: 6px 10px; background: rgba(60,45,10,.92);
  border: 1px solid #8a6d2a; border-radius: 4px; font: 13px system-ui, sans-serif; color: #f0d9a0; z-index: 5; }
#atv-notice button { float: right; background: none; border: 0; color: inherit; cursor: pointer; font: inherit; }`;

function ensureCss() {
  if ($('atv-compat-css')) return;
  const s = document.createElement('style');
  s.id = 'atv-compat-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

/** The one blocking message. Later calls replace it. */
export function showProblem({ title = "This browser can't run the game", lead = 'Missing:', items = [], details = '' }) {
  ensureCss();
  $('atv-problem')?.remove();
  const box = document.createElement('div');
  box.id = 'atv-problem';
  box.setAttribute('role', 'alert');
  const card = document.createElement('div');
  card.className = 'card';
  const h = document.createElement('h1');
  h.textContent = title;
  card.appendChild(h);
  if (items.length) {
    const p = document.createElement('p');
    p.textContent = lead;
    card.appendChild(p);
    const ul = document.createElement('ul');
    for (const it of items) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = it.what;
      li.appendChild(b);
      if (it.fix) { const f = document.createElement('div'); f.className = 'fix'; f.textContent = it.fix; li.appendChild(f); }
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }
  if (details) { const pre = document.createElement('pre'); pre.textContent = details; card.appendChild(pre); }
  box.appendChild(card);
  document.body.appendChild(box);
  const st = $('status');
  if (st) st.textContent = `${title}: ${items.map((i) => i.what).join('; ') || details.split('\n')[0]}`;
}

/** A dismissable one-line notice at the top (non-blocking). */
export function showNotice(text) {
  ensureCss();
  let n = $('atv-notice');
  if (!n) {
    n = document.createElement('div'); n.id = 'atv-notice';
    const x = document.createElement('button'); x.textContent = '×'; x.title = 'Dismiss';
    x.onclick = () => n.remove();
    n.appendChild(x);
    n.appendChild(document.createElement('span'));
    document.body.appendChild(n);
  }
  const span = n.querySelector('span');
  span.textContent = span.textContent ? `${span.textContent} ${text}` : text;
}

// ---- Atomics.waitAsync stand-in ------------------------------------------------------
// One small classic Worker per outstanding wait (pooled): it blocks in
// Atomics.wait on the same shared word and posts the result, so a wake-up
// arrives as promptly as the real thing. Returns the real API's shape:
// { async: false, value: 'not-equal' | 'timed-out' } or { async: true, value: Promise }.

const WAITER = `onmessage = ({ data: [buf, off, len, big, index, value, timeout] }) => {
  const a = big ? new BigInt64Array(buf, off, len) : new Int32Array(buf, off, len);
  postMessage(Atomics.wait(a, index, value, timeout));
};`;
let waiterUrl = null;
const idleWaiters = [];

export function installWaitAsync() {
  if (typeof Atomics !== 'object' || typeof Atomics.waitAsync === 'function') return false;
  Atomics.waitAsync = function waitAsync(ta, index, value, timeout = Infinity) {
    const big = ta instanceof BigInt64Array;
    if (!(ta instanceof Int32Array) && !big) throw new TypeError('Atomics.waitAsync: Int32Array or BigInt64Array expected');
    const t = Number(timeout);
    const to = Number.isNaN(t) ? Infinity : Math.max(0, t);
    if (Atomics.load(ta, index) !== value) return { async: false, value: 'not-equal' };
    if (to === 0) return { async: false, value: 'timed-out' };
    waiterUrl ??= URL.createObjectURL(new Blob([WAITER], { type: 'text/javascript' }));
    const w = idleWaiters.pop() ?? new Worker(waiterUrl, { name: 'waitAsync' });
    const value_ = new Promise((resolve) => {
      w.onmessage = ({ data }) => { idleWaiters.push(w); resolve(data); };
      w.onerror = () => resolve('timed-out');
    });
    w.postMessage([ta.buffer, ta.byteOffset, ta.length, big, index, value, to]);
    return { async: true, value: value_ };
  };
  return true;
}
