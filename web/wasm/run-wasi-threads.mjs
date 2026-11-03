// Run a wasm32-wasip1-threads program (imported shared memory) under Node's WASI.
//   node web/wasm/run-wasi-threads.mjs <prog.wasm> [args...]
//
// For tests that link only part of the runtime with --allow-undefined: the
// shared memory is created at the module's declared minimum (max 4 GB), every
// function import nothing provides becomes a stub that returns 0 and is listed
// at exit, and wasi thread-spawn fails (no workers here), so CreateThread
// returns NULL and the code under test runs single-threaded.
import { WASI } from 'node:wasi';
import { readFileSync } from 'node:fs';

const [wasmPath, ...args] = process.argv.slice(2);
const bytes = readFileSync(wasmPath);

// The imported memory's limits, from the import section.
function memoryImportLimits(buf) {
  let p = 8;
  const leb = () => { let r = 0, s = 0, b; do { b = buf[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const name = () => { const n = leb(); p += n; };
  while (p < buf.length) {
    const id = buf[p++], size = leb(), end = p + size;
    if (id === 2) {
      for (let n = leb(); n > 0; n--) {
        name(); name();
        const kind = buf[p++];
        if (kind === 0) leb();
        else if (kind === 1) { p++; const f = buf[p++]; leb(); if (f & 1) leb(); }
        else if (kind === 2) { const f = buf[p++]; const min = leb(); const max = f & 1 ? leb() : undefined; return { min, max, shared: !!(f & 2) }; }
        else if (kind === 3) p += 2;
        else if (kind === 4) { p++; leb(); }
      }
    }
    p = end;
  }
  return null;
}

const lim = memoryImportLimits(bytes);
const memory = new WebAssembly.Memory({ initial: lim.min, maximum: lim.max ?? 65536, shared: lim.shared });
const module = new WebAssembly.Module(bytes);
const wasi = new WASI({ version: 'preview1', args: ['prog', ...args], env: process.env, preopens: { '/': process.cwd() } });
const imports = wasi.getImportObject();
imports.env = { memory };
imports.wasi = { 'thread-spawn': () => -1 };
const stubbed = new Set();
for (const imp of WebAssembly.Module.imports(module)) {
  if (imp.kind !== 'function' || imports[imp.module]?.[imp.name]) continue;
  (imports[imp.module] ??= {})[imp.name] = () => { stubbed.add(imp.name); return 0; };
}
const instance = new WebAssembly.Instance(module, imports);
console.log(`[run] memory: ${lim.min} pages imported (shared=${lim.shared}, max ${lim.max ?? 65536})`);
const code = wasi.start(instance);
console.log(`[run] exit ${code}; stubbed imports called: ${[...stubbed].join(' ') || 'none'}; memory now ${memory.buffer.byteLength / 65536} pages`);
process.exitCode = code;
