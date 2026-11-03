// Free Ride in headless Edge: boot with RECOMP_FREERIDE=1 and measure it.
//
//   node web/tools/freeride.mjs [seconds=330] [--port n] [--profile dir] [--opfs] [--out dir]
//        [--env K=V,...] [--wasm url]
//
// Opens the page with ?env=RECOMP_SKIP_MOVIES=1,RECOMP_FREERIDE=1 (src/freeride.c
// walks the menus by itself), waits for "[FREERIDE] riding" in the page log and
// reports the time from opening the page. Then it rides for <seconds>: Z (= A,
// throttle) held, a steering tap every 20 s; per second the guest flips, every
// 20 s the race clock (0x1DA05C), the time limit (0x1D8660) and the game state.
// The clock must keep running with no results screen: unlimited time.
// Screenshots (the presented frame): <out>/freeride-riding.png at the start,
// freeride-end.png at the end. <out> defaults to build-wasm/freeride (outside
// git: frames are game-derived). The server binds 127.0.0.1 only.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const secs = Number(argv[0] && /^\d+$/.test(argv[0]) ? argv[0] : 330);
const out = resolve(opt('--out', join(ROOT, 'build-wasm/freeride')));
const env = ['RECOMP_SKIP_MOVIES=1', 'RECOMP_FREERIDE=1', opt('--env', '')].filter(Boolean).join(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const port = Number(opt('--port', 8600 + Math.floor(Math.random() * 300)));
const wasm = opt('--wasm');
const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  ...(argv.includes('--opfs') ? [] : ['--game', join(ROOT, 'game/atv2')])],
  { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const qs = new URLSearchParams();
qs.set('env', env);
if (wasm) qs.set('wasm', wasm);
const t0 = Date.now();
const b = await launch(`http://127.0.0.1:${port}/host/index.html?${qs}`, { profile: opt('--profile') });
const el = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
// Guest memory: linear address = guest VA + 0x10000 (WASM-MEM.md).
const peek = (va, t = 'u32') => b.eval(`(() => { const m = atv.presenter?.memory; if (!m) return null;
  const v = new DataView(m.buffer); const a = ${va} + 0x10000;
  return '${t}' === 'f32' ? v.getFloat32(a, true) : v.getUint32(a, true); })()`);
const chain = () => b.eval(`(() => { const m = atv.presenter?.memory; if (!m) return '';
  const v = new DataView(m.buffer); const r = (va) => va ? v.getUint32(va + 0x10000, true) : 0;
  const root = r(0x1D8608), mode = r(root + 0x18), sub = mode ? r(mode + 0x10) : r(root + 0x10);
  return (mode ? r(mode).toString(16) + '/' : '') + (sub ? r(sub).toString(16) : '-'); })()`);
const status = () => b.eval(`(() => ({ status: document.getElementById('status').textContent, exit: atv.state.exit,
  err: atv.state.error ?? null, flips: atv.presenter?.i32 ? atv.presenter.i32[atv.flipsIndex] : 0 }))()`);
const shot = async (name) => {
  const p = await b.eval('atv.snapshot()').catch(() => null);
  if (p) { writeFileSync(join(out, name), Buffer.from(p.split(',')[1], 'base64')); console.log(`${el()} ${join(out, name)}`); }
};
let result = 1;
try {
  await b.eval(`import('/host/abi.js').then((m) => { atv.flipsIndex = m.Host.at.flips; return 1; })`);
  // 1. boot until Free Ride says it is riding
  let seen = 0, riding = null;
  for (let i = 0; i < 2400 && riding === null; i++) {
    await sleep(250);
    const st = await status();
    if (st.exit !== null || st.err) throw new Error(`boot ended: ${st.err ?? st.exit}`);
    const lines = await b.eval(`atv.log.filter((l) => l.includes('[FREERIDE]'))`);
    for (; seen < lines.length; seen++) {
      console.log(`${el()} ${lines[seen]}`);
      if (lines[seen].includes('riding')) riding = (Date.now() - t0) / 1000;
      if (lines[seen].includes('gave up') || lines[seen].includes(': off')) throw new Error(lines[seen]);
    }
  }
  if (riding === null) throw new Error('no "[FREERIDE] riding" in 600 s');
  console.log(`${el()} riding ${riding.toFixed(1)} s after the page was opened`);
  await sleep(3000);
  await shot('freeride-riding.png');

  // 2. ride
  await b.eval('atv.key(90, 1)');
  let prev = await status();
  const fps = [];
  for (let s = 1; s <= secs; s++) {
    await sleep(1000);
    const st = await status();
    if (st.exit !== null || st.err) throw new Error(`ended: ${st.err ?? st.exit}`);
    fps.push(st.flips - prev.flips);
    prev = st;
    if (s % 20 === 0 || s === secs) {
      const vk = (s / 20) % 2 ? 37 : 39;
      await b.eval(`atv.key(${vk}, 1)`); setTimeout(() => b.eval(`atv.key(${vk}, 0)`).catch(() => {}), 600);
      const last = fps.slice(-20);
      console.log(`${el()} ride ${String(s).padStart(4)} s: race clock ${(await peek(0x1DA05C, 'f32')).toFixed(1)} s, ` +
        `limit ${await peek(0x1D8660, 'f32')} s, freestyle mode ${await peek(0x1D866C)}, state ${await chain()}, ` +
        `fps ${(last.reduce((a, x) => a + x, 0) / last.length).toFixed(1)} (min ${Math.min(...last)})`);
    }
  }
  await b.eval('atv.key(90, 0)');
  await shot('freeride-end.png');
  const f = [...fps].sort((x, y) => x - y);
  console.log(`RESULT riding after ${riding.toFixed(1)} s; rode ${secs} s, race clock ${(await peek(0x1DA05C, 'f32')).toFixed(1)} s, ` +
    `state ${await chain()}; fps avg ${(fps.reduce((a, x) => a + x, 0) / fps.length).toFixed(1)} min ${f[0]} median ${f[f.length >> 1]}`);
  result = 0;
} catch (e) {
  console.log(`${el()} FAILED: ${e.message}`);
  await shot('freeride-failed.png');
} finally {
  const logText = await b.eval('atv.log.join("\\n")').catch(() => '');
  writeFileSync(join(out, 'freeride.log'), logText + '\n');
  await b.close();
  srv.kill();
}
process.exit(result);
