// r2-e2e.mjs - the test title on the project site, streamed from a local R2
// stand-in, end to end in headless Edge (CDP). Everything on 127.0.0.1:
//   the asset server as the R2 stand-in (ASSET_BUCKET_DIR = the pipeline's
//   out/r2, CORS from deploy/r2-cors.json plus the local site's origin) on 8855,
//   the site folder with its own _headers (test/site-serve.mjs; connect-src
//   gets the stand-in's origin) on 8849, Edge's DevTools on 8859.
//
//   node test/r2-e2e.mjs [--site ../site] [--profile .test/r2e2e/edge] [--results .test/r2e2e] [--only a,b]
//
// Steps: panel (the home page's two sources), first (first start: bytes, time,
// progress), group (on-demand sand group), relaunch (0 downloads), offline
// (both servers stopped), resume (a cut connection, within a page and across
// page loads), transfer (corrupted bodies), cache (a corrupted stored file),
// parts (.part and other leftovers cleaned at start), full (?verify=full),
// orbit (the second title: games/orbit/, first start, its group, relaunch),
// transition (Box Quad at the bucket root only: the profile's fallback; then
// under games/boxquad/: same version, no download), rollback (a second
// release, then upload-r2.mjs --rollback --title boxquad; the client follows).
// Edge is stopped by its profile path at the end (its children outlive the
// launcher on Windows).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, cpSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { createAssetServer } from '../server/asset-server.mjs';
import { startSite } from './site-serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SITE = resolve(opt('--site', join(ROOT, '..', 'site')));
const PROFILE = resolve(opt('--profile', join(ROOT, '.test', 'r2e2e', 'edge')));
const RES = resolve(opt('--results', join(ROOT, '.test', 'r2e2e')));
const OUT = join(ROOT, '.test', 'r2e2e-out');           // pipeline output (the pipeline never writes outside the repo's own folders)
const SHOTS = join(RES, 'shots');
const only = argv.includes('--only') ? new Set(opt('--only').split(',')) : null;
const want = (s) => !only || only.has(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const results = { date: new Date().toISOString(), note: 'local 127.0.0.1; other tests share this PC, so times are noisy', checks: [] };
const check = (ok, what, detail = '') => { results.checks.push({ ok: !!ok, what, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); return ok; };

const ASSET_PORT = 8855, SITE_PORT = 8849;
const ASSETS = `http://127.0.0.1:${ASSET_PORT}`, SITE_URL = `http://127.0.0.1:${SITE_PORT}`;
const RUNNER = (extra = '') => `${SITE_URL}/test-title/?assets=${encodeURIComponent(ASSETS)}&autoplay=1${extra}`;

function stray() {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${PROFILE.replace(/'/g, "''")}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`], { stdio: 'ignore' });
  } catch { /* none */ }
}

let bucket = null, site = null, browser = null;
const startBucket = async () => { bucket = await createAssetServer({ port: ASSET_PORT, bucketDir: join(OUT, 'r2'), testHooks: true, rateRps: 0, bucketCorsOrigins: [SITE_URL] }, {}); };
const startSiteSrv = async () => { site = await startSite({ root: SITE, port: SITE_PORT, connectExtra: [ASSETS] }); };
// (a stand-in restarted under the same port leaves undici a pooled socket that resets: one retry)
const hook = async (path) => { try { return await (await fetch(`${ASSETS}/__test/${path}`)).json(); } catch { await sleep(100); return (await fetch(`${ASSETS}/__test/${path}`)).json(); } };
const statsReset = () => hook('stats?reset=1');
async function stats() {
  const s = await hook('stats');
  const by = (k) => s.byKind[k] ?? { requests: 0, bytes: 0 };
  const perFile = {};
  for (const l of s.log.filter((x) => x.kind === 'object')) {
    const f = (perFile[l.path] ??= { requests: 0, bytes: 0, statuses: [], ranged: [] });
    f.requests++; f.bytes += l.bytes;
    if (l.range) f.ranged.push({ start: Number(l.range.split('-')[0]), bytes: l.bytes });
    f.statuses.push(`${l.status}${l.range ? ` range ${l.range}` : ''}${l.cut ? ' CUT' : ''}`);
  }
  return { totalBodyBytes: s.bodyBytes, pointer: by('pointer'), manifest: by('manifest'), objects: by('object'), preflight: by('preflight'), perFile };
}

try {
  rmSync(RES, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  stray();
  rmSync(PROFILE, { recursive: true, force: true });
  log(`pipeline: ${execFileSync(process.execPath, [join(ROOT, 'pipeline', 'build.mjs'), '--out', OUT, '--no-site'], { encoding: 'utf8' }).trim().split('\n').at(-2)}`);
  await startBucket();
  await startSiteSrv();
  browser = await launch({ port: 8859, profile: PROFILE });
  log(`R2 stand-in ${ASSETS}, site ${SITE_URL}, Edge (profile ${PROFILE})`);

  const tab = await browser.open('about:blank');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; addEventListener('securitypolicyviolation', (e) =>
    window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '')));` });
  const running = () => tab.waitFor("window.delivery?.phase === 'running' && window.delivery.app?.state().frames > 20", { timeout: 30000 }).catch(async (e) => {
    const st = await tab.eval('JSON.stringify({ href: location.href, phase: window.delivery?.phase, events: window.delivery?.events, errors: window.delivery?.errors, state: document.getElementById("tt-state")?.textContent, msg: document.getElementById("tt-msg")?.textContent, body: document.body?.innerText?.slice(0, 120) })').catch((x) => x.message);
    const ping = await tab.eval("new Promise((r) => { const w = new Worker('/test-title/lib/asset-worker.js', { type: 'module' }); w.onerror = (e) => r('worker error ' + e.message); w.onmessage = (m) => r('worker answered ' + JSON.stringify(m.data)); w.postMessage({ op: 'verify', ns: 'ping', entries: [], id: 1 }); setTimeout(() => r('worker: no answer in 3 s'), 3000); })").catch((x) => x.message);
    const sw = await tab.eval('(async () => { const c = await caches.keys(); const out = {}; for (const k of c) out[k] = (await (await caches.open(k)).keys()).map((r) => r.url.replace(location.origin, "")); return out; })()').catch((x) => x.message);
    throw new Error(`${e.message}\npage: ${st}\nworker ping: ${ping}\ncaches: ${JSON.stringify(sw)}`); });
  const csp = async () => (await tab.eval('window.__csp ?? []').catch(() => [])) ?? [];
  const opfsBlobs = () => tab.eval(`(async () => { try { const d = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('delivery')).getDirectoryHandle('boxquad')).getDirectoryHandle('blobs');
    const out = {}; for await (const [n, h] of d.entries()) out[n] = (await h.getFile()).size; return out; } catch { return {}; } })()`);
  const entry = (path) => tab.eval(`(async () => { const r = await fetch('${ASSETS}/games/boxquad/latest.json', { cache: 'no-store' }).then((r) => r.json());
    const m = await fetch('${ASSETS}/games/boxquad/' + r.manifest).then((r) => r.json()); return m.files.find((f) => f.path === ${JSON.stringify(path)}); })()`);

  // ---- the panel ----------------------------------------------------------------------------
  if (want('panel')) {
    await tab.navigate(`${SITE_URL}/index.html?assets=${encodeURIComponent(ASSETS)}`);
    await tab.waitFor("['none','ready','partial'].includes(document.querySelector('.test-state')?.dataset.state) && ['need','stale','ready'].includes(document.querySelector('.play-state')?.dataset.state)", { timeout: 20000 });
    const p = await tab.eval(`({ srcs: [...document.querySelectorAll('.playbox .play-src')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()),
      primary: [...document.querySelectorAll('.playbox .play-btn')].map((e) => e.textContent), test: document.querySelector('.test-state').textContent,
      testState: document.querySelector('.test-state').dataset.state, link: document.querySelector('#test-play').getAttribute('href') })`);
    check(p.srcs[0] === 'ATV 2 · from your own files' && /^Test title · streamed from 127\.0\.0\.1:8855$/.test(p.srcs[1]),
      'panel: two sources, ATV 2 (your own files) and the test title (streamed, its host shown)', p.srcs.join(' | '));
    check(p.primary.length === 1 && p.primary[0] === 'Select local game files', 'panel: ATV 2 keeps "Select local game files" as the one primary button', p.primary.join(', '));
    check(p.testState === 'none' && p.link.startsWith('test-title/?assets='), 'panel: the test title is not in this browser yet; its link carries ?assets= on this local copy', `${p.test} [${p.link}]`);
    results.panel = p;
    await tab.screenshot(join(SHOTS, '0-panel.png'));
  }

  // ---- first start ------------------------------------------------------------------------------
  if (want('first')) {
    await statsReset();
    const t = Date.now();
    await tab.navigate(RUNNER());
    await running();
    const wall = Date.now() - t;
    const d = await tab.eval(`(() => { const a = delivery.launcher.assets; return { timing: delivery.timing, events: delivery.events, client: a.stats,
      fetched: a.stats.fetched.map((f) => f.path), progressSamples: delivery.progress.length, lastProgress: delivery.progress.at(-1), sw: delivery.sw,
      sand: delivery.app.state().sand, base: delivery.base, baseFrom: delivery.baseFrom, version: a.catalog.version, required: a.required(), errors: delivery.errors }; })()`);
    const s = await stats();
    results.first = { wallMsToRunning: wall, timing: d.timing, version: d.version, base: d.base, baseFrom: d.baseFrom, server: s, clientNetBytes: d.client.netBytes,
      filesFetched: d.fetched, required: d.required, progressSamples: d.progressSamples, lastProgress: d.lastProgress, events: d.events, serviceWorker: d.sw };
    check(d.fetched.length === 6 && d.required.every((p) => d.fetched.includes(p)) && !d.fetched.includes('textures/sand.rgba'),
      'first start: exactly the 6 required files are downloaded; the sand group is not', d.fetched.join(', '));
    check(d.client.netBytes === Object.values(s.perFile).reduce((n, f) => n + f.bytes, 0) && s.pointer.requests === 1 && s.manifest.requests === 1,
      'first start: bytes on the wire = bytes written; 1 latest.json + 1 manifest', `${d.client.netBytes} bytes in ${wall} ms (prepare ${d.timing.prepareMs} ms)`);
    check(d.progressSamples > 3 && d.lastProgress.loaded === d.lastProgress.total && d.lastProgress.done === 6, 'first start: overall and per-file progress reported', `${d.progressSamples} progress events, last ${JSON.stringify(d.lastProgress)}`);
    check(d.sw, 'first start: the shell service worker is registered');
    const c = await csp();
    check(!c.length, 'first start: no CSP violation (site _headers, COEP require-corp, CORS fetches to the stand-in)', c.join(' | '));
    await sleep(500);
    await tab.screenshot(join(SHOTS, '1-first-start.png'));
  }

  // ---- on-demand group --------------------------------------------------------------------------------
  if (want('group')) {
    if (!await tab.eval("window.delivery?.phase === 'running'").catch(() => false)) { await tab.navigate(RUNNER()); await running(); }
    await statsReset();
    const before = await tab.eval('delivery.app.state().sand');
    await tab.eval('delivery.app.place(-40, 150, 0), delivery.app.setInput(0.6, 0), 1');
    await tab.waitFor('delivery.app.state().sand.ready', { timeout: 30000 });
    const g = await tab.eval('({ sand: delivery.app.state().sand, groups: delivery.groups ?? null })');
    const s = await stats();
    results.group = { requestedBefore: before.requested, group: g.sand.group, ms: Math.round(g.sand.at - g.sand.requestedAt), groupEvents: g.groups, server: s };
    check(!before.requested && g.sand.group === 'sand' && Object.keys(s.perFile).join() === 'textures/sand.rgba' && s.pointer.requests === 0,
      'on demand: the sand group is fetched the first time the car nears it, and only it', `${s.objects.bytes} bytes in ${results.group.ms} ms`);
    await tab.eval('delivery.app.setInput(null), 1');
    await sleep(400);
    await tab.screenshot(join(SHOTS, '2-sand-group.png'));
  }

  // ---- relaunch from cache ----------------------------------------------------------------------------
  if (want('relaunch')) {
    await statsReset();
    const t = Date.now();
    await tab.navigate(RUNNER());
    await running();
    const wall = Date.now() - t;
    const d = await tab.eval('({ client: delivery.launcher.assets.stats, timing: delivery.timing, controlled: !!navigator.serviceWorker.controller, unchanged: delivery.launcher.assets.unchanged, verify: delivery.verify })');
    await sleep(200);
    const s = await stats();
    results.relaunch = { wallMsToRunning: wall, timing: d.timing, server: s, clientNetBytes: d.client.netBytes, fetched: d.client.fetched, fromStore: d.client.fromStore,
      swControlled: d.controlled, manifestUnchanged: d.unchanged, verify: { ok: d.verify.ok.length, missing: d.verify.missing, bad: d.verify.bad, hashedBytes: d.verify.hashedBytes, ms: d.verify.ms } };
    check(d.client.netBytes === 0 && d.client.fetched.length === 0 && s.objects.requests === 0 && s.manifest.requests === 0,
      'relaunch: 0 file downloads, 0 manifest fetches (latest.json only, unchanged version)', `${s.totalBodyBytes} bytes total (latest.json ${s.pointer.bytes}); running after ${wall} ms`);
    check(d.controlled, 'relaunch: the page is served by its service worker');
  }

  // ---- offline -----------------------------------------------------------------------------------------
  if (want('offline')) {
    await bucket.close(); bucket = null;
    await site.close(); site = null;
    const t = Date.now();
    await tab.navigate(RUNNER());
    await running();
    const wall = Date.now() - t;
    const d = await tab.eval('({ offline: delivery.launcher.assets.offline, client: delivery.launcher.assets.stats, controlled: !!navigator.serviceWorker.controller, state: document.getElementById("tt-state").textContent })');
    results.offline = { bothServersStopped: true, wallMsToRunning: wall, offline: d.offline, clientNetBytes: d.client.netBytes, fromStore: d.client.fromStore, controlled: d.controlled, state: d.state };
    check(d.offline && d.client.netBytes === 0 && d.controlled && /offline/.test(d.state), 'offline: site and asset server stopped; the page (service worker) and the files (OPFS) start the title', `${wall} ms, "${d.state}"`);
    await tab.screenshot(join(SHOTS, '3-offline.png'));
    await startBucket(); await startSiteSrv();
  }

  // A fresh namespace in a page of the site, with the site's copy of the client.
  const fresh = (ns, path, { setup = '', retries = 6, keep = false } = {}) => tab.eval(`(async () => {
    const { AssetManager, HttpBackend } = await import('/test-title/lib/assets.js');
    const m = new AssetManager({ ns: '${ns}', backend: new HttpBackend({ base: '${ASSETS}/games/boxquad/', retries: ${retries} }) });
    ${keep ? '' : 'await m.forget();'} await m.open(); await m.verifyStore(); ${setup}
    const t = performance.now();
    try { await m.get('${path}'); } catch (e) { m.close(); return { error: { code: e.code, message: e.message }, stats: m.stats }; }
    const f = await m.get('${path}'); const ms = Math.round(performance.now() - t);
    const sum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ok = sum === m.entry('${path}').sha256; m.close();
    return { ms, ok, size: f.size, stats: m.stats };
  })()`, { timeout: 120000 });

  // ---- resume -------------------------------------------------------------------------------------------
  if (want('resume')) {
    await tab.navigate(`${SITE_URL}/index.html`);
    const out = {};
    const path = 'textures/grass.rgba';
    for (const [label, after] of [['one cut at 400000 bytes', '400000'], ['two cuts (900000, then 500000 bytes into the resumed range)', '900000,500000']]) {
      await statsReset();
      await hook(`cut?path=${encodeURIComponent(path)}&after=${after}`);
      const r = await fresh(`resume-${Object.keys(out).length}`, path);
      const s = await stats();
      const f = r.stats.fetched[0] ?? {};
      const rr = s.perFile[path]?.ranged ?? [];
      // wireLostBytes: sent by the server before the cut but never handed to the page by the browser
      // (its socket buffers die with the connection); the downloader asks again from the last byte it got.
      out[label] = { ok: r.ok, ms: r.ms, error: r.error, attempts: f.attempts, rangesFrom: f.ranges, identityBytesWritten: f.net, fileSize: r.size, clientResent: f.resent,
        wireBytes: s.perFile[path]?.bytes, wireLostBytes: (s.perFile[path]?.bytes ?? 0) - r.size, requests: s.perFile[path]?.statuses };
      check(r.ok && f.ranges.length === after.split(',').length + 1 && f.net === r.size && f.resent === 0,
        `resume (${label}): Range requests continue from the last byte received; every byte written once`, out[label]);
    }
    // across page loads: the first manager gives up (retries 0) and keeps its .part; a new one resumes from it
    await statsReset();
    await hook(`cut?path=${encodeURIComponent(path)}&after=2500000`);
    const a = await fresh('resume-pages', path, { retries: 0 });
    await tab.navigate(`${SITE_URL}/index.html`);
    const partBytes = await tab.eval(`(async () => { const d = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('delivery')).getDirectoryHandle('resume-pages')).getDirectoryHandle('blobs');
      const out = {}; for await (const [n, h] of d.entries()) out[n.slice(0, 8) + n.slice(64)] = (await h.getFile()).size; return out; })()`);
    const b = await fresh('resume-pages', path, { keep: true });
    const s = await stats();
    const f = b.stats.fetched[0] ?? {};
    out['across page loads'] = { first: a.error, keptAfterFirst: partBytes, second: { ok: b.ok, resumedFrom: f.resumedFrom, net: f.net, ranges: f.ranges, scrub: b.stats.scrub },
      requests: s.perFile[path]?.statuses, wireBytes: s.perFile[path]?.bytes, fileSize: b.size, wireLostBytes: (s.perFile[path]?.bytes ?? 0) - b.size };
    const kept = Object.entries(partBytes).find(([n]) => n.endsWith('.part'))?.[1] ?? 0;
    check(a.error?.code === 'network' && /are kept in this browser/.test(a.error.message) && kept > 0 && b.ok && f.resumedFrom === kept && f.net === b.size - kept && f.ranges[0] === kept,
      'resume across page loads: the first page gives up and keeps its .part; a new page continues from it with Range', out['across page loads']);
    results.resume = out;
  }

  // ---- corrupted in transfer -------------------------------------------------------------------------------
  if (want('transfer')) {
    const out = {};
    for (const [label, path, count, expectOk] of [['chunked file, corrupt once', 'textures/dirt.rgba', 1, true], ['whole-file check, corrupt once', 'meshes/quad.bin', 1, true],
      ['corrupt every time', 'meshes/track.bin', 10, false]]) {
      await statsReset();
      await hook(`corrupt?path=${encodeURIComponent(path)}&count=${count}`);
      const r = await fresh(`corrupt-${Object.keys(out).length}`, path);
      await hook('clear');
      const s = await stats();
      const f = r.stats.fetched[0] ?? {};
      out[label] = { ok: r.ok ?? false, error: r.error, hashRetries: f.hashRetries, resentBytes: f.resent, attempts: f.attempts, requests: s.perFile[path]?.statuses, wireBytes: s.perFile[path]?.bytes };
      check(expectOk ? r.ok && f.hashRetries === 1 : r.error?.code === 'hash', `in transfer (${label}): ${expectOk ? 'detected, fetched again, stored good' : "a clear 'hash' error, nothing stored"}`, out[label]);
    }
    const left = await tab.eval(`(async () => { const d = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('delivery')).getDirectoryHandle('corrupt-2')).getDirectoryHandle('blobs');
      const out = []; for await (const [n] of d.entries()) out.push(n); return out; })()`).catch((e) => [`(${e.message})`]);
    check(!left.some((n) => /^[0-9a-f]{64}$/.test(n)), "in transfer: the always-corrupt file never becomes a stored file", left.join(', ') || '(empty)');
    results.transfer = out;
  }

  // ---- corrupted in the cache --------------------------------------------------------------------------------
  if (want('cache')) {
    await tab.navigate(RUNNER()); await running();
    const grass = await entry('textures/grass.rgba');
    await tab.navigate(`${SITE_URL}/index.html`);
    // flip one byte of the stored grass texture (as a disk error or another program would)
    await tab.eval(`(async () => { const d = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('delivery')).getDirectoryHandle('boxquad')).getDirectoryHandle('blobs');
      const f = await (await d.getFileHandle('${grass.sha256}')).getFile(); const b = new Uint8Array(await f.slice(123456, 123457).arrayBuffer());
      const w = await (await d.getFileHandle('${grass.sha256}')).createWritable({ keepExistingData: true }); await w.seek(123456); await w.write(new Uint8Array([b[0] ^ 0xff])); await w.close(); return 1; })()`);
    await statsReset();
    await tab.navigate(RUNNER()); await running();
    const d = await tab.eval('({ verify: delivery.verify, fetched: delivery.launcher.assets.stats.fetched })');
    const s = await stats();
    results.cache = { verify: { ok: d.verify.ok.length, bad: d.verify.bad, missing: d.verify.missing, hashedBytes: d.verify.hashedBytes, ms: d.verify.ms }, fetched: d.fetched, server: s.perFile };
    check(d.verify.bad.length === 1 && d.verify.bad[0] === 'textures/grass.rgba' && d.fetched.length === 1 && d.fetched[0].path === 'textures/grass.rgba' && d.fetched[0].net === grass.size,
      'in the cache: the changed file is found at start (its mark no longer matches, hashed again, wrong), deleted and fetched again; nothing else', results.cache.verify);
  }

  // ---- leftovers ------------------------------------------------------------------------------------------------
  if (want('parts')) {
    await tab.navigate(RUNNER()); await running();
    const dirt = await entry('textures/dirt.rgba');
    const grass = await entry('textures/grass.rgba');
    const sand = await entry('textures/sand.rgba');
    await tab.navigate(`${SITE_URL}/index.html`);
    const unknown = 'ab'.repeat(32);
    const made = await tab.eval(`(async () => {
      const d = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('delivery')).getDirectoryHandle('boxquad')).getDirectoryHandle('blobs');
      const put = async (n, bytes) => { const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(bytes); await w.close(); };
      for (const s of ['${dirt.sha256}', '${grass.sha256}']) { await d.removeEntry(s); await d.removeEntry(s + '.ok'); }
      const ptr = await fetch('${ASSETS}/games/boxquad/latest.json', { cache: 'no-store' }).then((r) => r.json());
      const first = async (p) => new Uint8Array(await (await fetch('${ASSETS}/games/boxquad/' + ptr.manifest.replace('manifest.json', p), { headers: { range: 'bytes=0-1048575' } })).arrayBuffer());
      // grass: a good first chunk, a bad second one, 100 more bytes: cut back to 1 MiB, then resumed
      await put('${grass.sha256}.part', new Blob([await first('textures/grass.rgba'), new Uint8Array(1048576).fill(9), new Uint8Array(100)]));
      // dirt: a good first chunk + 8 junk bytes of the unfinished second: kept, caught when the chunk completes, fetched again
      await put('${dirt.sha256}.part', new Blob([await first('textures/dirt.rgba'), new Uint8Array(8).fill(7)]));
      await put('${sand.sha256}.part', new Uint8Array(1500000).fill(1));              // the file is already stored: removed
      await put('${unknown}.part', new Uint8Array(1000));                              // not in the catalog: removed
      await put('${unknown}.part.json', '{}');                                         // its record: removed
      await put('${dirt.sha256}.part.crswap', new Uint8Array(10));                     // a swap file left by a crash: removed
      await put('${'cd'.repeat(32)}.ok', '{}');                                        // a mark without its file: removed
      await put('notes.tmp', 'x');                                                     // an unknown name: removed
      const out = []; for await (const [n] of d.entries()) out.push(n); return out.length; })()`, { timeout: 60000 });
    await statsReset();
    await tab.navigate(RUNNER()); await running();
    const d = await tab.eval('({ scrub: delivery.verify.scrub, fetched: delivery.launcher.assets.stats.fetched })');
    const after = await opfsBlobs();
    const s = await stats();
    const fd = d.fetched.find((x) => x.path === 'textures/dirt.rgba') ?? {}, fg = d.fetched.find((x) => x.path === 'textures/grass.rgba') ?? {};
    const pick = (x) => ({ resumedFrom: x.resumedFrom, net: x.net, ranges: x.ranges, hashRetries: x.hashRetries, resent: x.resent });
    results.parts = { leftoversMade: made, scrub: d.scrub, grassFetch: pick(fg), dirtFetch: pick(fd), server: s.perFile, after: Object.keys(after).filter((n) => !/^[0-9a-f]{64}(\.ok)?$/.test(n)) };
    check(d.scrub.removed.length === 5 && results.parts.after.length === 0, '.part clean-up at start: stray .part, records, swap files, marks without files and unknown names are gone', d.scrub.removed);
    check(d.scrub.truncated.length === 1 && d.scrub.truncated[0].to === 1048576 && fg.resumedFrom === 1048576 && fg.net === grass.size - 1048576,
      '.part clean-up: a .part with a bad chunk is cut back to its last good chunk and resumed from there', results.parts.grassFetch);
    check(fd.resumedFrom === 1048584 && fd.hashRetries === 1 && fd.net === 8 + (dirt.size - 1048576),
      '.part clean-up: unchecked bytes of an unfinished chunk are caught when the chunk completes, and only that chunk is fetched again', results.parts.dirtFetch);
  }

  // ---- ?verify=full ----------------------------------------------------------------------------------------------
  if (want('full')) {
    await statsReset();
    await tab.navigate(RUNNER('&verify=full')); await running();
    const v = await tab.eval('({ ok: delivery.verify.ok.length, bad: delivery.verify.bad, hashedBytes: delivery.verify.hashedBytes, ms: delivery.verify.ms })');
    const s = await stats();
    results.full = { verify: v, objectBytes: s.objects.bytes };
    check(v.ok === 7 && !v.bad.length && v.hashedBytes > 7000000 && s.objects.bytes === 0, '?verify=full: every stored file hashed again (streaming), all good, nothing fetched', v);
    await tab.screenshot(join(SHOTS, '4-running.png'));
  }

  // ---- a second title (Orbit): added with a profile and its build only ------------------------------------------
  if (want('orbit')) {
    await statsReset();
    const t = Date.now();
    await tab.navigate(RUNNER('&game=orbit'));
    await running();
    const wall = Date.now() - t;
    const d = await tab.eval(`(() => { const a = delivery.launcher.assets; return { game: delivery.game, titleBase: delivery.titleBase, version: a.catalog.version,
      fetched: a.stats.fetched.map((f) => f.path), netBytes: a.stats.netBytes, required: a.required(), name: document.getElementById('tt-name').textContent }; })()`);
    const s1 = await stats();
    check(d.game === 'orbit' && d.titleBase === `${ASSETS}/games/orbit/` && d.fetched.length === 3 && d.required.every((p) => d.fetched.includes(p)) && !d.fetched.includes('sky/stars.bin'),
      'orbit: first start from games/orbit/ (its profile: 3 required files, the sky group not yet)', `${d.name} ${d.version}: ${d.fetched.join(', ')}; ${d.netBytes} bytes, running after ${wall} ms`);
    await tab.waitFor("window.delivery.app.state().sky.state === 'ready'", { timeout: 15000 });
    const g = await tab.eval('delivery.groups');
    check(g?.[0]?.name === 'sky' && g[0].fetched === 1, 'orbit: its on-demand group (sky) is fetched on first use', g);
    await statsReset();
    const t2 = Date.now();
    await tab.navigate(RUNNER('&game=orbit'));
    await running();
    const s2 = await stats();
    const f2 = await tab.eval('delivery.launcher.assets.stats.fetched.length');
    check(f2 === 0 && s2.objects.requests === 0 && s2.manifest.requests === 0, 'orbit: relaunch downloads nothing (latest.json only)', `${s2.totalBodyBytes} bytes, running after ${Date.now() - t2} ms`);
    results.orbit = { first: { wallMs: wall, ...d, server: s1.objects }, relaunch: { bytes: s2.totalBodyBytes } };
    await tab.screenshot(join(SHOTS, '5-orbit.png'));
  }

  // ---- the move to games/boxquad/: the old root layout first (fallback), then the prefix --------------------------
  // Only while a profile still has a fallback (the move is done for Box Quad: its profile has none now).
  const bqFallback = JSON.parse(readFileSync(join(ROOT, 'profiles', 'boxquad.json'), 'utf8')).remote?.fallbackPrefix === '';
  if (want('transition') && !bqFallback) log('skip transition: profiles/boxquad.json has no fallbackPrefix (the root copies are gone)');
  if (want('transition') && bqFallback) {
    // a bucket with Box Quad at the root only (as before the move)
    const OUTR = join(ROOT, '.test', 'r2e2e-root');
    rmSync(OUTR, { recursive: true, force: true });
    cpSync(join(OUT, 'r2', 'games', 'boxquad'), join(OUTR, 'r2'), { recursive: true });
    const plan = JSON.parse(readFileSync(join(OUT, 'r2-upload-plan.json'), 'utf8'));
    plan.objects = plan.objects.filter((o) => o.title === 'boxquad').map((o) => ({ ...o, key: o.key.slice('games/boxquad/'.length), file: `r2/${o.key.slice('games/boxquad/'.length)}` }));
    writeFileSync(join(OUTR, 'r2-upload-plan.json'), JSON.stringify(plan));
    await bucket.close();
    bucket = await createAssetServer({ port: ASSET_PORT, bucketDir: join(OUTR, 'r2'), testHooks: true, rateRps: 0, bucketCorsOrigins: [SITE_URL] }, {});
    await tab.navigate(`${SITE_URL}/index.html`);
    await tab.eval(`(async () => { await (await (await navigator.storage.getDirectory()).getDirectoryHandle('delivery')).removeEntry('boxquad', { recursive: true }).catch(() => {}); return 1; })()`);
    await statsReset();
    await tab.navigate(RUNNER()); await running();
    const a = await tab.eval('({ fallback: delivery.launcher.assets.backend.usedFallback, version: delivery.launcher.assets.catalog.version, fetched: delivery.launcher.assets.stats.fetched.length })');
    const sa = await stats();
    check(a.fallback && a.fetched === 6 && sa.missing?.requests !== 0, 'transition: games/boxquad/latest.json not there yet -> the profile\'s fallback reads the root\'s latest.json', a);
    // the prefixed bucket (the same version, re-published under games/boxquad/): the next start moves over with no file download
    await bucket.close();
    await startBucket();
    await statsReset();
    await tab.navigate(RUNNER()); await running();
    const b = await tab.eval('({ fallback: delivery.launcher.assets.backend.usedFallback, version: delivery.launcher.assets.catalog.version, fetched: delivery.launcher.assets.stats.fetched.length })');
    const sb = await stats();
    const base = await tab.eval("delivery.launcher.assets.catalog.base");
    check(!b.fallback && b.version === a.version && b.fetched === 0 && sb.objects.requests === 0 && base === `${ASSETS}/games/boxquad/v/${b.version}/manifest.json`,
      'transition: once games/boxquad/ is there, the same version is read from it (its manifest; the HTTP cache may answer, it is immutable): 0 file downloads',
      { ...b, base, manifestRequests: sb.manifest.requests, bytes: sb.totalBodyBytes });
    results.transition = { root: a, prefixed: b };
  }

  // ---- two versions, then a rollback (upload-r2.mjs --rollback --title boxquad --dry-run writes the pointer) ------
  if (want('rollback')) {
    const OUT2 = join(ROOT, '.test', 'r2e2e-out2'), OUTM = join(ROOT, '.test', 'r2e2e-merged');
    log(`pipeline (variant 2, a release differing from the profile's own): ${execFileSync(process.execPath, [join(ROOT, 'pipeline', 'build.mjs'), '--out', OUT2, '--no-site', '--variant', '2'], { encoding: 'utf8' }).trim().split('\n').at(-2)}`);
    const p1 = JSON.parse(readFileSync(join(OUT, 'r2-upload-plan.json'), 'utf8')), p2 = JSON.parse(readFileSync(join(OUT2, 'r2-upload-plan.json'), 'utf8'));
    const v1 = p1.titles.find((t) => t.id === 'boxquad').version, v2 = p2.titles.find((t) => t.id === 'boxquad').version;
    // the bucket after a second release: both versions kept, latest.json -> v2
    rmSync(OUTM, { recursive: true, force: true });
    cpSync(join(OUT, 'r2'), join(OUTM, 'r2'), { recursive: true });
    cpSync(join(OUT2, 'r2', 'games', 'boxquad', 'v', v2), join(OUTM, 'r2', 'games', 'boxquad', 'v', v2), { recursive: true });
    cpSync(join(OUT2, 'r2', 'games', 'boxquad', 'latest.json'), join(OUTM, 'r2', 'games', 'boxquad', 'latest.json'));
    const objs = [...p1.objects.filter((o) => o.key !== 'games/boxquad/latest.json'), ...p2.objects.filter((o) => o.title === 'boxquad')];
    const writePlan = () => writeFileSync(join(OUTM, 'r2-upload-plan.json'), JSON.stringify({ ...p1, objects: objs }));
    writePlan();
    await bucket.close();
    bucket = await createAssetServer({ port: ASSET_PORT, bucketDir: join(OUTM, 'r2'), testHooks: true, rateRps: 0, bucketCorsOrigins: [SITE_URL] }, {});
    await statsReset();
    await tab.navigate(RUNNER()); await running();
    const a = await tab.eval('({ version: delivery.launcher.assets.catalog.version, fetched: delivery.launcher.assets.stats.fetched.map((f) => f.path) })');
    check(a.version === v2 && a.fetched.length === 1 && a.fetched[0] === 'textures/dirt.rgba', `rollback: a second release (${v2}) is picked up: only its one changed file is downloaded`, a);
    // roll back: the pointer upload-r2.mjs would put, then the client follows it
    const rb = execFileSync(process.execPath, [join(ROOT, 'pipeline', 'upload-r2.mjs'), '--out', OUTM, '--rollback', v1, '--title', 'boxquad', '--from', join(OUTM, 'r2'), '--dry-run'], { encoding: 'utf8' });
    const ptr = readFileSync(join(OUTM, 'rollback', 'boxquad', 'latest.json'));
    writeFileSync(join(OUTM, 'r2', 'games', 'boxquad', 'latest.json'), ptr);
    const lo = objs.find((o) => o.key === 'games/boxquad/latest.json');
    Object.assign(lo, { size: ptr.length, sha256: createHash('sha256').update(ptr).digest('hex') });
    writePlan();
    await statsReset();
    await tab.navigate(RUNNER()); await running();
    const b = await tab.eval('({ version: delivery.launcher.assets.catalog.version, fetched: delivery.launcher.assets.stats.fetched.map((f) => f.path) })');
    const s = await stats();
    check(b.version === v1 && s.pointer.requests === 1 && b.fetched.length <= 1, `rollback: upload-r2.mjs --rollback ${v1} --title boxquad puts games/boxquad/latest.json back; the client follows it`,
      { ...b, command: rb.trim().split('\n').at(-1).slice(0, 110), bytes: s.totalBodyBytes });
    results.rollback = { v1, v2, release: a, rolledBack: b };
    await bucket.close();
    await startBucket();
  }
} catch (e) {
  check(false, `stopped: ${e.stack ?? e.message}${e.cause ? ` (cause: ${e.cause.code ?? ""} ${e.cause.message ?? e.cause})` : ""}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  stray();
  await bucket?.close(); await site?.close();
  if (!argv.includes('--keep-profile')) { for (let i = 0; i < 20 && existsSync(PROFILE); i++) { try { rmSync(PROFILE, { recursive: true, force: true }); } catch { await sleep(300); } } }
}
const fails = results.checks.filter((c) => !c.ok).length;
results.summary = `${results.checks.length - fails} passed, ${fails} failed`;
writeFileSync(join(RES, 'results.json'), JSON.stringify(results, null, 1) + '\n');
log(results.summary);
process.exit(fails ? 1 : 0);
