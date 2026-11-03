// Does the browser build's audio play? Boots the page in Edge, gives it a
// real user gesture (a CDP mouse click counts as user activation, so the
// autoplay policy lets the AudioContext run), then reports once a second what
// the AudioWorklet drained from the game's ring (underruns, queued latency,
// RMS/peak) and what reached the destination (an AnalyserNode tap), and
// records stretches of the worklet's output to local WAV files.
//
//   node web/tools/audio-check.mjs [seconds=90] [--out dir] [--click sec] [--capture sec:len,...]
//        [--headed] [--audible] [--autoplay] [--no-click] [--key] [--env K=V,...] [--wasm name] [--game dir]
//
//   --click 5        the click goes in at that second (default: once the game's ring exists)
//   --capture 80:5   record 5 s from second 80 to <out>/audio-80s.wav
//   --headed         a normal window instead of headless
//   --audible        do not pass --mute-audio (it plays on this PC's speakers)
//   --autoplay       --autoplay-policy=no-user-gesture-required (no gesture needed)
//   --no-click       never click (the context should stay suspended)
//   --key            the gesture is a key press (Q, unbound) instead of a click
//
// Everything stays on this PC: the page is served on 127.0.0.1, and <out>
// (default build-wasm/audio-check, outside git) holds audio.log, audio.json
// and the WAVs, which are game-derived.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const secs = Number(argv[0] && /^\d+$/.test(argv[0]) ? argv[0] : 90);
const out = resolve(opt('--out', join(ROOT, 'build-wasm/audio-check')));
const clickAt = opt('--click') !== undefined ? Number(opt('--click')) : null;
const captures = (opt('--capture', '') || '').split(',').filter(Boolean).map((s) => s.split(':').map(Number));
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the dev server and the browser ----------------------------------------
const port = 8600 + Math.floor(Math.random() * 300);
const game = opt('--game');
const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  ...(game ? ['--game', game] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const qs = new URLSearchParams();
if (opt('--env')) qs.set('env', opt('--env'));
if (opt('--wasm')) qs.set('wasm', opt('--wasm'));
const url = `http://127.0.0.1:${port}/host/index.html${qs.size ? `?${qs}` : ''}`;

const dbg = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'atv2-audio-'));
const proc = spawn(findBrowser(), [
  flag('--headed') ? '' : '--headless=new',
  `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--enable-unsafe-webgpu',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  // A hidden or occluded window must not throttle the game's timers.
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  flag('--audible') ? '' : '--mute-audio',
  flag('--autoplay') ? '--autoplay-policy=no-user-gesture-required' : '',
  '--window-size=1280,1000', url,
].filter(Boolean), { stdio: 'ignore' });
const stop = () => {
  try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  srv.kill();
};

let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(100);
  try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(url.slice(0, 20))); } catch {}
}
if (!target) { stop(); throw new Error('browser did not come up'); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result?.result?.value;
};
await send('Runtime.enable');
for (let i = 0; i < 100; i++) { if (await evaluate('typeof window.ready') === 'object') break; await sleep(100); }

// ---- WAV + signal checks ------------------------------------------------------
function analyse(pcm, ch = 2) {
  const n = pcm.length / ch;
  let sq = 0, peak = 0, clip = 0, dc = 0, zc = 0, silentMs = 0, run = 0, distinct = new Set();
  const rate = 48000, win = rate / 100;  // 10 ms windows for the silence count
  let wsq = 0;
  for (let i = 0; i < n; i++) {
    const l = pcm[i * ch], r = pcm[i * ch + 1];
    const m = (l + r) / 2;
    sq += l * l + r * r; dc += m;
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
    if (a >= 32767) clip++;
    if (i && (pcm[(i - 1) * ch] < 0) !== (l < 0)) zc++;
    if (distinct.size < 70000) distinct.add(l);
    wsq += l * l + r * r;
    if (++run === win) { if (Math.sqrt(wsq / (2 * win)) < 33) silentMs += 10; run = 0; wsq = 0; }
  }
  const rms = Math.sqrt(sq / (2 * n));
  return {
    seconds: +(n / rate).toFixed(2), rms: +rms.toFixed(1), rmsDbfs: +(20 * Math.log10(rms / 32768 || 1e-9)).toFixed(1),
    peak, peakDbfs: +(20 * Math.log10(peak / 32768 || 1e-9)).toFixed(1), clippedSamples: clip, dc: +(dc / n).toFixed(1),
    zeroCrossingsPerSec: Math.round(zc / (n / rate)), distinctLeftValues: distinct.size, silentMs,
  };
}
function wav(pcmBytes, rate, ch = 2) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmBytes.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcmBytes.length, 40);
  return Buffer.concat([h, pcmBytes]);
}

// ---- run ------------------------------------------------------------------------
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const per = [];
const results = { url, headed: flag('--headed'), muted: !flag('--audible'), autoplay: flag('--autoplay'), clickedAt: null, captures: [] };
let clicked = false, lastFlips = 0, lastLog = 0;
const t0 = Date.now();
try {
  const pendingCaps = [];
  for (let s = 1; s <= secs; s++) {
    await sleep(Math.max(0, t0 + s * 1000 - Date.now()));
    const st = await evaluate(`({ a: atv.audio?.state() ?? null, status: document.getElementById('status').textContent,
      exit: atv.state.exit, err: atv.state.error ?? null, stage: atv.stage() })`);
    const flips = Number(/flips (\d+)/.exec(st.status)?.[1] ?? 0);
    const fps = flips - lastFlips; lastFlips = flips;
    const a = st.a;
    if (!clicked && !flag('--no-click') && a && (clickAt !== null ? s >= clickAt : a.ring)) {
      // A real input event: user activation for the autoplay policy.
      if (flag('--key')) {
        // Q: no game binding.
        for (const type of ['keyDown', 'keyUp'])
          await send('Input.dispatchKeyEvent', { type, key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, text: type === 'keyDown' ? 'q' : undefined });
      } else {
        for (const type of ['mousePressed', 'mouseReleased'])
          await send('Input.dispatchMouseEvent', { type, x: 400, y: 300, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      }
      clicked = true; results.clickedAt = s;
      say(`${String(s).padStart(4)}s ${flag('--key') ? 'key Q (Input.dispatchKeyEvent)' : 'click (Input.dispatchMouseEvent)'}`);
    }
    const ws_ = a?.stats;
    const row = { s, stage: st.stage, fps, ctx: a?.ctx, attached: a?.attached, act: a?.activation?.has,
      underruns: ws_?.underruns, fill: ws_ ? [ws_.fill.min, Math.round(ws_.fill.avg), ws_.fill.max] : null,
      rms: ws_ ? +ws_.rms.toFixed(4) : null, peak: ws_ ? +ws_.peak.toFixed(3) : null, graphRms: a ? +a.graph.rms.toFixed(4) : null,
      frames: ws_?.frames, total: ws_?.total };
    per.push(row);
    say(`${String(s).padStart(4)}s ${st.stage.padEnd(8)} flips/s ${String(fps).padStart(3)} | ctx ${row.ctx}${row.attached ? '+worklet' : ''}` +
      (ws_ ? ` | ${ws_.frames} fr, short quanta ${ws_.underruns}, fill ${row.fill.join('/')} fr, rms ${row.rms} peak ${row.peak}, dest rms ${row.graphRms}` : ''));
    for (const [at, len] of captures) {
      if (at === s) {
        say(`${String(s).padStart(4)}s capturing ${len} s`);
        pendingCaps.push(evaluate(`atv.audio.capture(${len})`).then((c) => {
          const bytes = Buffer.from(c.pcm, 'base64');
          const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
          const file = join(out, `audio-${at}s.wav`);
          writeFileSync(file, wav(bytes, c.rate));
          const an = analyse(pcm);
          results.captures.push({ at, file, ...an });
          say(`        WAV ${file}: ${JSON.stringify(an)}`);
        }, (e) => say(`        capture at ${at}s failed: ${e.message}`)));
      }
    }
    // Page log lines as they come (the game's [WEBAUDIO]/[APU] lines).
    const log = await evaluate(`atv.log.slice(${lastLog})`);
    lastLog += log.length;
    for (const l of log) if (/AUDIO|\[APU\]|audio/.test(l)) say(`        | ${l}`);
    if (st.exit !== null || st.err) { say(`stopped: exit ${st.exit} ${st.err ?? ''}`); break; }
  }
  await Promise.all(pendingCaps);
  // Summary over the seconds the worklet ran with data.
  const live = per.filter((r) => r.frames > 0);
  const after = live.slice(2);   // skip the attach second and the one after
  const sum = (k) => after.reduce((a, r) => a + (r[k] ?? 0), 0);
  results.summary = {
    secondsPlaying: live.length,
    framesPerSecond: after.length ? Math.round(sum('frames') / after.length) : 0,
    shortQuanta: sum('underruns'), secondsWithShortQuanta: after.filter((r) => r.underruns).length,
    fillMinFrames: after.length ? Math.min(...after.map((r) => r.fill[0])) : null,
    fillAvgFrames: after.length ? Math.round(after.reduce((a, r) => a + r.fill[1], 0) / after.length) : null,
    fillMaxFrames: after.length ? Math.max(...after.map((r) => r.fill[2])) : null,
    flipsPerSecond: after.length ? +(after.reduce((a, r) => a + r.fps, 0) / after.length).toFixed(1) : null,
    loudestSecondRms: after.length ? Math.max(...after.map((r) => r.rms)) : null,
    final: await evaluate('atv.audio.state()'),
  };
  say(`summary: ${JSON.stringify(results.summary)}`);
  writeFileSync(join(out, 'audio.json'), JSON.stringify({ ...results, perSecond: per }, null, 1));
  writeFileSync(join(out, 'boot.log'), (await evaluate('atv.log.join("\\n")')) + '\n');
  writeFileSync(join(out, 'audio.log'), lines.join('\n') + '\n');
  say(`${((Date.now() - t0) / 1000).toFixed(0)} s; ${join(out, 'audio.json')}, boot.log, audio.log`);
} finally {
  try { ws.close(); } catch {}
  stop();
}
