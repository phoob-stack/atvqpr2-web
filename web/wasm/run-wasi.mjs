// Run a wasm32-wasip1 program under Node's WASI with one preopened folder.
//   node web/wasm/run-wasi.mjs <prog.wasm> <out dir> [args...]
import { WASI } from 'node:wasi';
import { readFileSync, mkdirSync } from 'node:fs';
const [wasmPath, outDir, ...args] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const wasi = new WASI({ version: 'preview1', args: ['prog', '/out', ...args], preopens: { '/out': outDir } });
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), wasi.getImportObject());
process.exitCode = wasi.start(instance);
