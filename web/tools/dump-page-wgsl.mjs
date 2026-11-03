// Every WGSL module the page creates during a run (the game's generated
// shaders as the browser gets them), written to a folder for
// web/tools/naga-check.mjs (Firefox's WGSL front end) or validate-wgsl.mjs.
//
//   node web/tools/dump-page-wgsl.mjs --profile <dir with the game imported> [--port 8835] [--secs 90] [--out dir] [--race]
//
// Wraps GPUDevice.prototype.createShaderModule before the page runs; boots
// from OPFS and stays at the title for --secs, or with --race drives into a
// Dunes: Lagoon race (race.mjs's route) and races for --secs. The modules are game-derived:
// the default --out is build-wasm/page-wgsl (outside git).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('--port', 8835)), secs = Number(opt('--secs', 90));
const out = resolve(opt('--out', join(ROOT, 'build-wasm/page-wgsl')));
mkdirSync(out, { recursive: true });
const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve.log')],
  { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const origin = `http://127.0.0.1:${port}`;
const b = await launch(`${origin}/host/blank-for-wgsl-dump`, { profile: opt('--profile'), port: 9800 + port % 100, waitReady: false });
try {
  await b.send('Page.enable');
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `{
    const f = GPUDevice.prototype.createShaderModule; window.__wgsl = new Map();
    GPUDevice.prototype.createShaderModule = function (d) { if (d && typeof d.code === 'string') window.__wgsl.set(d.code, d.label || ''); return f.call(this, d); }; }` });
  await b.send('Page.navigate', { url: `${origin}/host/index.html?env=RECOMP_SKIP_MOVIES=1` });
  if (argv.includes('--race')) {
    // race.mjs's route: seconds after the title -> [VK, hold ms (0 = keep down)].
    const ROUTE = [[3, 13], [8, 90], [13, 90], [18, 90], [23, 40], [24, 40], [28, 90], [32, 90], [36, 90], [40, 90], [44, 90, 0]];
    let base = null;
    for (let i = 0; i < 240 && base === null; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await b.eval(`document.getElementById('status')?.textContent ?? ''`).catch(() => '');
      if (st.includes('draws 18,')) base = Date.now();
    }
    if (base === null) throw new Error('no title');
    for (const [at, vk, hold] of ROUTE) {
      const w = base + at * 1000 - Date.now();
      if (w > 0) await new Promise((r) => setTimeout(r, w));
      await b.eval(`atv.key(${vk}, 1)`);
      if (hold !== 0) setTimeout(() => b.eval(`atv.key(${vk}, 0)`).catch(() => {}), hold ?? 150);
    }
    console.log('route done; racing');
  }
  for (let s = 0; s < secs; s += 5) {
    await new Promise((r) => setTimeout(r, 5000));
    const n = await b.eval('window.__wgsl ? window.__wgsl.size : 0').catch(() => 0);
    console.log(`${s + 5}s: ${n} modules`);
  }
  const mods = await b.eval('[...window.__wgsl.entries()]');
  for (const [code, label] of mods) {
    const kind = /@vertex/.test(code) ? 'vs' : /@fragment/.test(code) ? 'ps' : 'cs';
    writeFileSync(join(out, `${kind}_${createHash('sha1').update(code).digest('hex').slice(0, 10)}.wgsl`), code);
  }
  console.log(`${mods.length} modules -> ${out}`);
} finally {
  await b.closeGracefully();
  srv.kill();
}
