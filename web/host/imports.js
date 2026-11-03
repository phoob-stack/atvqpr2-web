// The game module's imports for one guest thread (every thread, main or
// pool, builds its own). This is the `importsUrl` module of wasm-threads'
// threads.js / thread-worker.js:
//
//   makeImports({ memory, tid, role, env, args, host, log }) -> imports
//
// `host` is what the page passes for every thread: { io } (the I/O channel,
// io.js). Everything except wasi.thread-spawn (threads.js adds it):
//   wasi_snapshot_preview1: args/environ/clocks/sleep/random/exit answered
//     here; files and stdio forwarded to the one fd table in the I/O worker.
//   env.web_host_ready(ptr): web_main.c's host block -> the page.
//   env.web_thread_exit(): pthread_exit. Throws an Error with
//     `wasiThreadExit: true`; the thread's worker treats it as a return from
//     the start routine.
//   env.<anything else>: bring-up stubs for what the link left undefined
//     (--allow-undefined): log the name on the first calls, return 0.
// proc_exit throws an Error with `wasiExit: true` and `code`.
import { Wasi, LOCAL_CALLS } from './wasi.js';
import { ioClient, IO_HOST_PTR } from './io.js';

export function makeImports(ctx) {
  const host = ctx.host ?? {};
  if (!host.io) throw new Error('makeImports: no I/O channel (ctx.host.io)');
  const log = ctx.log ?? ((s) => console.warn(s));
  const local = new Wasi({ vfs: null, args: ctx.args ?? ['atv2'], env: ctx.env ?? {} });
  local.memory = ctx.memory;
  const li = local.imports();
  const wasi = ioClient(host.io);
  for (const n of LOCAL_CALLS) wasi[n] = li[n];

  const ioWords = new Int32Array(host.io);
  const missing = new Map();
  const env = {
    web_host_ready(ptr) {
      Atomics.store(ioWords, IO_HOST_PTR, ptr);
      Atomics.notify(ioWords, IO_HOST_PTR);
    },
    web_thread_exit() {
      const e = new Error('pthread_exit');
      e.wasiThreadExit = true;
      throw e;
    },
  };
  const stubs = new Proxy(env, {
    get(t, name) {
      if (name in t || typeof name !== 'string') return t[name];
      return (t[name] = (...a) => {
        const n = (missing.get(name) ?? 0) + 1;
        missing.set(name, n);
        if (n <= 3) log(`[host] MISSING env.${name}(${a.join(', ')}) called on thread ${ctx.tid ?? '?'} (stub returns 0)`);
        return 0;
      });
    },
  });
  return { wasi_snapshot_preview1: wasi, env: stubs, missing };
}
