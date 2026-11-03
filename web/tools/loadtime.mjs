// Load time of the browser build in headless Edge: from navigation to the
// wasm module compiled, the guest threads up, the first GPU frame, and the
// PRESS START title.
//
//   node web/tools/loadtime.mjs [--profile dir] [--port 8835] [--runs 3] [--opfs]
//        [--cold] [--fresh] [--timeout 120] [--env K=V,...] [--wasm url] [--json out.json]
//
//   --opfs   the server has no /data/: the game comes from the OPFS import in
//            --profile (web/tools/import.mjs, same --profile and --port).
//            Without it the server serves game/atv2 at /data/ (dev path).
//   --cold   before every run, delete the profile's HTTP cache, wasm code
//            cache and Cache Storage (OPFS, i.e. the imported game, stays):
//            "first load with the game already imported".
//   --fresh  a new empty profile for every run (no OPFS either: needs the
//            dev /data/ path, so not with --opfs).
//   (neither: the profile is kept as it is, so run 2.. are second loads.)
//   --root <dir>  serve another checkout's web/ (e.g. a baseline worktree,
//            for before/after numbers taken in the same minutes).
//
// Every time is page time (performance.now(), 0 = navigation start), polled
// every 50 ms; the page's own marks (atv.timings) are used when it has them.
// The browser is closed with Browser.close between runs, so the caches are
// written to disk as a real restart would leave them.
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const runs = Number(opt('--runs', 3));
const port = Number(opt('--port', 8835));
const opfs = argv.includes('--opfs'), cold = argv.includes('--cold'), fresh = argv.includes('--fresh');
const timeout = Number(opt('--timeout', 120)) * 1000;
const profileArg = opt('--profile');
const env = ['RECOMP_SKIP_MOVIES=1', opt('--env', '')].filter(Boolean).join(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fresh && !profileArg) { console.log('give --profile <dir> (or --fresh)'); process.exit(2); }

const out = join(ROOT, 'build-wasm/loadtime');
mkdirSync(out, { recursive: true });
const SRV_ROOT = resolve(opt('--root', ROOT));
const srv = spawn(process.execPath, [join(SRV_ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  ...(opfs ? [] : ['--game', join(SRV_ROOT, 'game/atv2')])], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const qs = new URLSearchParams({ env });
if (opt('--wasm')) qs.set('wasm', opt('--wasm'));
const url = `http://127.0.0.1:${port}/host/index.html?${qs}`;

// What Chromium keeps for "cached images and files" (not OPFS: File System).
const CACHE_DIRS = ['Default/Cache', 'Default/Code Cache', 'Default/Service Worker/CacheStorage', 'Default/GPUCache',
  'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache'];

const POLL = `(() => {
  const s = atv.presenter?.stats;
  return { t: performance.now(), status: document.getElementById('status')?.textContent ?? '',
    frames: s?.frames ?? 0, err: atv.state.error ?? null, exit: atv.state.exit,
    timings: atv.timings ?? null, nlog: atv.log.length,
    compiled: atv.log.find((l) => l.includes(' compiled in ')) ?? null,
    pool: atv.log.some((l) => l.includes('worker pool up')) };
})()`;

const results = [];
try {
  for (let run = 1; run <= runs; run++) {
    // (Fresh profiles live in build-wasm/: their OPFS gets game data.)
    if (fresh) mkdirSync(join(out, 'profiles'), { recursive: true });
    const profile = fresh ? mkdtempSync(join(out, 'profiles', 'fresh-')) : resolve(profileArg);
    if (cold) for (const d of CACHE_DIRS) rmSync(join(profile, d), { recursive: true, force: true });
    const b = await launch(url, { profile, port: 9800 + port % 100 });
    const r = { run, wasm: null, pool: null, first: null, title: null, error: null, compileLog: null };
    const t0 = Date.now();
    try {
      while (Date.now() - t0 < timeout) {
        let s;
        try { s = await b.eval(POLL); } catch { await sleep(50); continue; }
        if (s.err) { r.error = s.err; break; }
        if (s.compiled && r.wasm === null) { r.wasm = s.timings?.wasmCompiled ?? s.t; r.compileLog = s.compiled.replace(/^\[page\] /, ''); }
        if (s.pool && r.pool === null) r.pool = s.timings?.workersUp ?? s.t;
        if (s.frames > 0 && r.first === null) r.first = s.timings?.firstFrame ?? s.t;
        if (s.status.includes('draws 18,')) {
          r.title = s.t; r.timings = s.timings; r.status = s.status;
          if (argv.includes('--shot')) {
            await sleep(1500);
            const png = await b.eval('atv.snapshot()').catch(() => null);
            if (png) writeFileSync(join(out, `title-${run}.png`), Buffer.from(png.split(',')[1], 'base64'));
          }
          break;
        }
        await sleep(50);
      }
      if (r.title === null && !r.error) r.error = 'no title before the timeout';
    } finally {
      await b.closeGracefully();
      if (fresh) try { rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { console.log(`(profile left: ${e.message})`); }
    }
    const f = (v) => (v === null ? '   -  ' : `${(v / 1000).toFixed(2).padStart(6)}`);
    console.log(`run ${run}: wasm ${f(r.wasm)} s | threads ${f(r.pool)} s | first frame ${f(r.first)} s | PRESS START ${f(r.title)} s` +
      `${r.error ? ` | ERROR ${r.error}` : ''}\n        ${r.compileLog ?? ''}${r.timings ? `\n        marks ${JSON.stringify(r.timings)}` : ''}`);
    results.push(r);
  }
} finally {
  srv.kill();
}
const med = (k) => { const v = results.map((r) => r[k]).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
const summary = { mode: fresh ? 'fresh' : cold ? 'cold' : 'warm', opfs, runs: results.length,
  median: { wasm: med('wasm'), pool: med('pool'), first: med('first'), title: med('title') }, results };
console.log(`median: wasm ${(summary.median.wasm / 1000).toFixed(2)} s, threads ${(summary.median.pool / 1000).toFixed(2)} s, ` +
  `first frame ${(summary.median.first / 1000).toFixed(2)} s, PRESS START ${(summary.median.title / 1000).toFixed(2)} s`);
if (opt('--json')) writeFileSync(resolve(opt('--json')), JSON.stringify(summary, null, 1));
