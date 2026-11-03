// Split screen in the browser build: N players (1-4) into a multiplayer
// Dunes: Lagoon race, each on its own Xbox port, then fps per second.
//
//   node web/tools/mp.mjs <players 1-4> [seconds=30] [--keyboard] [--warm secs=6]
//        [--port n] [--profile dir] [--opfs] [--out dir] [--env K=V,...] [--wasm url]
//
// Fake Gamepad API pads replace navigator.getGamepads (standard mapping), one
// per player at index 0..N-1, so web/host/input.js maps them by index to Xbox
// ports 1..N and the emulated USB bus plugs a pad into each. --keyboard makes
// the last player the keyboard instead (Enter = Start, Z = A, arrows): it is
// then the first port without a gamepad and joins with its first key press.
//
// Route (save profile "A", as the native "mp" route in tools\atv-mcp):
// title -> Start -> SAVED PROFILES: A -> main menu: cursor to MULTIPLAYER, A
// -> MULTIPLAYER: SINGLE RACE, A -> join screen: every player Start, then A
// (rider), A (ATV) -> TRACK SELECT (player 1, Dunes: Lagoon) -> preview -> race.
// Screens are told apart by colour probes of the presented frame, as the
// native routes do; the race start is the race clock (guest 0x1DA05C, f32).
// Every player then holds A (throttle) and the guest flips are counted per
// second. Frames and logs go to <out> (default build-wasm/mp<N>: game-derived,
// outside git).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i && argv[i - 1].startsWith('--') &&
  !['--keyboard', '--opfs'].includes(argv[i - 1])));
const players = Number(pos[0] ?? 2), secs = Number(pos[1] ?? 30);
if (!(players >= 1 && players <= 4)) { console.log('players 1-4'); process.exit(2); }
const kbd = argv.includes('--keyboard');
const warm = Number(opt('--warm', 6));
const out = resolve(opt('--out', join(ROOT, `build-wasm/mp${players}${kbd ? 'k' : ''}`)));
const env = ['RECOMP_SKIP_MOVIES=1', opt('--env', '')].filter(Boolean).join(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const port = Number(opt('--port', 8832));
const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  ...(argv.includes('--opfs') ? [] : ['--game', join(ROOT, 'game/atv2')])], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const qs = new URLSearchParams();
qs.set('env', env);
if (opt('--wasm')) qs.set('wasm', opt('--wasm'));
const b = await launch(`http://127.0.0.1:${port}/host/index.html?${qs}`, { profile: opt('--profile') });
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const npads = kbd ? players - 1 : players;

// Page helpers: fake pads, a key/button press per port, colour probes of the
// presented frame, guest memory peeks.
await b.eval(`(async () => {
  const abi = await import('/host/abi.js');
  const mk = (n) => ({ id: 'mp.mjs fake pad ' + (n + 1) + ' (STANDARD GAMEPAD)', index: n, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) });
  const pads = [null, null, null, null];
  for (let n = 0; n < ${npads}; n++) pads[n] = mk(n);
  window.__pads = pads;
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => pads.slice() });
  // Standard-mapping indices and keyboard VKs for the buttons the route uses.
  const BTN = { a: 0, b: 1, x: 2, y: 3, start: 9, up: 12, down: 13, left: 14, right: 15 };
  const VK = { a: 0x5a, b: 0x58, x: 0x43, y: 0x56, start: 0x0d, up: 0x26, down: 0x28, left: 0x25, right: 0x27 };
  window.__btn = (port, name, v) => {
    const p = pads[port];
    if (p) { p.buttons[BTN[name]] = { pressed: !!v, touched: !!v, value: v ? 1 : 0 }; p.timestamp = performance.now(); }
    else atv.key(VK[name], v);
  };
  const mem = (await window.ready).memory;
  window.__peek = (va, t) => {
    const h = atv.presenter.i32, mo = h[abi.Host.at.mem_offset] >>> 0, dv = new DataView(mem.buffer);
    return t === 'f32' ? dv.getFloat32(mo + va, true) : dv.getUint32(mo + va, true);
  };
  window.__probe = async (rects) => {
    const png = await atv.presenter.snapshot();
    if (!png) return null;
    const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const sx = bmp.width / 640, sy = bmp.height / 480;
    return rects.map(([x, y, w, h]) => {
      const d = g.getImageData(Math.round(x * sx), Math.round(y * sy), Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy))).data;
      let r = 0, gg = 0, bb = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; bb += d[i + 2]; }
      const n = d.length / 4;
      return [r / n, gg / n, bb / n];
    });
  };
  return true;
})()`);

