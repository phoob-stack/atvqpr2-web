// The page's feature checks and messages (web/host/compat.js), tested in
// headless Edge with features taken away: browser switches, or a script
// injected into the page (and, for Worker-only APIs, into every Worker)
// before the page's own code runs.
//
//   node web/tools/compat-test.mjs --profile <dir> [--port 8835] [only-these-scenarios...]
//
// --profile: an Edge profile with the game imported into OPFS
// (web/tools/import.mjs), so the scenarios that should still boot have the
// game. Each scenario reports the message box (#atv-problem), the notice
// line, and whether the title (PRESS START) came up, and checks them against
// what it expects.
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serve } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('--port', 8835));
const profile = opt('--profile');
const only = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!profile) { console.log('usage: compat-test.mjs --profile <dir with the game imported> [scenario...]'); process.exit(2); }

const limitsShim = (over) => `{
  const d = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, 'limits');
  const over = ${JSON.stringify(over)};
  Object.defineProperty(GPUAdapter.prototype, 'limits', { configurable: true, get() {
    const l = d.get.call(this);
    return new Proxy(l, { get(t, k) { if (k in over) return over[k]; const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; } });
  } });
}`;

// expect: 'problem:<text in the box>' | 'boots' | 'boots+notice:<text>'
const SCENARIOS = {
  baseline: { expect: 'boots' },
  'no-isolation': { plainServer: true, expect: 'problem:cross-origin isolation' },
  'no-webgpu': { page: 'delete Navigator.prototype.gpu;', expect: 'problem:WebGPU (navigator.gpu)' },
  // A real switch: no GPU process acceleration (Edge then offers no adapter, or only a software one).
  'disable-gpu': { args: ['--disable-gpu'], expect: 'boots+notice:software (fallback) adapter' },
  'no-adapter': { page: 'GPU.prototype.requestAdapter = async function () { return null; };', expect: 'problem:a WebGPU adapter' },
  'low-limits': { page: limitsShim({ maxVertexAttributes: 8, maxInterStageShaderVariables: 6 }), expect: 'problem:maxVertexAttributes 8' },
  'no-bc': { page: `{ const fd = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, 'features');
      Object.defineProperty(GPUAdapter.prototype, 'features', { configurable: true, get() {
        const s = new Set(fd.get.call(this)); s.delete('texture-compression-bc'); return s; } }); }`,
    expect: 'boots+notice:no BC (DXT) texture compression' },
  'no-waitasync': { page: 'delete Atomics.waitAsync;', expect: 'boots', fps: true },
  'no-sync-access': { worker: 'delete FileSystemFileHandle.prototype.createSyncAccessHandle;',
    expect: 'problem:FileSystemSyncAccessHandle' },
  'no-opfs': { page: 'delete StorageManager.prototype.getDirectory;', expect: 'problem:Origin Private File System' },
  // (Edge ignores --js-flags=--no-experimental-wasm-legacy-eh: shipped features stay on.)
  'wasm-no-eh': { page: `{ const v = WebAssembly.validate; WebAssembly.validate = (b) => {
      const u = new Uint8Array(b.buffer ?? b); for (let i = 0; i + 1 < u.length; i++) if (u[i] === 0x06 && u[i + 1] === 0x40) return false;
      return v(b); }; }`, expect: 'problem:WebAssembly exception handling' },
  'wasm-compile-error': { page: `{ const fail = async () => { throw new WebAssembly.CompileError('Compiling function #0 failed: invalid opcode 0xfd (test)'); };
      WebAssembly.compileStreaming = fail; WebAssembly.compile = fail; }`, expect: "problem:can't compile the game module" },
  'no-memory': { page: `{ const M = WebAssembly.Memory; WebAssembly.Memory = function (d) {
      if (d && d.initial > 32768) throw new RangeError('WebAssembly.Memory(): could not allocate memory'); return new M(d); };
      WebAssembly.Memory.prototype = M.prototype; }`, expect: 'problem:Not enough memory' },
  // Firefox-like WebGPU that refuses views of shared memory in uploads: the page copies instead.
  'no-shared-uploads': { page: `{ const sh = (d) => (ArrayBuffer.isView(d) ? d.buffer : d) instanceof SharedArrayBuffer;
      for (const k of ['writeBuffer', 'writeTexture']) { const f = GPUQueue.prototype[k];
        GPUQueue.prototype[k] = function (a, b, ...r) { if (sh(k === 'writeBuffer' ? r[0] : b)) throw new TypeError(k + ': shared buffers not allowed (test)'); return f.call(this, a, b, ...r); }; } }`,
    expect: 'boots', fps: true },
  'no-audio-gamepad': { page: 'delete window.AudioWorkletNode; delete Navigator.prototype.getGamepads;', expect: 'boots' },
  'no-module-workers': { page: `{ const W = Worker; window.Worker = function (u, o) { if (o && o.type === 'module') throw new TypeError('module workers unsupported'); return new W(u, o); };
      window.Worker.prototype = W.prototype; }`, expect: 'problem:module Web Workers' },
};

