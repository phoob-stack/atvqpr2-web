// The native control channel's line protocol (src/control/control.c), served by
// Node for the browser build: boots the page in headless Edge (as boot.mjs) and
// answers the subset of commands the scripted routes use, so
// tools\atv-mcp\routes.py (and the coverage runner) drive the browser build
// unchanged: `atvctl.py --port <ctl> route race dunes_lagoon`.
//
//   node web/tools/ctlbridge.mjs --ctl <port> [--port n] [--profile dir] [--opfs]
//        [--env K=V,...] [--qs a=b&c=d] [--out dir] [--movies] [--wasm url] [--headed]
//
// Commands: ping info frame fps press hold release clear wait(ms|frames|input|
// mem|value|fps|draws) peek read color screenshot state log quit. Input goes
// through a fake standard-mapping Gamepad (navigator.getGamepads, as boot.mjs
// --pad), so the page's own pad path runs: buttons, triggers and sticks.
// Guest memory is the page's wasm memory at guest VA + 0x10000 (wasm-mem).
// Colour probes and screenshots read the presenter's source texture, the
// frame the page shows (no screen capture). 127.0.0.1 only.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ctlPort = Number(opt('--ctl', 0));
const port = Number(opt('--port', 8600 + Math.floor(Math.random() * 300)));
const out = resolve(opt('--out', join(ROOT, 'build-wasm/ctl')));
const env = [argv.includes('--movies') ? '' : 'RECOMP_SKIP_MOVIES=1', opt('--env', '')].filter(Boolean).join(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
const MEM_OFS = 0x10000;

const opfs = argv.includes('--opfs');
const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  ...(opfs ? [] : ['--game', opt('--game', join(ROOT, 'game/atv2'))])], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const qs = new URLSearchParams();
if (env) qs.set('env', env);
if (opt('--wasm')) qs.set('wasm', opt('--wasm'));
for (const [k, v] of new URLSearchParams(opt('--qs', ''))) qs.set(k, v);   // --qs 'roam=wss://..&roam_name=..': more page parameters
const b = await launch(`http://127.0.0.1:${port}/host/index.html?${qs}`, { profile: opt('--profile'), headless: !argv.includes('--headed') });
const t0 = Date.now();

// Page helpers: the fake pad, guest memory views, frame pixels.
await b.eval(`(() => {
  const p = { id: 'ctlbridge fake pad (standard)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  window.__pad = p;
  window.__padState = (btns, axes) => {
    for (let k = 0; k < 17; k++) { const v = btns[k] || 0; p.buttons[k] = { pressed: v > 0, touched: v > 0, value: v }; }
    p.axes = axes; p.timestamp = performance.now();
  };
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [p, null, null, null] });
  window.__mem = null;
  window.ready.then((r) => { window.__mem = r?.memory ?? null; });
  window.__flipsIdx = null;
  import('/host/abi.js').then((m) => { window.__flipsIdx = m.Host.at.flips; });
  window.__flips = () => { const pr = atv.presenter; return pr && window.__flipsIdx !== null ? pr.i32[window.__flipsIdx] : 0; };
  window.__peek = (va, t, n) => {
    if (!window.__mem) return null;
    const dv = new DataView(window.__mem.buffer), out = [], sz = { b: 1, h: 2, w: 4, B: 1, H: 2, W: 4, f: 4 }[t];
    for (let i = 0; i < n; i++) {
      const a = va + MEM_OFS_ + i * sz;
      out.push(t === 'b' ? dv.getUint8(a) : t === 'h' ? dv.getUint16(a, true) : t === 'w' ? dv.getUint32(a, true) :
        t === 'B' ? dv.getInt8(a) : t === 'H' ? dv.getInt16(a, true) : t === 'W' ? dv.getInt32(a, true) : dv.getFloat32(a, true));
    }
    return out;
  };
  window.__pixels = async () => {
    const pr = atv.presenter, tex = pr?.source();
    if (!tex) return null;
    const w = tex.width, h = tex.height, bpr = (w * 4 + 255) & ~255, dev = pr.dev;
    const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = dev.createCommandEncoder();
    e.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    dev.queue.submit([e.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange()).slice();
    buf.unmap(); buf.destroy();
    return { w, h, bpr, src };
  };
  // Mean R G B of a rectangle in 640x480 frame coordinates (the source may be larger).
  window.__color = async (x, y, rw, rh) => {
    const p = await window.__pixels();
    if (!p) return null;
    const sx = p.w / 640, sy = p.h / 480;
    const x0 = Math.floor(x * sx), y0 = Math.floor(y * sy), x1 = Math.max(x0 + 1, Math.floor((x + rw) * sx)), y1 = Math.max(y0 + 1, Math.floor((y + rh) * sy));
    let r = 0, g = 0, bl = 0, n = 0;
    for (let yy = y0; yy < y1 && yy < p.h; yy++) for (let xx = x0; xx < x1 && xx < p.w; xx++) {
      const s = yy * p.bpr + xx * 4; bl += p.src[s]; g += p.src[s + 1]; r += p.src[s + 2]; n++;
    }
    return n ? [r / n, g / n, bl / n] : [0, 0, 0];
  };
  return true; })()`.replace('MEM_OFS_', String(MEM_OFS)));