const RACE_TIME = 0x1DA05C, TRACK_INDEX = 0x1D8654;
const press = async (p, name, hold = 150, gap = 300) => {
  await b.eval(`__btn(${p}, '${name}', 1)`); await sleep(hold);
  await b.eval(`__btn(${p}, '${name}', 0)`); await sleep(gap);
};
const all = async (name) => {
  for (let p = 0; p < players; p++) await b.eval(`__btn(${p}, '${name}', 1)`);
  await sleep(150);
  for (let p = 0; p < players; p++) await b.eval(`__btn(${p}, '${name}', 0)`);
  await sleep(300);
};
const peek = (va, t = 'u32') => b.eval(`__peek(${va}, '${t}')`);
const orange = (v) => v[0] - v[2] > 25 && v[0] > 90;
// tools\atv-mcp\routes.py screen(), on the browser's frame.
async function screen() {
  const v = await b.eval(`__probe([[180,404,24,22],[308,404,24,22],[436,404,24,22],[565,404,24,22],[230,415,180,18],[530,190,30,110]])`);
  if (!v) return 'none';
  const [xi, ai, yi, bi, ps, air] = v;
  const blue = (c) => c[2] > 105 && c[0] < 45, green = (c) => c[1] > 100 && c[0] < 45;
  const yellow = (c) => c[0] > 120 && c[1] > 90 && c[2] < 45, red = (c) => c[0] > 100 && c[1] < 40;
  const black = (c) => Math.max(...c) < 40;
  if (!green(ai)) {
    if (ps[0] - ps[2] > 25 && ps[0] > 120) return 'title';
    return (await peek(RACE_TIME, 'f32')) > 0 ? 'race' : 'unknown';
  }
  if (black(yi)) return 'pause_menu';
  if (blue(xi)) return yellow(yi) ? 'track_select' : 'profiles';
  if (yellow(yi)) return 'rider_select';
  if (!red(bi)) return 'preview';
  if (air[2] < 130 && air[1] > 120) return 'atv_select';
  return 'main_menu';
}
const rowOrange = async (y) => orange((await b.eval(`__probe([[215,${y},210,20]])`))[0]);
// The main menu: the legend says so and one of its ten rows is highlighted
// (orange, not the yellow of SAVED PROFILES' "EMPTY PROFILE").
async function mainMenu() {
  if ((await screen()) !== 'main_menu') return false;
  const rows = await b.eval(`__probe([${Array.from({ length: 10 }, (_, k) => `[215,${93 + 31 * k},210,20]`).join(',')}])`);
  return rows.some((v) => orange(v) && v[0] - v[1] > 15);
}
const waitScreen = async (want, ms) => {
  let s;
  for (const end = Date.now() + ms; Date.now() < end;) { s = await screen(); if (want.includes(s)) return s; await sleep(250); }
  return s;
};
const status = () => b.eval(`(() => { const h = atv.presenter?.i32, s = atv.presenter?.stats ?? {};
  return { status: document.getElementById('status').textContent, exit: atv.state.exit, err: atv.state.error ?? null,
    draws: s.lastDraws ?? 0, frames: s.frames ?? 0, flips: h ? h[atv.flipsIndex] : 0 }; })()`);
const shot = async (name) => {
  const p = await b.eval('atv.snapshot()').catch(() => null);
  if (p) writeFileSync(join(out, `${name}.png`), Buffer.from(p.split(',')[1], 'base64'));
};

