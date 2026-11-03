// Boot the browser build in headless Edge and report how far it gets.
//
//   node web/tools/boot.mjs [seconds=60] [--env K=V,K=V] [--keys 20:13,25:90:3000] [--shots 30,60] [--out dir]
//        [--anchor <status text>] [--pad 20:9,25:0:3000] [--until <log text>]
//        [--game <folder>] [--wasm <url>] [--args a,b] [--overlay <dir>] [--audio]
//
// Starts web/host/serve.mjs (127.0.0.1, a free port), opens the page, polls
// the boot stage and the status line, presses keys at the given seconds
// (sec:VK), and at the end writes <out>/boot.log (the page log) and
// <out>/boot.png (the displayed frame, if any). <out> defaults to build-wasm/
// (outside git: frames are game-derived).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const secs = Number(argv[0] && /^\d+$/.test(argv[0]) ? argv[0] : 60);
const out = resolve(opt('--out', join(ROOT, 'build-wasm')));
const env = opt('--env', '');
// --keys sec:vk[:holdms],...   --shots sec,sec,...  (snapshots of the presented frame)
const keys = (opt('--keys', '') || '').split(',').filter(Boolean).map((s) => s.split(':').map(Number));
const shots = (opt('--shots', '') || '').split(',').filter(Boolean).map(Number);
// --anchor TEXT: key and shot times count from the first second whose status
// line contains TEXT (e.g. 'draws 18,' = the title screen), and the run lasts
// <seconds> past it (giving up 300 s in if it never shows). Boot time varies by
// several seconds run to run; menu scripts need a fixed point.
const anchor = opt('--anchor');
// --pad sec:button[:holdms],...  a fake Gamepad API pad (standard mapping:
// 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 Back, 9 Start, 12-15 d-pad
// up/down/left/right) replaces navigator.getGamepads, so input.js's pad path
// runs as with a real one. Same clock as --keys.
// --until TEXT: stop as soon as the page log has a line containing TEXT
// (e.g. 'periodic slot' for a USB bring-up check).
const until = opt('--until');
const padPresses = (opt('--pad', '') || '').split(',').filter(Boolean).map((s) => s.split(':').map(Number));
let base = anchor ? null : 0;
mkdirSync(out, { recursive: true });

const port = 8600 + Math.floor(Math.random() * 300);
const game = opt('--game'), wasm = opt('--wasm'), args = opt('--args'), overlay = opt('--overlay');
const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  ...(game ? ['--game', game] : []), ...(overlay ? ['--overlay', overlay] : [])],
  { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const qs = new URLSearchParams();
if (env) qs.set('env', env);
if (wasm) qs.set('wasm', wasm);
if (args) qs.set('args', args);
const url = `http://127.0.0.1:${port}/host/index.html${qs.size ? `?${qs}` : ''}`;
const b = await launch(url);
const t0 = Date.now();
let last = '', snap = null;
try {
  if (padPresses.length) {
    await b.eval(`(() => {
      const p = { id: 'boot.mjs fake pad (standard)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
        axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
      window.__fakePad = p;
      window.__padSet = (k, v) => { p.buttons[k] = { pressed: !!v, touched: !!v, value: v ? 1 : 0 }; p.timestamp = performance.now(); };
      Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [p, null, null, null] });
      return true; })()`);
  }
  for (let s = 0; base === null ? s < 300 : s < base + secs; s++) {
    await new Promise((r) => setTimeout(r, 1000));
    const rel = base === null ? -1 : s - base;
    for (const [at, vk, hold] of keys) {
      if (at === rel) { await b.eval(`atv.key(${vk}, 1)`); setTimeout(() => b.eval(`atv.key(${vk}, 0)`).catch(() => {}), hold || 150); }
    }
    for (const [at, k, hold] of padPresses) {
      if (at === rel) { await b.eval(`__padSet(${k}, 1)`); setTimeout(() => b.eval(`__padSet(${k}, 0)`).catch(() => {}), hold || 150); }
    }
    if (base !== null && shots.includes(rel + 1)) {
      const p = await b.eval('atv.snapshot()').catch(() => null);
      if (p) { writeFileSync(join(out, `shot-${rel + 1}.png`), Buffer.from(p.split(',')[1], 'base64')); console.log(`${String(s + 1).padStart(4)}s shot-${rel + 1}.png`); }
    }
    if (s === 1 && argv.includes('--audio')) console.log(`audio: ${await b.eval('atv.startAudio().then(() => atv.state.audio, (e) => String(e))')}`);
    const st = await b.eval(`({ status: document.getElementById('status').textContent, exit: atv.state.exit, err: atv.state.error ?? null })`);
    if (st.status !== last) { console.log(`${String(s + 1).padStart(4)}s ${st.status}`); last = st.status; }
    if (base === null && st.status.includes(anchor)) { base = s + 1; console.log(`${String(s + 1).padStart(4)}s anchor "${anchor}": key and shot times count from here`); }
    if (st.exit !== null || st.err) break;
    if (until && await b.eval(`atv.log.some((l) => l.includes(${JSON.stringify(until)}))`)) { console.log(`${String(s + 1).padStart(4)}s found "${until}"`); break; }
  }
  snap = await b.eval('atv.snapshot()').catch((e) => { console.log(`snapshot: ${e.message}`); return null; });
  const logText = await b.eval('atv.log.join("\\n")');
  writeFileSync(join(out, 'boot.log'), logText + '\n');
  if (snap) writeFileSync(join(out, 'boot.png'), Buffer.from(snap.split(',')[1], 'base64'));
  const lines = logText.split('\n');
  console.log(`--- last 40 of ${lines.length} log lines (all in ${join(out, 'boot.log')}):`);
  console.log(lines.slice(-40).join('\n'));
  console.log(snap ? `frame: ${join(out, 'boot.png')}` : 'no frame to show');
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
} finally {
  await b.close();
  srv.kill();
}
