// Drive the browser build into a Dunes: Lagoon race from a fresh profile and
// measure it: fps per second, and optionally a CPU profile of every thread.
//
//   node web/tools/race.mjs [seconds=30] [--out dir] [--profile secs] [--warm secs=6]
//        [--env K=V,...] [--wasm url] [--shots] [--keep-profiles] [--opfs] [--profile dir] [--port n]
//
// --opfs: the dev server has no /data/; the game files are the ones imported
// into OPFS (web/tools/import.mjs with the same --profile and --port).
//
// Route (headless Edge, fresh browser profile, so no save): title (status
// 'draws 18,') -> Enter -> SAVED PROFILES: A creates one -> CHOOSE A RIDER: A ->
// NAME YOUR RIDER: A on OK -> main menu (ATV ACADEMY) Down x2 to SINGLE RACE ->
// A through RIDER / ATV / TRACK (Dunes: Lagoon, 3 laps) -> loading ->
// countdown -> race, with Z (= A, throttle) held from the track screen on.
// Keys go through atv.key (VK codes: Enter 13, Z 90, Down 40).
//
// Then it waits until the frame has > 300 draws for 3 s (the race), --warm
// seconds more, and measures <seconds> seconds: per second the guest flips,
// the frames the page encoded, draws per frame, and the page's copy and
// encode time per frame. --profile N also records N seconds of V8 CPU
// profile on the page and on every Worker (each one host thread: guest
// threads, the pushbuffer executor, timers...) and prints self/inclusive
// time per function for each (cpuprofiles saved in <out> with
// --keep-profiles). <out> defaults to build-wasm/race (outside git: frames
// are game-derived).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const secs = Number(argv[0] && /^\d+$/.test(argv[0]) ? argv[0] : 30);
const out = resolve(opt('--out', join(ROOT, 'build-wasm/race')));
const profSecs = Number(opt('--profile', 0));
const warm = Number(opt('--warm', 6));
const env = ['RECOMP_SKIP_MOVIES=1', opt('--env', '')].filter(Boolean).join(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

// Seconds after the title appears (anchor) -> [vk, hold ms]. Hold 0 = keep down.
const ROUTE = [[3, 13], [8, 90], [13, 90], [18, 90], [23, 40], [24, 40], [28, 90], [32, 90], [36, 90], [40, 90],
  [44, 90, 0]];

const port = Number(opt('--port', 8600 + Math.floor(Math.random() * 300)));
const wasm = opt('--wasm');
const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  ...(argv.includes('--opfs') ? [] : ['--game', join(ROOT, 'game/atv2')])],
  { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const qs = new URLSearchParams();
qs.set('env', env);
if (wasm) qs.set('wasm', wasm);
const b = await launch(`http://127.0.0.1:${port}/host/index.html?${qs}`, { profile: opt('--profile') });
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const status = () => b.eval(`(() => { const h = atv.presenter?.i32, s = atv.presenter?.stats ?? {};
  return { status: document.getElementById('status').textContent, exit: atv.state.exit, err: atv.state.error ?? null,
    draws: s.lastDraws ?? 0, frames: s.frames ?? 0, copyMs: s.copyMs ?? 0, encodeMs: s.encodeMs ?? 0,
    vtx: s.vtxBytes ?? 0, idx: s.idxBytes ?? 0, consts: s.constBytes ?? 0, queue: s.queueBytes ?? 0,
    flips: h ? h[atv.flipsIndex] : 0 }; })()`);
let result = 1;
try {
  // Host.at.flips, from abi.js (the page's own module).
  await b.eval(`import('/host/abi.js').then((m) => { atv.flipsIndex = m.Host.at.flips; atv.droppedIndex = m.Host.at.gp_dropped; return 1; })`);
  // 1. the title
  let base = null;
  for (let s = 0; s < 120 && base === null; s++) {
    await sleep(1000);
    const st = await status();
    if (st.exit !== null || st.err) throw new Error(`boot ended: ${st.err ?? st.exit}`);
    if (st.status.includes('draws 18,')) base = Date.now();
  }
  if (base === null) throw new Error('no title screen in 120 s');
  console.log(`${el()} title`);
  // 2. the menus
  for (const [at, vk, hold] of ROUTE) {
    const wait = base + at * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    await b.eval(`atv.key(${vk}, 1)`);
    if (hold !== 0) setTimeout(() => b.eval(`atv.key(${vk}, 0)`).catch(() => {}), hold ?? 150);
    if (argv.includes('--shots')) {
      const p = await b.eval('atv.snapshot()').catch(() => null);
      if (p) writeFileSync(join(out, `route-${at}.png`), Buffer.from(p.split(',')[1], 'base64'));
    }
  }
  // 3. the race: > 300 draws for 3 s
  let run = 0;
  for (let s = 0; s < 60 && run < 3; s++) {
    await sleep(1000);
    const st = await status();
    if (st.exit !== null || st.err) throw new Error(`ended: ${st.err ?? st.exit}`);
    run = st.draws > 300 ? run + 1 : 0;
  }
  if (run < 3) throw new Error('no race (draws never > 300 for 3 s)');
  console.log(`${el()} racing; warming ${warm} s`);
  await sleep(warm * 1000);
  const shot = await b.eval('atv.snapshot()').catch(() => null);
  if (shot) writeFileSync(join(out, 'race-start.png'), Buffer.from(shot.split(',')[1], 'base64'));

  // 4. optional CPU profile of every thread
  if (profSecs) await profile(profSecs);

  // 5. fps per second
  let prev = await status();
  const rows = [];
  for (let s = 0; s < secs; s++) {
    await sleep(1000);
    const st = await status();
    const fr = st.frames - prev.frames;
    const row = { flips: st.flips - prev.flips, frames: fr, draws: st.draws,
      copy: fr ? (st.copyMs - prev.copyMs) / fr : 0, encode: fr ? (st.encodeMs - prev.encodeMs) / fr : 0,
      kb: fr ? (st.vtx + st.idx + st.consts + st.queue - prev.vtx - prev.idx - prev.consts - prev.queue) / fr / 1024 : 0,
      vkb: fr ? (st.vtx - prev.vtx) / fr / 1024 : 0 };
    rows.push(row);
    console.log(`${el()} flips ${String(row.flips).padStart(3)}/s  page frames ${String(fr).padStart(3)}  draws ${String(st.draws).padStart(4)}  ` +
      `stage+claim ${row.copy.toFixed(2)} ms  encode ${row.encode.toFixed(2)} ms  ${row.kb.toFixed(0)} KB (vtx ${row.vkb.toFixed(0)}) per frame`);
    prev = st;
    if (st.exit !== null || st.err) break;
  }
  const f = rows.map((r) => r.flips).sort((x, y) => x - y);
  const avg = f.reduce((a, x) => a + x, 0) / Math.max(1, f.length);
  const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / Math.max(1, rows.length);
  console.log(`RESULT fps avg ${avg.toFixed(1)} min ${f[0]} median ${f[f.length >> 1]} max ${f[f.length - 1]} over ${f.length} s; ` +
    `draws avg ${mean('draws').toFixed(0)}; page stage ${mean('copy').toFixed(2)} ms, encode ${mean('encode').toFixed(2)} ms, ` +
    `${mean('kb').toFixed(0)} KB (vtx ${mean('vkb').toFixed(0)}) per frame`);
  const end = await b.eval('atv.snapshot()').catch(() => null);
  if (end) writeFileSync(join(out, 'race-end.png'), Buffer.from(end.split(',')[1], 'base64'));
  result = 0;
} catch (e) {
  console.log(`${el()} FAILED: ${e.message}`);
  const p = await b.eval('atv.snapshot()').catch(() => null);
  if (p) writeFileSync(join(out, 'failed.png'), Buffer.from(p.split(',')[1], 'base64'));
} finally {
  const logText = await b.eval('atv.log.join("\\n")').catch(() => '');
  writeFileSync(join(out, 'race.log'), logText + '\n');
  await b.close();
  srv.kill();
}
process.exit(result);

// ---- per-thread CPU profile ------------------------------------------------
async function profile(n) {
  const sessions = new Map();          // sessionId -> { title, type }
  const off = b.on((m) => {
    if (m.method === 'Target.attachedToTarget')
      sessions.set(m.params.sessionId, { title: m.params.targetInfo.title, type: m.params.targetInfo.type, url: m.params.targetInfo.url });
  });
  await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(500);
  const all = [[undefined, { title: 'page main thread', type: 'page' }], ...sessions];
  for (const [sid] of all) {
    await b.send('Profiler.enable', {}, sid);
    await b.send('Profiler.setSamplingInterval', { interval: 500 }, sid);
  }
  await Promise.all(all.map(([sid]) => b.send('Profiler.start', {}, sid)));
  console.log(`${el()} profiling ${all.length} threads for ${n} s`);
  await sleep(n * 1000);
  const profs = await Promise.all(all.map(([sid]) => b.send('Profiler.stop', {}, sid)));
  off();
  const reports = [];
  profs.forEach((r, i) => {
    const p = r.result?.profile;
    if (!p) return;
    const [sid, info] = all[i];
    if (argv.includes('--keep-profiles')) writeFileSync(join(out, `thread-${i}.cpuprofile`), JSON.stringify(p));
    reports.push(summarize(p, `${i}: ${info.type} ${info.title ?? ''}`));
  });
  // Busiest threads first.
  reports.sort((x, y) => y.busy - x.busy);
  for (const r of reports) console.log(r.text);
}

// Self and inclusive time per function. "Idle" = (idle)/(program)/(garbage
// collector) at the top of the stack; waits inside wasm show as the C
// function that waits (memory.atomic.wait32 is an instruction).
function summarize(p, title) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(), incl = new Map();
  let total = 0, idle = 0;
  const name = (n) => n.callFrame.functionName || `(anon ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber})`;
  p.samples.forEach((id, k) => {
    const dt = (p.timeDeltas[k + 1] ?? p.timeDeltas[k] ?? 0) / 1000;
    total += dt;
    const n = byId.get(id);
    const nm = name(n);
    if (nm === '(idle)' || nm === '(program)' || nm === '(root)') idle += dt;
    self.set(nm, (self.get(nm) ?? 0) + dt);
    const seen = new Set();
    for (let x = id; x !== undefined; x = parent.get(x)) {
      const xn = name(byId.get(x));
      if (seen.has(xn)) continue;
      seen.add(xn);
      incl.set(xn, (incl.get(xn) ?? 0) + dt);
    }
  });
  const top = (m, k) => [...m].sort((a, c) => c[1] - a[1]).slice(0, k)
    .map(([f, t]) => `    ${(100 * t / total).toFixed(1).padStart(5)}%  ${f}`).join('\n');
  return { busy: total - idle, text: `== thread ${title}: ${total.toFixed(0)} ms sampled, ${(100 * (total - idle) / Math.max(1, total)).toFixed(0)}% not idle\n` +
    `  self:\n${top(self, 14)}\n  inclusive:\n${top(incl, 14)}` };
}
