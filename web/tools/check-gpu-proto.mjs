// Compare web/gpu/proto.js with the C structs (nfsu2-web's check-gpu-proto):
// generate a C probe printing every offset/size proto.js knows, compile it
// with MSVC (vcvars64), run it, diff. Exit 1 on any mismatch.
//
//   node web/tools/check-gpu-proto.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeTable } from '../gpu/proto.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vcvars = process.env.VCVARS ??
  'C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat';
const table = probeTable();
const dir = mkdtempSync(join(tmpdir(), 'gpu-proto-'));

let c = '#include <stdio.h>\n#include <stddef.h>\n#include "gpu_shadergen_wgsl.h"\nint main(void) {\n';
for (const k of Object.keys(table)) {
  let expr;
  if (k.startsWith('sizeof(')) expr = k;
  else if (!k.includes('.')) expr = k;              // a constant
  else { const [s, f] = k.split('.'); expr = `offsetof(${s}, ${f})`; }
  c += `  printf("%s %u\\n", "${k}", (unsigned)(${expr}));\n`;
}
c += '  return 0;\n}\n';
writeFileSync(join(dir, 'probe.c'), c);
// vcvars may change the directory: go back to the probe's folder after it.
writeFileSync(join(dir, 'build.bat'), [
  '@echo off', `call "${vcvars}" >nul`, 'cd /d "%~dp0"',
  `cl /nologo /std:c11 /W3 /I "${join(root, 'src/gpu')}" probe.c /Fe:probe.exe >build.log || (type build.log & exit /b 1)`,
  ''].join('\r\n'));
execSync(`cmd /c "${join(dir, 'build.bat')}"`, { cwd: dir, stdio: 'inherit' });
const out = execSync(join(dir, 'probe.exe'), { encoding: 'utf8' });

let bad = 0, n = 0;
for (const line of out.trim().split(/\r?\n/)) {
  const [k, v] = line.split(' ');
  n++;
  if ((table[k] >>> 0) !== (Number(v) >>> 0)) { bad++; console.log(`MISMATCH ${k}: C ${v}, JS ${table[k]}`); }
}
console.log(`${n} offsets/sizes compared, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
