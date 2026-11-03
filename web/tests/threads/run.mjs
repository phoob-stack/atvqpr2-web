// run.mjs - run a wasm32-wasip1-threads test module in Node through
// web/host/threads.js (worker_threads stand in for Web Workers).
//
//   node web/tests/threads/run.mjs [module.wasm] [pool] [ENV=value ...]
// Default module: build-wasm/threads/threads_test.wasm. Exit code: the
// module's; 124 if it did not finish in 120 s.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { WasmThreads } from '../../host/threads.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const argv = process.argv.slice(2);
const wasmPath = argv[0] && argv[0].endsWith('.wasm')
  ? path.resolve(argv.shift()) : path.join(root, 'build-wasm/threads/threads_test.wasm');
const pool = argv[0] && /^\d+$/.test(argv[0]) ? +argv.shift() : 8;
const env = Object.fromEntries(argv.filter((a) => a.includes('=')).map((a) => a.split(/=(.*)/s).slice(0, 2)));

const mem = JSON.parse(readFileSync(wasmPath.replace(/\.wasm$/, '.memory.json'), 'utf8'));
const module = await WebAssembly.compile(readFileSync(wasmPath));
const memory = new WebAssembly.Memory({ initial: mem.initialPages, maximum: mem.maximumPages, shared: true });

const t0 = performance.now();
const wt = new WasmThreads({
  module, memory, env, args: [path.basename(wasmPath)], pool, spare: 2, max: 64,
  importsUrl: pathToFileURL(path.join(here, 'wasi-min.js')).href,
  onTrap: (t) => console.error(`[run] TRAP in ${t.role} slot ${t.slot} tid ${t.tid}: ${t.message}\n${t.stack || ''}`),
});
await wt.start();
console.log(`[run] pool of ${pool} Workers ready in ${(performance.now() - t0).toFixed(0)} ms`);
const timer = setTimeout(() => {
  console.error('[run] TIMEOUT: no exit after 120 s', wt.stats());
  wt.terminate();
  process.exit(124);
}, 120000);
const code = await wt.runMain();
clearTimeout(timer);
console.log(`[run] exit ${code} after ${(performance.now() - t0).toFixed(0)} ms; workers`, wt.stats());
wt.terminate();
process.exit(code);