async function runScenario(name, sc) {
  let srv = null, stat = null;
  if (sc.plainServer) {
    stat = await serve({ '/host/': join(ROOT, 'web/host'), '/gpu/': join(ROOT, 'web/gpu') });
  } else {
    srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port),
      '--log', join(ROOT, 'build-wasm/loadtime/serve-compat.log')], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => srv.stdout.once('data', r));
  }
  const origin = stat ? stat.url : `http://127.0.0.1:${port}`;
  const url = `${origin}/host/index.html?env=RECOMP_SKIP_MOVIES=1`;
  const b = await launch(`${origin}/host/blank-for-compat-test`, { profile, port: 9800 + port % 100, extraArgs: sc.args ?? [], waitReady: false });
  const r = { name, problem: null, notice: null, title: false, fps: null, error: null };
  try {
    await b.send('Page.enable');
    if (sc.page) await b.send('Page.addScriptToEvaluateOnNewDocument', { source: sc.page });
    if (sc.worker) {
      // Every Worker starts paused; it is resumed with a breakpoint before its
      // first script, where its global interfaces exist, and the shim runs there.
      const done = new Set();
      b.on((m) => {
        if (m.method === 'Target.attachedToTarget') {
          const sid = m.params.sessionId;
          b.send('Debugger.enable', {}, sid)
            .then(() => b.send('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }, sid))
            .then(() => b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid))
            .then(() => b.send('Runtime.runIfWaitingForDebugger', {}, sid));
        } else if (m.method === 'Debugger.paused' && m.sessionId) {
          const sid = m.sessionId;
          const go = () => b.send('Debugger.resume', {}, sid);
          if (done.has(sid)) { go(); return; }
          done.add(sid);
          b.send('Runtime.evaluate', { expression: sc.worker }, sid)
            .then((e) => { if (process.env.DEBUG) console.log('worker shim', JSON.stringify(e).slice(0, 160)); })
            .then(() => b.send('Debugger.removeInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }, sid))
            .then(go);
        }
      });
      await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    }
    await b.send('Page.navigate', { url });
    const t0 = Date.now();
    let fl0 = null;
    while (Date.now() - t0 < 40000) {
      await sleep(500);
      let s;
      try {
        s = await b.eval(`({ problem: document.getElementById('atv-problem')?.innerText ?? null,
          notice: document.getElementById('atv-notice')?.innerText ?? null,
          status: document.getElementById('status')?.textContent ?? '', error: window.atv?.state?.error ?? null,
          flips: (() => { try { return atv.presenter.i32[atv.flipsIndex ?? -1] ?? null; } catch { return null; } })() })`);
      } catch { continue; }
      r.problem = s.problem; r.notice = s.notice; r.error = s.error;
      if (s.status.includes('draws 18,')) r.title = true;
      if (r.problem) break;
      if (r.title && !sc.fps) break;
      if (r.title && sc.fps) {
        // Flips per second over 5 s at the title (the Atomics.waitAsync stand-in carries frames and the boot).
        await b.eval(`import('/host/abi.js').then((m) => { atv.flipsIndex = m.Host.at.flips; return 1; })`);
        const f0 = await b.eval('atv.presenter.i32[atv.flipsIndex]'); const t1 = Date.now();
        const g0 = await b.eval('atv.presenter.stats.frames');
        await sleep(5000);
        const f1 = await b.eval('atv.presenter.i32[atv.flipsIndex]'); const g1 = await b.eval('atv.presenter.stats.frames');
        r.fps = { flips: ((f1 - f0) * 1000 / (Date.now() - t1)).toFixed(1), gpuFrames: ((g1 - g0) * 1000 / (Date.now() - t1)).toFixed(1) };
        break;
      }
    }
  } catch (e) { r.error = String(e.message ?? e); } finally {
    await b.closeGracefully();
    srv?.kill(); stat?.close();
  }
  const [kind, text] = sc.expect.split(/:(.*)/s);
  r.pass = kind === 'problem' ? !!r.problem && r.problem.includes(text) && !r.title
    : kind === 'boots' ? r.title && !r.problem
    : kind === 'boots+notice' ? r.title && !r.problem && !!r.notice && r.notice.includes(text) : false;
  return r;
}

let fails = 0;
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (only.length && !only.includes(name)) continue;
  const r = await runScenario(name, sc);
  if (!r.pass) fails++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${name.padEnd(18)} expect ${sc.expect}`);
  if (r.problem) console.log(`     box: ${r.problem.replace(/\s*\n\s*/g, ' | ').slice(0, 400)}`);
  if (r.notice) console.log(`     notice: ${r.notice.replace(/\s*\n\s*/g, ' ').slice(0, 200)}`);
  console.log(`     title ${r.title}${r.fps ? `, ${r.fps.flips} flips/s, ${r.fps.gpuFrames} GPU frames/s` : ''}${r.error && !r.problem ? `, error ${r.error}` : ''}`);
}
process.exit(fails ? 1 : 0);