// ---- pad state and the press queue ----------------------------------------
const BTN = { a: 0, b: 1, x: 2, y: 3, white: 4, black: 5, lt: 6, rt: 7, back: 8, start: 9, lthumb: 10, rthumb: 11,
  up: 12, down: 13, left: 14, right: 15 };
const held = { btns: new Array(17).fill(0), axes: [0, 0, 0, 0] };
const latched = { btns: new Array(17).fill(0), axes: [0, 0, 0, 0] };
function parseSpec(spec) {
  const st = { btns: new Array(17).fill(0), axes: [0, 0, 0, 0], ok: true };
  for (const tok of spec.toLowerCase().split('+')) {
    let m;
    if (tok in BTN) st.btns[BTN[tok]] = 1;
    else if (tok === 'lleft') st.axes[0] = -1; else if (tok === 'lright') st.axes[0] = 1;
    else if (tok === 'lup') st.axes[1] = -1; else if (tok === 'ldown') st.axes[1] = 1;
    else if (tok === 'rleft') st.axes[2] = -1; else if (tok === 'rright') st.axes[2] = 1;
    else if (tok === 'rup') st.axes[3] = -1; else if (tok === 'rdown') st.axes[3] = 1;
    else if ((m = /^(lx|ly|rx|ry)=(-?\d+)$/.exec(tok))) {
      const k = { lx: 0, ly: 1, rx: 2, ry: 3 }[m[1]], v = Number(m[2]) / 32767;
      st.axes[k] = (k === 1 || k === 3) ? -v : v;
    } else if ((m = /^(a|b|x|y|white|black|lt|rt)=(\d+)$/.exec(tok))) st.btns[BTN[m[1]]] = Number(m[2]) / 255;
    else st.ok = false;
  }
  return st;
}
async function pushPad() {
  const btns = held.btns.map((v, k) => Math.max(v, latched.btns[k]));
  const axes = held.axes.map((v, k) => latched.axes[k] || v);
  await b.eval(`__padState(${JSON.stringify(btns)}, ${JSON.stringify(axes)})`);
}
let queue = Promise.resolve(), pending = 0;
function durMs(s, def) {
  if (s === undefined) return def;
  const m = /^(\d+)(ms|f)?$/.exec(s);
  if (!m) return def;
  return m[2] === 'ms' ? Number(m[1]) : Math.round(Number(m[1]) * 1000 / 60);
}

// ---- frame counter, fps -----------------------------------------------------
const flipHist = [];
async function flips() { return (await b.eval('__flips()')) ?? 0; }
setInterval(async () => {
  try { flipHist.push([Date.now(), await flips()]); while (flipHist.length > 20) flipHist.shift(); } catch {}
}, 100);
function fpsNow() {
  if (flipHist.length < 2) return 0;
  const last = flipHist[flipHist.length - 1];
  const first = flipHist.find(([t]) => last[0] - t <= 500) ?? flipHist[0];
  return last[0] > first[0] ? (last[1] - first[1]) * 1000 / (last[0] - first[0]) : 0;
}
async function draws() { return (await b.eval('atv.presenter?.stats?.lastDraws ?? 0')) ?? 0; }

