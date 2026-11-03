// WGSL through naga (Firefox's WGSL front end) on this PC: builds
// web/tools/naga_check.c with MSVC against third_party/wgpu-native and runs
// it on every .wgsl in the given folders, plus the WGSL inlined in the
// page's own JS (present.js's blit). See naga_check.c.
//
//   node web/tools/naga-check.mjs <folder|file.wgsl>... [--wgpu <wgpu-native dir>]
//
// Shader dumps from game runs are game-derived: keep them under build-wasm/.
import { execSync, spawnSync } from 'node:child_process';
import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const wgpu = resolve(opt('--wgpu', [join(ROOT, '../third_party/wgpu-native/v29.0.1.1'),
  join(ROOT, '../../../third_party/wgpu-native/v29.0.1.1')].find(existsSync) ?? ''));
const vcvars = process.env.VCVARS ?? 'C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat';
const dir = join(ROOT, 'build-wasm/naga-check');
mkdirSync(dir, { recursive: true });

// Inline WGSL of the page (template literals named *_WGSL).
const inline = join(dir, 'inline');
mkdirSync(inline, { recursive: true });
for (const f of ['web/host/present.js', 'web/gpu/encoder.js']) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/const (\w+_WGSL) = `([^`]*)`/g)) writeFileSync(join(inline, `${m[1]}.wgsl`), m[2]);
}

writeFileSync(join(dir, 'build.bat'), ['@echo off', `call "${vcvars}" >nul`, 'cd /d "%~dp0"',
  `cl /nologo /O1 /W3 /I "${join(wgpu, 'include')}" "${join(ROOT, 'web/tools/naga_check.c')}" "${join(wgpu, 'lib/wgpu_native.dll.lib')}" /Fe:naga_check.exe >build.log || (type build.log & exit /b 1)`,
].join('\r\n'));
execSync(`cmd /c "${join(dir, 'build.bat')}"`, { cwd: dir, stdio: 'inherit' });
copyFileSync(join(wgpu, 'lib/wgpu_native.dll'), join(dir, 'wgpu_native.dll'));

const files = [];
const add = (p) => {
  if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) { if (e.endsWith('.wgsl')) files.push(join(p, e)); }
  else files.push(p);
};
for (const a of argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--wgpu')) add(resolve(a));
add(inline);
// Windows' command line is ~32k characters: batches.
let rc = 0;
for (let i = 0; i < files.length; i += 150) {
  const r = spawnSync(join(dir, 'naga_check.exe'), files.slice(i, i + 150), { encoding: 'utf8', cwd: dir });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  if (r.status) rc = r.status;
}
process.exit(rc);
