// Does V8 take the game module's compiled code from its code cache? Loads
// the page once with a kept profile and records a trace of the "v8.wasm"
// category until PRESS START, then lists the module-level events
// (deserialisation from the cache, streaming compile, caching) with times.
//
//   node web/tools/wasm-cache-trace.mjs --profile <dir with the game imported> [--port 8835] [--root <checkout>]
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('--port', 8835));
const SRV_ROOT = resolve(opt('--root', ROOT));
const srv = spawn(process.execPath, [join(SRV_ROOT, 'web/host/serve.mjs'), '--port', String(port),
  '--log', join(ROOT, 'build-wasm/loadtime/serve-trace.log')], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const origin = `http://127.0.0.1:${port}`;
const b = await launch(`${origin}/host/blank-for-trace`, { profile: opt('--profile'), port: 9800 + port % 100, waitReady: false });
const events = [];
b.on((m) => { if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); });
try {
  await b.send('Tracing.start', { traceConfig: { includedCategories: ['v8.wasm', 'disabled-by-default-v8.wasm.detailed'] },
    transferMode: 'ReportEvents' });
  await b.send('Page.navigate', { url: `${origin}/host/index.html?env=RECOMP_SKIP_MOVIES=1` });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await b.eval(`document.getElementById('status')?.textContent ?? ''`).catch(() => '');
    if (st.includes('draws 18,')) break;
  }
  const done = new Promise((r) => b.on((m) => { if (m.method === 'Tracing.tracingComplete') r(); }));
  await b.send('Tracing.end');
  await done;
  const t0 = Math.min(...events.filter((e) => e.ts > 0).map((e) => e.ts));
  const counts = new Map();
  for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const pick = /seriali|cache|stream|compile.?module|tier|instantiate/i;
  for (const e of events.filter((x) => pick.test(x.name) && (x.ph === 'X' || x.ph === 'B' || x.ph === 'I' || x.ph === 'i')).slice(0, 40))
    console.log(`${((e.ts - t0) / 1000).toFixed(0).padStart(6)} ms  ${e.name}${e.dur ? ` (${(e.dur / 1000).toFixed(1)} ms)` : ''}`);
  console.log('event counts:', [...counts].filter(([n]) => pick.test(n)).map(([n, c]) => `${n} x${c}`).join(', ') || '(none matched)');
  console.log('all names:', [...counts.keys()].slice(0, 60).join(', '));
} finally {
  await b.closeGracefully();
  srv.kill();
}
