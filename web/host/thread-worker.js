// thread-worker.js - one host thread of the wasm build (see threads.js).
//
// role 'pool': instantiate the module on the shared memory, mark the slot
//   idle, then forever: sleep on the slot word until thread-spawn claims it,
//   run wasi_thread_start(tid, start_arg), mark the slot idle again.
// role 'main': instantiate and run _start (the C main).
//
// The instance is reused from one thread to the next: wasi_thread_start sets
// the stack pointer and TLS base from the new thread's start_arg each time.
// A thread that traps is not reused (its locks and stack are in an unknown
// state): the slot is marked DEAD and the page is told.

import { CTL, SLOT, threadSpawn } from './threads.js';

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
let port;
if (isNode) {
  const wt = await import('node:worker_threads');
  port = wt.parentPort;
}
const post = (m) => (isNode ? port.postMessage(m) : self.postMessage(m));
const onMsg = (fn) => (isNode ? port.on('message', fn) : self.addEventListener('message', (e) => fn(e.data)));

function describe(e) {
  return { message: String(e && (e.message || e)), stack: e && e.stack ? String(e.stack) : '' };
}

async function run(init) {
  const ctl = new Int32Array(init.ctl);
  const { makeImports } = await import(init.importsUrl);
  const ctx = {
    memory: init.memory, role: init.role, env: init.env, args: init.args, ctl,
    host: init.host, log: (...a) => console.log(...a),
    tid: init.role === 'main' ? 0x3fffffff : 0,
  };
  const imports = makeImports(ctx);
  imports.env = imports.env || {};
  imports.env.memory = init.memory;
  imports.wasi = { 'thread-spawn': (startArg) => threadSpawn(ctl, startArg, init.spare) };
  const inst = await WebAssembly.instantiate(init.module, imports);
  const ex = inst.exports;
  ctx.instance = inst;

  if (init.role === 'main') {
    // Instantiated before every pool Worker (threads.js start()), so this
    // instance's start function set __tls_base to the static TLS block.
    // _start waits for the page's 'run'.
    await new Promise((resolve) => {
      onMsg((m) => { if (m && m.type === 'run') resolve(); });
      post({ type: 'main-ready' });
    });
    // The host tick word (host_time.c): the page pumps it (threads.js).
    if (typeof ex.xbox_WasmHostTickWord === 'function')
      post({ type: 'tick', addr: ex.xbox_WasmHostTickWord() >>> 0,
             watch: typeof ex.xbox_WasmPollWatchTable === 'function' ? ex.xbox_WasmPollWatchTable() >>> 0 : 0 });
    try {
      ex._start();
      post({ type: 'exit', code: 0 });
    } catch (e) {
      if (e && e.wasiExit) post({ type: 'exit', code: e.code | 0 });
      else post({ type: 'trap', tid: ctx.tid, ...describe(e) });
    }
    return;
  }

  const b = CTL.SLOT_BASE + init.slot * CTL.SLOT_INTS;
  Atomics.store(ctl, b, SLOT.IDLE);
  Atomics.add(ctl, CTL.READY, 1);
  Atomics.notify(ctl, CTL.READY);
  post({ type: 'ready' });
  for (;;) {
    let st;
    // Wait on the value just loaded: a claim in between returns at once.
    while ((st = Atomics.load(ctl, b)) !== SLOT.RUNNING) {
      if (Atomics.load(ctl, CTL.EXIT)) return;
      Atomics.wait(ctl, b, st, st === SLOT.IDLE ? 1000 : 10);
    }
    const tid = Atomics.load(ctl, b + 1);
    const arg = Atomics.load(ctl, b + 2);
    ctx.tid = tid;
    try {
      ex.wasi_thread_start(tid, arg);
    } catch (e) {
      Atomics.sub(ctl, CTL.LIVE, 1);
      if (e && e.wasiExit) { post({ type: 'exit', code: e.code | 0 }); return; }
      if (e && e.wasiThreadExit) {   // a thread exit thrown by the imports: reuse the slot
        Atomics.store(ctl, b, SLOT.IDLE);
        Atomics.add(ctl, CTL.READY, 1);
        Atomics.notify(ctl, CTL.READY);
        continue;
      }
      Atomics.store(ctl, b, SLOT.DEAD);
      post({ type: 'trap', tid, ...describe(e) });
      return;
    }
    Atomics.sub(ctl, CTL.LIVE, 1);
    Atomics.store(ctl, b, SLOT.IDLE);
    Atomics.add(ctl, CTL.READY, 1);
    Atomics.notify(ctl, CTL.READY);
  }
}

onMsg((m) => {
  if (m && m.type === 'init') {
    run(m).catch((e) => post({ type: 'trap', tid: -1, ...describe(e) }));
  }
});