// ---- memory and values ------------------------------------------------------
const TYPES = { u8: 'b', u16: 'h', u32: 'w', i8: 'B', i16: 'H', i32: 'W', f32: 'f' };
async function peek(va, t, n = 1) { return b.eval(`__peek(${va}, '${t}', ${n})`); }
const RACER = (i) => 0x1D752C + i * 0x18;
async function chain(base, offs) {
  let a = base;
  for (const o of offs) { const p = await peek(a, 'w'); if (!p || !p[0]) return null; a = p[0] + o; }
  return a;
}
async function state() {
  const v = {};
  const put = (k, value, va, type) => { v[k] = { value, va: '0x' + (va >>> 0).toString(16).toUpperCase().padStart(8, '0'), type }; };
  put('track_index', (await peek(0x1D8654, 'w'))[0], 0x1D8654, 'u32');
  put('race_laps', (await peek(0x1D865C, 'w'))[0], 0x1D865C, 'u32');
  put('race_time', (await peek(0x1DA05C, 'f'))[0], 0x1DA05C, 'f32');
  const prog = await chain(0x1D8634, [0x4C4]);
  if (prog !== null) { const l = (await peek(prog, 'w'))[0]; put('laps_completed', l, prog, 'u32'); put('lap', l + 1, prog, 'u32'); }
  const pos = await chain(RACER(0), [0x70]);
  if (pos !== null) {
    const p = await peek(pos, 'f', 6);
    put('player_pos', p.slice(0, 3), pos, 'vec3');
    put('player_vel', p.slice(3, 6), pos + 12, 'vec3');
    const s = Math.hypot(p[3], p[4], p[5]);
    put('speed_ms', s, pos + 12, 'f32'); put('speed_mph', s * 2.237, pos + 12, 'f32');
  }
  return v;
}
function cmpOp(op, cur, v, start) {
  switch (op) {
    case 'eq': return cur === v; case 'ne': return cur !== v; case 'lt': return cur < v; case 'le': return cur <= v;
    case 'gt': return cur > v; case 'ge': return cur >= v;
    case 'changed': return cur !== start; case 'inc': return cur > start; case 'dec': return cur < start;
    default: return null;
  }
}
const num = (s) => (/^-?0x/i.test(s) ? parseInt(s, 16) : Number(s));

