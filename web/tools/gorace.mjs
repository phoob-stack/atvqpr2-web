// The frame rate around the start of a race in the browser build: race.mjs's
// route into a Dunes: Lagoon race, with every flip timestamped from a Worker
// that watches the WebHost flip counter in the shared wasm memory (2 ms
// polling, independent of the page's main thread, which is the encoder).
//
//   node web/tools/gorace.mjs [--secs 14] [--port n] [--profile dir] [--out dir]
//        [--qs 'res=2'] [--env K=V,...] [--wasm url] [--json file] [--shots] [--save-pipes]
//
// --save-pipes: merge the render pipelines the run created into
// build-wasm/pipelines.json (pipelist.mjs; the page creates them ahead of time
// at boot, ?prepipes=0 does not). Each run is a fresh browser profile unless
// --profile, so it shows the first-run pipeline compiles.
//
// The race scene appears (draws > 300) -> about 5.7 s of countdown -> GO.
// Reported, from the first flip with > 300 draws (t = 0):
//   start  [0.05 s, 2.5 s]: the scene's first frames (new textures, shaders);
//   go     [2.5 s, secs]: the countdown, GO and the second after it;
// each with min fps over sliding 0.5 s and 1 s windows, the longest gap
// between flips, and gaps over 25 / 34 ms. Also the page's encode time.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { savePipelines } from './pipelist.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const secs = Number(opt('--secs', 14));
const out = resolve(opt('--out', join(ROOT, 'build-wasm/gorace')));
const env = ['RECOMP_SKIP_MOVIES=1', opt('--env', '')].filter(Boolean).join(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

// race.mjs's route: seconds after the title -> [vk, hold ms]; hold 0 = keep down.
const ROUTE = [[3, 13], [8, 90], [13, 90], [18, 90], [23, 40], [24, 40], [28, 90], [32, 90], [36, 90], [40, 90],
  [44, 90, 0]];

const port = Number(opt('--port', 8841));
const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  '--game', join(ROOT, 'game/atv2')], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const qs = new URLSearchParams();
qs.set('env', env);
if (opt('--wasm')) qs.set('wasm', opt('--wasm'));
qs.set('saves', 'off');
for (const [k, v] of new URLSearchParams(opt('--qs', ''))) qs.set(k, v);
const b = await launch(`http://127.0.0.1:${port}/host/index.html?${qs}`, { profile: opt('--profile') });
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const status = () => b.eval(`(() => { const s = atv.presenter?.stats ?? {};
  return { status: document.getElementById('status').textContent, exit: atv.state.exit, err: atv.state.error ?? null,
    draws: s.lastDraws ?? 0 }; })()`);

// The flip watcher: a Worker polling WebHost.flips / last_draws every 2 ms.
// Also samples the presenter's encode/stage totals on the main thread.
const WATCH = `(async () => {
  const m = await import('/host/abi.js');
  const p = atv.presenter;
  const src = \`onmessage = (e) => {
    const { memory, ptr, fi, di, stop } = e.data;
    const h = new Int32Array(memory.buffer, ptr, 64), nap = new Int32Array(new SharedArrayBuffer(4));
    const out = []; let last = Atomics.load(h, fi);
    while (!Atomics.load(stop, 0)) {
      Atomics.wait(nap, 0, 0, 2);
      const f = Atomics.load(h, fi);
      if (f !== last) { out.push([performance.now() + performance.timeOrigin, f, Atomics.load(h, di)]); last = f; }
    }
    postMessage(out);
  };\`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  atv.goWatch = new Promise((r) => { w.onmessage = (e) => r(e.data); });
  const page = []; atv.goPage = page;
  const iv = setInterval(() => { const s = p.stats, e = p.enc.stats;
    page.push([performance.now() + performance.timeOrigin, s.frames, s.encodeMs, s.copyMs, e.texMs ?? 0, e.texN ?? 0,
      e.shMs ?? 0, e.shN ?? 0, e.pipeMs ?? 0, e.pipelines, e.vtxMs ?? 0, e.idxMs ?? 0, e.uniMs ?? 0, e.growMs ?? 0,
      e.grows ?? 0]); }, 50);
  const stop = new Int32Array(new SharedArrayBuffer(4));
  atv.goStop = () => { clearInterval(iv); Atomics.store(stop, 0, 1); return 1; };
  w.postMessage({ memory: p.memory, ptr: p.ptr, fi: m.Host.at.flips, di: m.Host.at.last_draws, stop });
  return 1;
})()`;