let result = 1;
try {
  await b.eval(`import('/host/abi.js').then((m) => { atv.flipsIndex = m.Host.at.flips; return 1; })`);
  // 1. the title
  let s = null;
  for (let i = 0; i < 150 && s !== 'title'; i++) {
    await sleep(1000);
    const st = await status();
    if (st.exit !== null || st.err) throw new Error(`boot ended: ${st.err ?? st.exit}`);
    if (st.status.includes('draws 18,')) s = await screen();
  }
  if (s !== 'title') throw new Error('no title screen');
  console.log(`${el()} title; ${(await status()).status.split('|').pop().trim()}`);
  // 2. title -> profiles -> main menu
  // (a fresh browser profile has no save: A creates one, A picks the rider,
  // A on OK names it)
  let mm = false;
  for (let i = 0; i < 20 && !(mm = await mainMenu()); i++) {
    s = await screen();
    await press(0, s === 'title' ? 'start' : 'a');
    for (let k = 0; k < 12 && !(mm = await mainMenu()); k++) await sleep(400);
    if (mm) break;
  }
  if (!mm) throw new Error(`lost at ${await screen()} before the main menu`);
  // 3. MULTIPLAYER -> SINGLE RACE
  for (let i = 0; i < 12 && !(await rowOrange(340)); i++) { await press(0, 'down'); await sleep(200); }
  if (!(await rowOrange(340))) throw new Error('could not reach MULTIPLAYER');
  await press(0, 'a');
  let ok = false;
  for (let i = 0; i < 16 && !(ok = await rowOrange(162)); i++) await sleep(250);
  if (!ok) throw new Error('multiplayer menu: SINGLE RACE not highlighted');
  await sleep(500);
  await press(0, 'a');
  await sleep(2000);
  await shot('join');
  console.log(`${el()} join screen; ${(await status()).status.split('|').pop().trim()}`);
  // 4. join: Start, then A until TRACK SELECT
  for (let i = 0; i < 7; i++) {
    if (i && (await waitScreen(['track_select'], 100)) === 'track_select') break;
    await all(i === 0 ? 'start' : 'a');
    await sleep(2200);
    if (i === 0) await shot('joined');
  }
  if ((await waitScreen(['track_select'], 8000)) !== 'track_select') throw new Error('no TRACK SELECT after joining');
  for (let i = 0; i < 20 && (await peek(TRACK_INDEX)) !== 0; i++) { await press(0, 'right'); await sleep(400); }
  await press(0, 'a');
  if ((await waitScreen(['preview'], 10000)) !== 'preview') throw new Error('no preview');
  await press(0, 'a');
  let rt = 0;
  for (let i = 0; i < 160 && !(rt > 0); i++) { await sleep(250); rt = await peek(RACE_TIME, 'f32'); }
  if (!(rt > 0)) throw new Error('race clock did not start');
  console.log(`${el()} ${players}-player race started`);
  for (let p = 0; p < players; p++) await b.eval(`__btn(${p}, 'a', 1)`);
  await sleep(warm * 1000);
  await shot('race');
  // 5. fps per second
  let prev = await status();
  const rows = [];
  for (let i = 0; i < secs; i++) {
    await sleep(1000);
    const st = await status();
    rows.push({ flips: st.flips - prev.flips, frames: st.frames - prev.frames, draws: st.draws });
    console.log(`${el()} flips ${String(st.flips - prev.flips).padStart(3)}/s  page frames ${String(st.frames - prev.frames).padStart(3)}  draws ${st.draws}`);
    prev = st;
    if (st.exit !== null || st.err) break;
  }
  const f = rows.map((r) => r.flips).sort((x, y) => x - y);
  const avg = f.reduce((a, x) => a + x, 0) / Math.max(1, f.length);
  console.log(`RESULT ${players} players${kbd ? ' (last on the keyboard)' : ''}: fps avg ${avg.toFixed(1)} min ${f[0]} ` +
    `median ${f[f.length >> 1]} max ${f[f.length - 1]} over ${f.length} s; draws avg ` +
    `${(rows.reduce((a, r) => a + r.draws, 0) / Math.max(1, rows.length)).toFixed(0)}`);
  console.log(`status: ${(await status()).status}`);
  await shot('race-end');
  result = 0;
} catch (e) {
  console.log(`${el()} FAILED: ${e.message}`);
  await shot('failed');
} finally {
  const logText = await b.eval('atv.log.join("\\n")').catch(() => '');
  writeFileSync(join(out, 'mp.log'), logText + '\n');
  await b.close();
  srv.kill();
}
process.exit(result);