// ---- commands ---------------------------------------------------------------
async function handle(line) {
  const tok = line.trim().split(/\s+/).filter((t) => !t.startsWith('timeout='));
  const tmo = Number((/timeout=(\d+)/.exec(line) ?? [])[1] ?? 10000);
  const c = (tok[0] ?? '').toLowerCase();
  const fr = async () => ({ frame: await flips() });
  switch (c) {
    case 'ping': return { ok: true, pong: true, ...(await fr()) };
    case 'info': return { ok: true, ...(await fr()), fps: fpsNow(), draws: await draws(), paused: false, held: false,
      mem_offset: '0x10000', pad_pending: [pending, 0, 0, 0], pad_configured: [true, false, false, false], pad_reports: [1, 0, 0, 0],
      stage: await b.eval('atv.stage()'), status: await b.eval("document.getElementById('status').textContent"),
      elapsed_s: (Date.now() - t0) / 1000 };
    case 'frame': case 'fps': return { ok: true, ...(await fr()), fps: fpsNow(), draws: await draws() };
    case 'press': {
      let i = 1;
      if (/^p[1-4]$/.test(tok[i])) i++;
      const st = parseSpec(tok[i] ?? '');
      if (!st.ok) return { ok: false, error: `bad pad spec ${tok[i]}` };
      const hold = durMs(tok[i + 1], 100), gap = durMs(tok[i + 2], 100);
      pending++;
      queue = queue.then(async () => {
        held.btns = st.btns; held.axes = st.axes; await pushPad(); await sleep(hold);
        held.btns = new Array(17).fill(0); held.axes = [0, 0, 0, 0]; await pushPad(); await sleep(gap);
      }).finally(() => { pending--; });
      return { ok: true, pad: 1, queued: pending };
    }
    case 'hold': {
      const st = parseSpec(tok[/^p[1-4]$/.test(tok[1]) ? 2 : 1] ?? '');
      if (!st.ok) return { ok: false, error: 'bad pad spec' };
      st.btns.forEach((v, k) => { if (v) latched.btns[k] = v; });
      st.axes.forEach((v, k) => { if (v) latched.axes[k] = v; });
      await pushPad();
      return { ok: true, pad: 1 };
    }
    case 'release': case 'clear':
      latched.btns.fill(0); latched.axes = [0, 0, 0, 0]; await pushPad();
      return { ok: true, pad: 1 };
    case 'wait': {
      const what = tok[1], s0 = Date.now(), f0 = await flips();
      const done = async (extra = {}) => ({ ok: true, frame: await flips(), frames: (await flips()) - f0, ms: Date.now() - s0, ...extra });
      if (what === 'ms') { await sleep(Number(tok[2])); return done(); }
      if (what === 'frames') {
        const n = Number(tok[2]);
        while ((await flips()) - f0 < n) { if (Date.now() - s0 > tmo) return { ok: false, error: 'timeout' }; await sleep(8); }
        return done();
      }
      if (what === 'input') {
        while (pending) { if (Date.now() - s0 > tmo) return { ok: false, error: 'timeout' }; await sleep(10); }
        return done();
      }
      if (what === 'mem' || what === 'value') {
        let read;
        let op, v;
        if (what === 'mem') {
          const va = num(tok[2]), t = TYPES[tok[3]];
          read = async () => (await peek(va, t))[0];
          op = tok[4]; v = num(tok[5]);
        } else {
          const name = tok[2];
          read = async () => (await state())[name]?.value;
          op = tok[3]; v = num(tok[4]);
        }
        const start = await read();
        for (;;) {
          const cur = await read();
          if (cmpOp(op, cur, v, start)) return done({ value: cur });
          if (Date.now() - s0 > tmo) return { ok: false, error: 'timeout', value: cur };
          await sleep(16);
        }
      }
      if (what === 'fps' || what === 'draws') {
        const op = tok[2], v = Number(tok[3]);
        for (;;) {
          const cur = what === 'fps' ? fpsNow() : await draws();
          if (cmpOp(op, cur, v, 0)) return done({ value: cur });
          if (Date.now() - s0 > tmo) return { ok: false, error: 'timeout', value: cur };
          await sleep(50);
        }
      }
      return { ok: false, error: `wait ${what}: not in the bridge` };
    }
    case 'peek': {
      const va = num(tok[1]), t = TYPES[tok[2]], n = Number(tok[3] ?? 1);
      if (!t) return { ok: false, error: 'type' };
      return { ok: true, va: '0x' + va.toString(16).toUpperCase().padStart(8, '0'), type: tok[2], values: await peek(va, t, n) };
    }
    case 'poke': {     // poke VA TYPE V (roam tools: formation.py)
      const va = num(tok[1]), t = TYPES[tok[2]], v = Number(tok[3]);
      if (!t) return { ok: false, error: 'type' };
      await b.eval(`(() => { const m = window.__mem; if (!m) return 0; const dv = new DataView(m.buffer), a = ${va} + ${MEM_OFS};
        const t = '${t}'; if (t === 'f') dv.setFloat32(a, ${v}, true); else if (t === 'w' || t === 'W') dv.setUint32(a, ${v} >>> 0, true);
        else if (t === 'h' || t === 'H') dv.setUint16(a, ${v} & 0xffff, true); else dv.setUint8(a, ${v} & 255); return 1; })()`);
      return { ok: true };
    }
    case 'pause': case 'resume': return { ok: true, note: 'not in the bridge (no-op)' };
    case 'pageshot': { // the page as shown (canvas + DOM overlays such as roam name tags)
      const r = await b.send('Page.captureScreenshot', { format: 'png' });
      const data = r.result?.data ?? r.data;
      if (!data) return { ok: false, error: 'capture failed' };
      const path = tok.slice(1).join(' ');
      writeFileSync(path, Buffer.from(data, 'base64'));
      return { ok: true, path };
    }
    case 'roamdrop': return { ok: true, closed: await b.eval('(atv.roam?.ws?.close(), 1)') };
    case 'roam': return { ok: true, roam: await b.eval('JSON.stringify(atv.roam ?? null)') };
    case 'color': {
      const [x, y, w, h] = [1, 2, 3, 4].map((k) => Number(tok[k] ?? 1));
      const rgb = await b.eval(`__color(${x}, ${y}, ${w}, ${h})`);
      if (!rgb) return { ok: false, error: 'no frame yet' };
      return { ok: true, r: rgb[0], g: rgb[1], b: rgb[2] };
    }
    case 'screenshot': case 'shot': {
      const p = await b.eval('atv.snapshot()').catch(() => null);
      if (!p) return { ok: false, error: 'no frame yet' };
      const path = tok.slice(1).join(' ');
      writeFileSync(path, Buffer.from(p.split(',')[1], 'base64'));
      return { ok: true, path, ...(await fr()) };
    }
    case 'state': return { ok: true, ...(await fr()), fps: fpsNow(), values: await state() };
    case 'log': {      // last N page log lines
      const n = Number(tok[1] ?? 50);
      return { ok: true, lines: await b.eval(`atv.log.slice(-${n})`) };
    }
    case 'quit': case 'exit':
      setTimeout(shutdown, 50);
      return { ok: true };
    default: return { ok: false, error: `unknown command ${c} (bridge)` };
  }
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { writeFileSync(join(out, 'page.log'), (await b.eval('atv.log.join("\\n")').catch(() => '')) + '\n'); } catch {}
  await b.close();
  srv.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const server = createServer((sock) => {
  if (sock.remoteAddress !== '127.0.0.1' && sock.remoteAddress !== '::ffff:127.0.0.1') { sock.destroy(); return; }
  let buf = '';
  let chain2 = Promise.resolve();
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      chain2 = chain2.then(async () => {
        let r;
        try { r = await handle(line); } catch (e) { r = { ok: false, error: String(e.message ?? e) }; }
        sock.write(JSON.stringify(r) + '\n');
      });
    }
  });
  sock.on('error', () => {});
});
server.listen(ctlPort, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, ctl: server.address().port, http: port, pid: process.pid }));
});