let result = 1;
const report = {};
try {
  let base = null;
  for (let s = 0; s < 120 && base === null; s++) {
    await sleep(1000);
    const st = await status();
    if (st.exit !== null || st.err) throw new Error(`boot ended: ${st.err ?? st.exit}`);
    if (st.status.includes('draws 18,')) base = Date.now();
  }
  if (base === null) throw new Error('no title screen in 120 s');
  console.log(`${el()} title`);
  for (const [at, vk, hold] of ROUTE) {
    const wait = base + at * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    if (at === 40) await b.eval(WATCH);              // before the track screen's last A
    await b.eval(`atv.key(${vk}, 1)`);
    if (hold !== 0) setTimeout(() => b.eval(`atv.key(${vk}, 0)`).catch(() => {}), hold ?? 150);
  }
  // The race scene: > 300 draws; then secs more.
  let seen = 0;
  for (let s = 0; s < 120 && !seen; s++) {
    await sleep(500);
    const st = await status();
    if (st.exit !== null || st.err) throw new Error(`ended: ${st.err ?? st.exit}`);
    if (st.draws > 300) seen = Date.now();
  }
  if (!seen) throw new Error('no race (draws never > 300)');
  console.log(`${el()} race scene; recording ${secs} s`);
  for (let s = 0; s < secs; s++) {
    await sleep(1000);
    if (argv.includes('--shots') && s % 2 === 1) {
      const p = await b.eval('atv.snapshot()').catch(() => null);
      if (p) writeFileSync(join(out, `go-${s}.png`), Buffer.from(p.split(',')[1], 'base64'));
    }
  }
  await b.eval('atv.goStop()');
  const fl = await b.eval('atv.goWatch');
  const page = await b.eval('atv.goPage');
  const iRace = fl.findIndex((r) => r[2] > 300);
  if (iRace < 0) throw new Error('no flip with > 300 draws recorded');
  const T0 = fl[iRace][0];
  const stats = (a, z) => {
    const ta = T0 + a * 1000, tz = T0 + z * 1000;
    const rows = fl.map((r, i) => ({ t: r[0], iv: i ? r[0] - fl[i - 1][0] : 0, d: r[2], n: i ? r[1] - fl[i - 1][1] : 1 }));
    const win = rows.filter((r) => r.t >= ta && r.t <= tz);
    if (!win.length) return { frames: 0 };
    const minFps = (span) => {
      let best = 1e9, at = null, j = 0, cnt = 0;
      const ts = rows.map((r) => r.t);
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].t < ta + span || rows[i].t > tz) continue;
        while (ts[j] < rows[i].t - span) j++;
        cnt = 0; for (let k = j + 1; k <= i; k++) cnt += rows[k].n;
        const f = cnt * 1000 / span;
        if (f < best) { best = f; at = (rows[i].t - T0) / 1000; }
      }
      return [Math.round(best * 10) / 10, at === null ? null : Math.round(at * 100) / 100];
    };
    const flipsIn = win.reduce((s, r) => s + r.n, 0);
    const o = { frames: flipsIn, avg_fps: Math.round(flipsIn * 10000 / (win[win.length - 1].t - win[0].t)) / 10 };
    [o.min_fps_05, o.min_fps_05_at] = minFps(500);
    [o.min_fps_1, o.min_fps_1_at] = minFps(1000);
    const worst = win.reduce((m, r) => (r.iv > m.iv ? r : m), win[0]);
    o.worst_ms = Math.round(worst.iv * 10) / 10; o.worst_at = Math.round((worst.t - T0) / 10) / 100;
    o.over25 = win.filter((r) => r.iv > 25).length; o.over34 = win.filter((r) => r.iv > 34).length;
    o.skipped_counts = win.filter((r) => r.n > 1).length;
    const pg = page.filter((r) => r[0] >= ta && r[0] <= tz);
    if (pg.length > 1) {
      const fr = pg[pg.length - 1][1] - pg[0][1];
      o.page_encode_ms = fr ? Math.round((pg[pg.length - 1][2] - pg[0][2]) / fr * 100) / 100 : 0;
      o.page_stage_ms = fr ? Math.round((pg[pg.length - 1][3] - pg[0][3]) / fr * 100) / 100 : 0;
      let worstEnc = 0, wi = 0;
      for (let i = 1; i < pg.length; i++) {
        const df = pg[i][1] - pg[i - 1][1], de = pg[i][2] - pg[i - 1][2] + pg[i][3] - pg[i - 1][3];
        if (df > 0 && de / df > worstEnc) { worstEnc = de / df; wi = i; }
      }
      o.page_worst_50ms_avg = Math.round(worstEnc * 10) / 10;
      const d = (k) => Math.round((pg[pg.length - 1][k] - pg[0][k]) * 10) / 10;
      o.page_sum = { tex_ms: d(4), tex_n: d(5), sh_ms: d(6), sh_n: d(7), pipe_ms: d(8), pipe_n: d(9) };
      if (wi) {
        const w = (k) => Math.round((pg[wi][k] - pg[wi - 1][k]) * 10) / 10;
        o.page_worst = { at: Math.round((pg[wi][0] - T0) / 10) / 100, frames: w(1), enc: w(2), stage: w(3),
          tex_ms: w(4), tex_n: w(5), sh_ms: w(6), sh_n: w(7), pipe_ms: w(8), pipe_n: w(9),
          vtx_ms: w(10), idx_ms: w(11), uni_ms: w(12), grow_ms: w(13), grows: w(14) };
      }
    }
    o.gaps = win.filter((r) => r.iv > 34).slice(0, 8).map((r) => [Math.round((r.t - T0) / 10) / 100, Math.round(r.iv)]);
    return o;
  };
  Object.assign(report, { start: stats(0.05, 2.5), go: stats(2.5, secs), all: stats(0.05, secs) });
  for (const k of ['start', 'go', 'all']) {
    const o = report[k];
    console.log(`${k.padEnd(5)} frames ${o.frames} avg ${o.avg_fps} min0.5 ${o.min_fps_05} @${o.min_fps_05_at} ` +
      `min1 ${o.min_fps_1} @${o.min_fps_1_at} worst ${o.worst_ms} ms @${o.worst_at} >25 ${o.over25} >34 ${o.over34} ` +
      `encode ${o.page_encode_ms} stage ${o.page_stage_ms} worst50 ${o.page_worst_50ms_avg} gaps ${JSON.stringify(o.gaps)}\n` +
      `      page ${JSON.stringify(o.page_sum)} worst ${JSON.stringify(o.page_worst)}`);
  }
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(report) + '\n', { flag: 'a' });
  writeFileSync(join(out, 'flips.json'), JSON.stringify({ T0, fl, page }));
  if (argv.includes('--save-pipes')) console.log(await savePipelines(b, join(ROOT, 'build-wasm/pipelines.json')));
  console.log(`page: ${await b.eval('atv.log.filter((l) => l.includes("pipelines created ahead")).join(" ")')} ` +
    `pipelines made at a draw ${await b.eval('atv.presenter.enc.stats.pipelines')}, taken from the preload ${await b.eval('atv.presenter.enc.stats.prePipes ?? 0')}`);
  result = 0;
} catch (e) {
  console.log(`${el()} FAILED: ${e.message}`);
} finally {
  const logText = await b.eval('atv.log.join("\\n")').catch(() => '');
  writeFileSync(join(out, 'gorace.log'), logText + '\n');
  await b.close();
  srv.kill();
}
process.exit(result);
