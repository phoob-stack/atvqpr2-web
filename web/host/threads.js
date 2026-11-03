// threads.js - wasi-threads for the ATV 2 wasm build: one Web Worker per
// host thread, from a pool started up front (nfsu2-web's shape; see
// WASM-THREADS.md).
//
// The C side is wasi-libc's pthreads (wasm32-wasip1-threads). pthread_create
// calls the import `wasi.thread-spawn(start_arg) -> tid`, synchronously, on
// whatever thread creates the thread, and expects a new thread to enter the
// module's export `wasi_thread_start(tid, start_arg)`. A Worker cannot be
// created and started synchronously from inside a running Worker, so a pool
// of Workers is created first; each instantiates the module on the shared
// memory and then sleeps in Atomics.wait on its slot of a small shared
// control block. thread-spawn claims an idle slot with a compare-exchange,
// writes tid and start_arg, and wakes that Worker. When the thread's start
// routine returns, the Worker marks its slot idle again and is reused.
//
// The page keeps `spare` slots idle: a spawn that leaves fewer bumps the
// GROW word and the page adds Workers in the background (Atomics.waitAsync,
// never blocking the page). A spawn that finds no idle slot waits, in its
// own Worker, for the page to add one (a Worker takes ~50 ms to start).
//
// No C code ever runs on the page's main thread: memory.atomic.wait32 and
// Atomics.wait trap there. The C main() runs in a Worker of its own
// (runMain), and the page only presents frames and forwards input.
//
// Works in the browser (module Workers) and in Node >= 20 (worker_threads),
// for the tests in web/tests/threads.
//
// Interface for the host (wasm-host):
//   const wt = new WasmThreads({ module, memory, importsUrl, env, args, host,
//                                pool: 14, spare: 2, max: 64, tickMs: 4,
//                                onExit(code), onTrap(info) });
//   await wt.start();                 // pool Workers instantiated and idle
//   const code = await wt.runMain();  // _start in its own Worker
//   wt.terminate();
// `importsUrl` names an ES module exporting
//   makeImports({ memory, tid, role, env, args, host, ctl, log }) -> imports
// that returns every import except wasi.thread-spawn (threads.js adds it).
// Its proc_exit must throw an object with `wasiExit: true` and `code`. A
// throw with `wasiThreadExit: true` out of a thread ends just that thread
// (the slot is reused); the C side's pthread_exit (win32_compat.c) does not
// need it, it unwinds with longjmp and returns through wasi-libc.
// `host` is any structured-cloneable value (wasm-host passes its I/O
// SharedArrayBuffer), handed to every Worker's makeImports as ctx.host.

export const CTL = {
  MAGIC: 0,      // 'WTHR'
  NEXT_TID: 1,   // next tid to hand out (1, 2, ...; wasi-libc's main is 0x3FFFFFFF)
  SLOTS: 2,      // slots created so far (only the page grows it)
  GROW: 3,       // bumped by a spawn that wants more Workers
  LIVE: 4,       // threads running now
  EXIT: 5,       // 1 once the process exited (proc_exit or a trap)
  EXIT_CODE: 6,
  READY: 7,      // bumped each time a pool Worker becomes idle for the first time
  SPAWNED: 8,    // threads spawned in total
  SPAWN_WAITS: 9,// spawns that had to wait for a Worker
  CLOCK: 10,     // 10-11: the last monotonic ns handed out (BigInt64), see sharedMonotonicNs
  SLOT_BASE: 16,
  SLOT_INTS: 4,  // state, tid, start_arg, spare
};
export const SLOT = { NONE: 0, STARTING: 1, IDLE: 2, CLAIMED: 3, RUNNING: 4, DEAD: 5 };
export const MAX_SLOTS = 256;
export const CTL_BYTES = (CTL.SLOT_BASE + MAX_SLOTS * CTL.SLOT_INTS) * 4;
const MAGIC = 0x52485457;  // 'WTHR'
const EAGAIN = 6;          // wasi errno

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

// WASI clock_time_get(MONOTONIC) for every Worker. performance.timeOrigin +
// performance.now() is one epoch for all of them, but each is coarsened
// (5 us, with jitter, in a cross-origin isolated page), so a time read on one
// thread can be a few microseconds *before* one read earlier on another.
// The runtime subtracts such pairs as unsigned numbers (vblank-ack ages, the
// guest CPU's turn lengths), and a negative difference becomes ~584 years.
// So the clock is clamped to never go below the last value any thread got.
const clockViews = new WeakMap();
export function sharedMonotonicNs(ctl) {
  let b = clockViews.get(ctl);
  if (!b) { b = new BigInt64Array(ctl.buffer, CTL.CLOCK * 4, 1); clockViews.set(ctl, b); }
  const now = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  for (;;) {
    const prev = Atomics.load(b, 0);
    if (now <= prev) return prev;
    if (Atomics.compareExchange(b, 0, prev, now) === prev) return now;
  }
}

