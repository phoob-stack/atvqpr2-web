// Boot the browser build in headless Edge and report how far it gets.
//
//   node web/tools/boot.mjs [seconds=60] [--env K=V,K=V] [--keys 20:13,25:90] [--out dir]
//        [--game <folder>] [--wasm <url>] [--args a,b]   (tests: another module/folder)
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
const keys = (opt('--keys', '') || '').split(',').filter(Boolean).map((s) => s.split(':').map(Number));
mkdirSync(out, { recursive: true });

const port = 8600 + Math.floor(Math.random() * 300);
const game = opt('--game'), wasm = opt('--wasm'), args = opt('--args');
const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  ...(game ? ['--game', game] : [])],
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
  for (let s = 0; s < secs; s++) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const [at, vk] of keys) {
      if (at === s) { await b.eval(`atv.key(${vk}, 1)`); setTimeout(() => b.eval(`atv.key(${vk}, 0)`).catch(() => {}), 150); }
    }
    const st = await b.eval(`({ status: document.getElementById('status').textContent, exit: atv.state.exit, err: atv.state.error ?? null })`);
    if (st.status !== last) { console.log(`${String(s + 1).padStart(4)}s ${st.status}`); last = st.status; }
    if (st.exit !== null || st.err) break;
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
