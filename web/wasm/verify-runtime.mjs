#!/usr/bin/env node
// verify-runtime.mjs - check that a runtime kit (web/wasm/package-runtime.sh)
// holds nothing taken or generated from the game, before it goes anywhere.
//
//   node web/wasm/verify-runtime.mjs <kit folder> [--sdk <wasi-sdk dir>] [--xbe <default.xbe>] [--json]
//
// Exit 0 = clean, 1 = problems (listed), 2 = usage error.
//
//  1. rt.a: every member is built from one of our runtime sources (a .c of
//     the same name under atvrecomp/src or xboxrecomp/src, never under
//     src/recomp), and none is named like the lifter's output.
//  2. rt.a defines no lifted function (sub_XXXXXXXX) and none of the names the
//     generated code defines (recomp_lookup & co., xbe_entry_point): llvm-nm.
//  3. No generated header: nothing named like the lifter's output
//     (recomp_funcs.h, recomp_NNNN.c ...); include/ is exactly recomp_types.h
//     and wasm_compat.h, byte-identical (line endings aside) to xboxrecomp's
//     templates/runtime and atvrecomp's src/web copies; with --sdk, every file
//     under sysroot/ and clang/ is byte-identical to wasi-sdk's.
//  4. No game strings: no XBE magic, none of the banners the lifter writes into
//     generated C, no lifted-function definitions; with --xbe, every printable
//     string of 16+ characters that the kit's own files share with the XBE
//     must appear verbatim in our committed sources (an identity check such as
//     freeride.c's "ID_MAINMENU_OPEN_FS" is ours, as published).
//  5. Sizes: rt.a under 16 MB, libc.a under 4 MB, any other file under 1 MB,
//     the kit under 24 MB and 100 files; no links.
//  6. manifest.json lists every other file, with matching size and SHA-256.
import { readFileSync, readdirSync, lstatSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME = resolve(HERE, '../..');
const RT = resolve(GAME, '../xboxrecomp');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const kit = args.find((a, i) => !a.startsWith('--') && !['--sdk', '--xbe'].includes(args[i - 1]));
if (!kit || !existsSync(kit) || !statSync(kit).isDirectory()) { console.error('usage: verify-runtime.mjs <kit folder> [--sdk dir] [--xbe file]'); process.exit(2); }
const KIT = resolve(kit);
// Default SDK as build.sh finds it: atv2-web\third_party, from the main copy
// or a worker worktree (atv2-web\work\<name>\atvrecomp).
const SDK = resolve(opt('--sdk') ?? ['..', '../../..'].map((up) => join(GAME, up, 'third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows'))
  .find((d) => existsSync(d)) ?? 'wasi-sdk');
const XBE = opt('--xbe');

const problems = [];
const fail = (file, why) => problems.push({ file, why });
const posix = (p) => p.split(sep).join('/');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { fail(posix(relative(KIT, p)), 'link'); continue; }
    if (st.isDirectory()) walk(p, out); else out.push({ abs: p, rel: posix(relative(KIT, p)), size: st.size });
  }
  return out;
}
const files = walk(KIT);
const byRel = new Map(files.map((f) => [f.rel, f]));

// --- 1 and 2: rt.a
const GEN_FILE = /^(recomp_\d{4}|recomp_dispatch|recomp_stubs_unresolved|recomp_funcs)\.(c|h|o)$/i;
const GEN_SYMBOL = /^(sub_[0-9A-Fa-f]{8}|xbe_entry_point|recomp_(lookup|call_all|dispatch_init|dispatch_flat_bytes|get_count))$/;
const tool = (name) => join(SDK, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
const rta = join(KIT, 'lib', 'rt.a');
if (!existsSync(rta)) fail('lib/rt.a', 'missing');
else {
  const sources = new Map();
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!(e.name === 'recomp' && dir === join(GAME, 'src'))) scan(p); }
      else if (e.name.endsWith('.c')) sources.set(e.name.slice(0, -2), (sources.get(e.name.slice(0, -2)) ?? []).concat(p));
    }
  };
  scan(join(GAME, 'src')); scan(join(RT, 'src'));
  const members = execFileSync(tool('llvm-ar'), ['t', rta], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  for (const m of members) {
    if (GEN_FILE.test(m)) fail(`lib/rt.a(${m})`, 'member named like lifter output');
    else if (!m.endsWith('.o') || !sources.has(m.slice(0, -2))) fail(`lib/rt.a(${m})`, 'no runtime source of that name (atvrecomp/src, xboxrecomp/src)');
  }
  const nm = execFileSync(tool('llvm-nm'), ['--defined-only', '--format=just-symbols', rta],
    { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });   // ("no symbols" for empty members)
  const bad = [...new Set(nm.split(/\r?\n/).filter((s) => GEN_SYMBOL.test(s)))];
  if (bad.length) fail('lib/rt.a', `defines ${bad.length} generated symbol(s): ${bad.slice(0, 5).join(' ')}`);
  console.log(`rt.a: ${members.length} members, all from runtime sources; ${bad.length} generated symbols defined`);
}

