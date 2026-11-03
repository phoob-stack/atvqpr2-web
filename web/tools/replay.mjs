// Replay frame captures with the WebGPU encoder in headless Edge and diff
// them against the D3D11 reference.
//
//   node web/tools/replay.mjs <captures dir> [frame ...]
//
// Writes <dir>/cap_<n>_webgpu.png (WebGPU | D3D11 | |diff| x4) and prints the
// numbers. Captures and PNGs are game-derived: keep them on this PC.
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, launch } from './cdp.mjs';

const dir = resolve(process.argv[2] ?? '.');
let frames = process.argv.slice(3);
if (!frames.length)
  frames = readdirSync(dir).map((f) => /^cap_(\d+)\.gpf$/.exec(f)?.[1]).filter(Boolean).sort((a, b) => a - b);
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srv = await serve({ '/': web, '/data/': dir });
let bad = 0;
for (const n of frames) {
  const b = await launch(`${srv.url}/replay.html`);   // a fresh device per capture
  try {
    const r = await b.eval(`replay('/data/cap_${n}')`);
    if (r.png) writeFileSync(join(dir, `cap_${n}_webgpu.png`), Buffer.from(r.png.split(',')[1], 'base64'));
    delete r.png;
    console.log(JSON.stringify(r));
    if (r.errorCount) bad++;
  } catch (e) {
    console.log(`cap_${n}: ${e.message}`); bad++;
  } finally {
    await b.close();
  }
}
srv.close();
process.exit(bad ? 1 : 0);
