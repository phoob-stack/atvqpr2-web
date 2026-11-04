// Single-threaded bring-up runner: the guest main thread only. Instantiates
// the game module with imports.js and runs _start; wasi.thread-spawn says no
// (pthread_create returns EAGAIN). When wasm-threads' threads.js is present,
// main.js uses its worker pool instead and this file is not loaded.
//
// init: { type:'start', module, memory, env, args, host } ->
//   {type:'log'|'exit'|'trap', ...}
import { makeImports } from './imports.js';

const post = (m) => self.postMessage(m);
const log = (text) => post({ type: 'log', fd: 2, text });

self.onmessage = async ({ data }) => {
  if (data.type !== 'start') return;
  const { module, memory, env, args, host } = data;
  let imports, ex;
  try {
    imports = makeImports({ memory, role: 'main', tid: 0x3fffffff, env, args, host, log });
    imports.env.memory = memory;
    let spawnLogged = false;
    imports.wasi = { 'thread-spawn': () => {
      if (!spawnLogged) { spawnLogged = true; log('[host] thread-spawn: single-threaded bring-up, pthread_create fails (EAGAIN)'); }
      return -6;
    } };
    const t0 = performance.now();
    ex = (await WebAssembly.instantiate(module, imports)).exports;
    log(`[host] module instantiated in ${(performance.now() - t0).toFixed(0)} ms; running _start on the guest main thread`);
  } catch (e) {
    post({ type: 'trap', message: `instantiate: ${e.message ?? e}`, stack: String(e.stack ?? '') });
    post({ type: 'exit', code: -2 });
    return;
  }
  let code = 0;
  try {
    ex._start();
  } catch (e) {
    if (e?.wasiExit) code = e.code;
    else if (e?.wasiThreadExit) code = 0;
    else {
      post({ type: 'trap', message: String(e.message ?? e), stack: String(e.stack ?? '') });
      try { ex.web_report_crash(); } catch (e2) { log(`[host] crash report failed: ${e2.message}`); }
      code = -1;
    }
  }
  post({ type: 'exit', code, missing: Object.fromEntries(imports.missing) });
};
