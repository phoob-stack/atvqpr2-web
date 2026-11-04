#!/usr/bin/env node
// kit-build.mjs - build atv2.wasm from the generated C and a prebuilt runtime
// kit (web/wasm/package-runtime.sh), with only the kit's command lines: the
// generated files are compiled, then linked against the kit's rt.a. No
// runtime source and no wasi-sdk sysroot is read; clang and wasm-ld are the
// only tools used. This is the build a host without the runtime's sources
// would run (a browser runs the same cc1 and wasm-ld argument lists).
//
//   node web/wasm/kit-build.mjs --kit <dir> --gen <dir> --src <dir> --out <dir>
//        [--sdk <wasi-sdk dir>] [--cc1] [--driver-link] [--jobs n]
//
//   --gen   the lifter's output folder (recomp_funcs.h)
//   --src   the generated .c files after tools.recomp.store_form (build.sh's
//           build-wasm/gen-src)
//   --out   gets obj/*.o and atv2.wasm
//   --cc1   compile with the kit's cc1 argument list (clang -cc1 ...) instead
//           of its driver arguments; --driver-link links through the clang
//           driver instead of the kit's wasm-ld argument list.
import { readFileSync, readdirSync, mkdirSync, existsSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME = resolve(HERE, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const need = (k) => opt(k) ?? (console.error(`missing ${k}; see the header of ${basename(fileURLToPath(import.meta.url))}`), process.exit(2));
const KIT = resolve(need('--kit')), GEN = resolve(need('--gen')), SRC = resolve(need('--src')), OUT = resolve(need('--out'));
const SDK = resolve(opt('--sdk') ?? ['..', '../../..'].map((up) => join(GAME, up, 'third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows'))
  .find((d) => existsSync(d)) ?? 'wasi-sdk');
const exe = (n) => join(SDK, 'bin', process.platform === 'win32' ? `${n}.exe` : n);
const jobs = Number(opt('--jobs', Math.min(8, availableParallelism())));
const flags = JSON.parse(readFileSync(join(KIT, 'flags.json'), 'utf8'));
const fwd = (p) => p.split('\\').join('/');

// ${NAME} -> value; ${OBJS} expands to one argument per object.
function expand(list, vars) {
  return list.flatMap((a) => (a === '${OBJS}' ? vars.OBJS : [a.replace(/\$\{(\w+)\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`no value for ${m}`);
    return vars[k];
  })]));
}
function run(cmd, argv) {
  return new Promise((ok, no) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? ok() : no(new Error(`${basename(cmd)} exit ${code}\n${err.slice(0, 2000)}`))));
  });
}

const objDir = join(OUT, 'obj');
rmSync(objDir, { recursive: true, force: true });
mkdirSync(objDir, { recursive: true });
const sources = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort();
// Largest first: the longest compile sets the wall time.
const queue = [...sources].sort((a, b) => statSync(join(SRC, b)).size - statSync(join(SRC, a)).size);
const t0 = Date.now();
const cc1 = args.includes('--cc1');
await Promise.all(Array.from({ length: jobs }, async () => {
  for (let f; (f = queue.shift());) {
    const vars = { PKG: fwd(KIT), GEN: fwd(GEN), SRC: fwd(join(SRC, f)), OBJ: fwd(join(objDir, f.replace(/\.c$/, '.o'))),
      SRC_NAME: f, CWD: fwd(process.cwd()) };
    await run(exe('clang'), cc1 ? expand(flags.compile.cc1, vars) : expand(flags.compile.driver, vars));
  }
}));
const t1 = Date.now();
console.log(`compiled ${sources.length} files (${cc1 ? 'cc1' : 'driver'} arguments, ${jobs} at a time) in ${((t1 - t0) / 1000).toFixed(1)} s`);

const wasm = join(OUT, 'atv2.wasm');
const objs = sources.map((f) => fwd(join(objDir, f.replace(/\.c$/, '.o'))));
const lvars = { PKG: fwd(KIT), OUT: fwd(wasm), OBJS: objs };
if (args.includes('--driver-link')) await run(exe('clang'), expand(flags.link.driver, lvars));
else await run(exe('wasm-ld'), expand(flags.link.wasmLd, lvars));
// The page needs no DWARF (build.sh strips it the same way).
execFileSync(exe('llvm-strip'), ['--strip-debug', wasm, '-o', `${wasm}.tmp`]);
renameSync(`${wasm}.tmp`, wasm);
// What the page creates the Memory from, as build.sh's wasm_memory_json writes it.
const m = flags.memory;
writeFileSync(join(OUT, 'atv2.memory.json'), `{ "initialPages": ${m.initialPages}, "maximumPages": ${m.maximumPages}, ` +
  `"globalBase": ${m.globalBase}, "stackSize": ${m.stackSize}, "shared": ${m.shared} }\n`);
console.log(`linked ${wasm} (${statSync(wasm).size} bytes) in ${((Date.now() - t1) / 1000).toFixed(2)} s`);