function slotBase(i) { return CTL.SLOT_BASE + i * CTL.SLOT_INTS; }

function idleCount(ctl) {
  const n = Atomics.load(ctl, CTL.SLOTS);
  let k = 0;
  for (let i = 0; i < n; i++) if (Atomics.load(ctl, slotBase(i)) === SLOT.IDLE) k++;
  return k;
}

function askGrow(ctl) {
  Atomics.add(ctl, CTL.GROW, 1);
  Atomics.notify(ctl, CTL.GROW);
}

// wasi.thread-spawn, run synchronously on the calling Worker.
export function threadSpawn(ctl, startArg, spare = 2, waitMs = 15000) {
  const deadline = Date.now() + waitMs;
  let waited = false;
  for (;;) {
    if (Atomics.load(ctl, CTL.EXIT)) return -EAGAIN;
    const n = Atomics.load(ctl, CTL.SLOTS);
    for (let i = 0; i < n; i++) {
      const b = slotBase(i);
      if (Atomics.compareExchange(ctl, b, SLOT.IDLE, SLOT.CLAIMED) !== SLOT.IDLE) continue;
      const tid = Atomics.add(ctl, CTL.NEXT_TID, 1);
      Atomics.store(ctl, b + 1, tid);
      Atomics.store(ctl, b + 2, startArg);
      Atomics.add(ctl, CTL.LIVE, 1);
      Atomics.add(ctl, CTL.SPAWNED, 1);
      Atomics.store(ctl, b, SLOT.RUNNING);
      Atomics.notify(ctl, b);
      if (idleCount(ctl) < spare) askGrow(ctl);
      return tid;
    }
    // None idle: ask the page for more and wait for one to come up.
    if (!waited) { Atomics.add(ctl, CTL.SPAWN_WAITS, 1); waited = true; }
    const ready = Atomics.load(ctl, CTL.READY);
    askGrow(ctl);
    const left = deadline - Date.now();
    if (left <= 0) return -EAGAIN;
    Atomics.wait(ctl, CTL.READY, ready, Math.min(left, 100));
  }
}

function on(w, ev, fn) {
  if (typeof w.on === 'function') w.on(ev, fn);          // Node worker_threads
  else w.addEventListener(ev, ev === 'message' ? (e) => fn(e.data) : fn);
}

export class WasmThreads {
  constructor(opts) {
    this.module = opts.module;              // WebAssembly.Module
    this.memory = opts.memory;              // shared WebAssembly.Memory
    this.importsUrl = String(opts.importsUrl);
    this.workerUrl = opts.workerUrl || new URL('./thread-worker.js', import.meta.url);
    this.env = opts.env || {};
    this.args = opts.args || ['game'];
    this.host = opts.host;
    this.poolSize = opts.pool ?? 14;
    this.spare = opts.spare ?? 2;
    this.max = Math.min(opts.max ?? 64, MAX_SLOTS);
    this.onExit = opts.onExit || (() => {});
    this.onTrap = opts.onTrap || ((t) => console.error('[threads] trap', t));
    this.tickMs = opts.tickMs ?? 4;
    this.tickAddr = 0;
    this.ctlSab = new SharedArrayBuffer(CTL_BYTES);
    this.ctl = new Int32Array(this.ctlSab);
    this.ctl[CTL.MAGIC] = MAGIC;
    this.ctl[CTL.NEXT_TID] = 1;
    this.workers = [];
    this.mainWorker = null;
    this.stopped = false;
    this._exitWaiters = [];
    this.exitCode = undefined;
  }

  async _makeWorker() {
    if (isNode) {
      const { Worker } = await import('node:worker_threads');
      return new Worker(this.workerUrl, { resourceLimits: { stackSizeMb: 8 } });
    }
    return new Worker(this.workerUrl, { type: 'module', name: 'wasm-thread' });
  }

  _init(role, slot) {
    return {
      type: 'init', role, slot, module: this.module, memory: this.memory,
      ctl: this.ctlSab, importsUrl: this.importsUrl, env: this.env,
      args: this.args, spare: this.spare, host: this.host,
    };
  }

  _wire(w, role, slot) {
    on(w, 'message', (m) => this._onMessage(m, role, slot));
    on(w, 'error', (e) => this._trap({ role, slot, message: String(e && (e.message || e)) }));
  }