// --- 3: headers
for (const f of files) if (GEN_FILE.test(basename(f.rel))) fail(f.rel, 'named like lifter output');
const lf = (p) => readFileSync(p, 'latin1').replace(/\r\n/g, '\n');
const inc = files.filter((f) => f.rel.startsWith('include/')).map((f) => f.rel).sort();
if (inc.join() !== 'include/recomp_types.h,include/wasm_compat.h') fail('include/', `expected recomp_types.h and wasm_compat.h, found ${inc.join(' ')}`);
const same = (rel, src) => byRel.has(rel) && lf(join(KIT, rel)) === lf(src);
if (!same('include/recomp_types.h', join(RT, 'templates/runtime/recomp_types.h'))) fail('include/recomp_types.h', 'differs from xboxrecomp templates/runtime/recomp_types.h');
if (!same('include/wasm_compat.h', join(GAME, 'src/web/wasm_compat.h'))) fail('include/wasm_compat.h', 'differs from atvrecomp src/web/wasm_compat.h');
let sdkChecked = 0;
if (existsSync(SDK)) {
  const resource = join(SDK, 'lib', 'clang', readdirSync(join(SDK, 'lib', 'clang'))[0]);
  for (const f of files) {
    let src = null;
    if (f.rel.startsWith('sysroot/')) src = join(SDK, 'share', 'wasi-sysroot', f.rel.slice(8));
    else if (f.rel.startsWith('clang/')) src = join(resource, f.rel.slice(6));
    else continue;
    if (!existsSync(src) || !readFileSync(src).equals(readFileSync(f.abs))) fail(f.rel, 'not byte-identical to wasi-sdk\'s file');
    sdkChecked++;
  }
  console.log(`sysroot/, clang/: ${sdkChecked} files compared with ${SDK}`);
} else console.log('(no wasi-sdk: sysroot/ and clang/ not compared)');

// --- 4: game strings
const MARKERS = [
  [/ - Recompiled code chunk \d+/, 'lifter chunk banner'],
  [/ - Recompiled Function (Dispatch Table|Declarations)/, 'lifter table banner'],
  [/Maps \d+ Xbox VAs to translated function pointers/, 'lifter dispatch banner'],
  [/ \* Original: 0x[0-9A-Fa-f]{8} - 0x[0-9A-Fa-f]{8} \(\d+ bytes, \d+ insns\)/, 'lifted-function header comment'],
  [/void sub_[0-9A-Fa-f]{8}\(void\)\s*\{/, 'lifted-function definition'],
];
const own = files.filter((f) => !f.rel.startsWith('sysroot/') && !f.rel.startsWith('clang/'));
for (const f of files) {
  const buf = readFileSync(f.abs);
  if (buf.subarray(0, 4).toString('latin1') === 'XBEH' || buf.includes(Buffer.from('XBEH\0'))) fail(f.rel, 'XBE magic');
  if (f.rel.startsWith('sysroot/') || f.rel.startsWith('clang/')) continue;
  const text = buf.toString('latin1');
  for (const [re, what] of MARKERS) if (re.test(text)) fail(f.rel, `contains ${what}`);
}
if (XBE) {
  const xbe = readFileSync(XBE).toString('latin1');
  const strs = new Set(xbe.match(/[\x20-\x7e]{16,}/g) ?? []);
  // Our committed sources, as text: a shared string found there is ours.
  const srcText = [];
  const read = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!(e.name === 'recomp' && dir === join(GAME, 'src'))) read(p); }
      else if (/\.(c|h|inc)$/.test(e.name)) srcText.push(readFileSync(p, 'latin1'));
    }
  };
  read(join(GAME, 'src')); read(join(RT, 'src')); read(join(RT, 'include')); read(join(RT, 'templates', 'runtime'));
  const ours = srcText.join('\n');
  let shared = 0;
  for (const f of own) {
    const text = readFileSync(f.abs).toString('latin1');
    for (const s of strs) {
      if (!text.includes(s)) continue;
      shared++;
      if (!ours.includes(s)) fail(f.rel, `shares a string with the XBE that is not in our sources: ${JSON.stringify(s.slice(0, 60))}`);
    }
  }
  console.log(`XBE strings (16+ chars): ${strs.size}; shared with the kit's own files: ${shared} (each must be in our sources)`);
}

// --- 5: sizes
const MB = 2 ** 20;
const cap = (rel) => rel === 'lib/rt.a' ? 16 * MB : basename(rel) === 'libc.a' ? 4 * MB : 1 * MB;
let total = 0;
for (const f of files) { total += f.size; if (f.size > cap(f.rel)) fail(f.rel, `${f.size} bytes, over ${cap(f.rel) / MB} MB`); }
if (total > 24 * MB) fail('.', `kit is ${(total / MB).toFixed(1)} MB, over 24 MB`);
if (files.length > 100) fail('.', `${files.length} files, over 100`);

// --- 6: manifest
const manPath = join(KIT, 'manifest.json');
if (!existsSync(manPath)) fail('manifest.json', 'missing');
else {
  const man = JSON.parse(readFileSync(manPath, 'utf8'));
  const listed = new Map(man.files.map((f) => [f.path, f]));
  for (const f of files) {
    if (f.rel === 'manifest.json') continue;
    const m = listed.get(f.rel);
    if (!m) fail(f.rel, 'not in manifest.json');
    else if (m.size !== f.size || m.sha256 !== createHash('sha256').update(readFileSync(f.abs)).digest('hex')) fail(f.rel, 'size or SHA-256 differs from manifest.json');
  }
  for (const p of listed.keys()) if (!byRel.has(p)) fail(p, 'in manifest.json but missing');
}

const ok = problems.length === 0;
if (args.includes('--json')) console.log(JSON.stringify({ ok, kit: KIT, files: files.length, bytes: total, problems }, null, 2));
else {
  for (const p of problems) console.log(`FAIL  ${p.file}: ${p.why}`);
  console.log(`${ok ? 'OK' : 'FAILED'}: ${KIT}: ${files.length} files, ${(total / MB).toFixed(2)} MB, ${problems.length} problem(s)`);
}
process.exit(ok ? 0 : 1);