  _onMessage(m, role, slot) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'exit') this._exit(m.code);
    else if (m.type === 'tick') { this._watchAddr = m.watch || 0; this._startTicks(m.addr); }
    else if (m.type === 'trap') this._trap({ role, slot, ...m });
    else if (m.type === 'ready' && this._readyWaiters) {
      const r = this._readyWaiters.get(slot);
      if (r) { this._readyWaiters.delete(slot); r(); }
    }
  }

  _trap(info) {
    this.onTrap(info);
    // A thread that trapped may hold locks every other thread needs; the
    // process is over (as a native crash would be).
    this._exit(info.code ?? 134);
  }

  _exit(code) {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    Atomics.store(this.ctl, CTL.EXIT_CODE, code | 0);
    Atomics.store(this.ctl, CTL.EXIT, 1);
    this.onExit(code);
    for (const r of this._exitWaiters) r(code);
    this._exitWaiters = [];
  }

  async _addPoolWorker() {
    const i = Atomics.load(this.ctl, CTL.SLOTS);
    if (i >= this.max) return false;
    Atomics.store(this.ctl, slotBase(i), SLOT.STARTING);
    Atomics.store(this.ctl, CTL.SLOTS, i + 1);
    const w = await this._makeWorker();
    this.workers[i] = w;
    this._readyWaiters ??= new Map();
    const ready = new Promise((r) => this._readyWaiters.set(i, r));
    this._wire(w, 'pool', i);
    w.postMessage(this._init('pool', i));
    await ready;
    return true;
  }

  async start() {
    const adds = [];
    for (let k = 0; k < this.poolSize; k++) adds.push(this._addPoolWorker());
    await Promise.all(adds);
    this._growLoop();
    return this;
  }

  async _growLoop() {
    let seen = Atomics.load(this.ctl, CTL.GROW);
    while (!this.stopped && this.exitCode === undefined) {
      const r = Atomics.waitAsync(this.ctl, CTL.GROW, seen);
      if (r.async) await r.value;
      if (this.stopped) break;
      seen = Atomics.load(this.ctl, CTL.GROW);
      if (idleCount(this.ctl) >= this.spare) continue;
      const adds = [];
      for (let k = 0; k < this.spare; k++) adds.push(this._addPoolWorker());
      await Promise.all(adds);
    }
  }

  // The host tick word (xbox_WasmHostTickWord, host_time.c). Timed waits in
  // a Worker are rounded up to the 15.6 ms Windows tick (Atomics.wait and
  // memory.atomic.wait32 alike), so the timer thread (vblank grid, DPCs) and
  // Sleep wait on this word instead and the page wakes them: at every
  // animation frame, and every `tickMs` (4) from a page timer, which keeps
  // ticking in a hidden tab (throttled) and in Node. An AudioWorklet can
  // bump the same word every render quantum: memory + tickAddr.
  _startTicks(addr) {
    if (this._tick || this.stopped) return;
    this.tickAddr = addr;
    const t = new Int32Array(this.memory.buffer, addr, 1);
    // The poll-watch table (xbox_WasmPollWatchTable): [count, addr...] of
    // words host threads poll-wait on; each tick wakes them too.
    const watch = this._watchAddr ? new Int32Array(this.memory.buffer, this._watchAddr, 17) : null;
    const bump = () => {
      Atomics.add(t, 0, 1); Atomics.notify(t, 0);
      if (watch) {
        const n = Math.min(Atomics.load(watch, 0), 16);
        if (n) {
          let all = this._allI32 ??= new Int32Array(this.memory.buffer);
          for (let i = 1; i <= n; i++) {
            const k = (watch[i] >>> 0) >>> 2;
            // The memory may have grown since the view was made.
            if (k >= all.length) all = this._allI32 = new Int32Array(this.memory.buffer);
            if (k < all.length) Atomics.notify(all, k);
          }
        }
      }
    };
    this._tick = bump;
    this._tickTimer = setInterval(bump, this.tickMs);
    if (typeof requestAnimationFrame === 'function') {
      const frame = () => { if (this.stopped) return; bump(); this._raf = requestAnimationFrame(frame); };
      this._raf = requestAnimationFrame(frame);
    }
  }

  // Run _start (the C main) in a Worker of its own. Resolves with the exit code.
  async runMain() {
    const done = new Promise((r) => this._exitWaiters.push(r));
    if (this.exitCode !== undefined) return this.exitCode;
    const w = await this._makeWorker();
    this.mainWorker = w;
    this._wire(w, 'main', -1);
    w.postMessage(this._init('main', -1));
    return done;
  }

  stats() {
    const c = this.ctl;
    return {
      slots: Atomics.load(c, CTL.SLOTS), idle: idleCount(c), live: Atomics.load(c, CTL.LIVE),
      spawned: Atomics.load(c, CTL.SPAWNED), spawnWaits: Atomics.load(c, CTL.SPAWN_WAITS),
    };
  }

  terminate() {
    this.stopped = true;
    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
    Atomics.store(this.ctl, CTL.EXIT, 1);
    askGrow(this.ctl);
    for (const w of this.workers) if (w) w.terminate();
    if (this.mainWorker) this.mainWorker.terminate();
  }
}
