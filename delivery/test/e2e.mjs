#!/usr/bin/env node
// e2e.mjs - the delivery path end to end in Edge (headless, CDP), with the
// placeholder title only: pipeline -> asset server -> launcher -> OPFS -> run.
//
//   node test/e2e.mjs [--keep] [--only a,b,...]
//
// Local only: everything on 127.0.0.1 (asset server 8853, hub 8854, a second
// asset server as "CDN" 8855, Edge's DevTools 8858), Edge profile in
// .test/edge-profile, output in .test/e2e/ (results.json, screenshots).
// Other workers run Edge/native tests on this PC: times are noisy.
//
// Steps and what they report:
//   first       first load: time to running, bytes on the wire by kind, files fetched
//   ondemand    the sand texture is fetched only when the camera nears the sand zone
//   second      second visit: bytes (only the manifest revalidation, 0 assets)
//   changed     one asset changed (pipeline --variant 1): only that file transfers
//   resume      the server cuts the socket mid-file; the client resumes with Range
//   corrupt     a corrupted body is rejected and refetched (chunked and whole-file), and
//               a file that stays corrupt fails with a clear 'hash' error
//   offline     asset server stopped: the second load runs from OPFS + the service worker
//   local       mode 2: the same title from a picked folder, then again without a pick
//   hub         two tabs see each other's boxes through the free-roam hub
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T = join(ROOT, '.test');
const E = join(T, 'e2e');
const OUT = join(E, 'out');
const SHOTS = join(E, 'shots');
const PROFILE = join(T, 'edge-profile');
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
const want = (s) => !only || only.has(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { date: new Date().toISOString(), note: 'local 127.0.0.1; other Edge/native tests share this PC, so times are noisy' };
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const children = new Set();

function start(name, script, env, ready) {
  const p = spawn(process.execPath, [join(ROOT, script)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p);
  p.on('exit', () => children.delete(p));
  let out = '';
  return new Promise((res, rej) => {
    const on = (d) => { out += d; if (ready.test(out)) res(p); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('exit', (c) => rej(new Error(`${name} exited ${c}: ${out}`)));
    setTimeout(() => rej(new Error(`${name} did not start: ${out}`)), 15000);
  });
}
async function stop(p) {
  if (!p || p.exitCode !== null) return;
  const gone = new Promise((r) => p.once('exit', r));
  try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { p.kill(); }
  await Promise.race([gone, sleep(5000)]);
}
function pipeline(...args) {
  const r = execFileSync(process.execPath, [join(ROOT, 'pipeline/build.mjs'), '--out', OUT, ...args], { encoding: 'utf8' });
  return r.trim().split('\n').at(-2);
}
const SRV = 'http://127.0.0.1:8853';
const hook = async (path) => (await fetch(`${SRV}/__test/${path}`)).json();
const statsReset = () => hook('stats?reset=1');
const stats = async () => {
  const s = await hook('stats');
  const by = (k) => s.byKind[k] ?? { requests: 0, bytes: 0 };
  const objects = s.log.filter((l) => l.kind === 'object');
  const perFile = {};
  for (const l of objects) { const f = (perFile[l.path] ??= { requests: 0, bytes: 0, statuses: [], ranged: [] }); f.requests++; f.bytes += l.bytes; if (l.range) f.ranged.push({ start: Number(l.range.split('-')[0]), bytes: l.bytes }); f.statuses.push(l.status + (l.encoding ? `/${l.encoding}` : '') + (l.range ? ` range ${l.range}` : '') + (l.cut ? ' CUT' : '')); }
  return { totalBodyBytes: s.bodyBytes, manifest: by('manifest'), objects: by('object'), web: by('web'), perFile, manifestStatuses: s.log.filter((l) => l.kind === 'manifest').map((l) => l.status), webStatuses: s.log.filter((l) => l.kind === 'web').map((l) => `${l.path} ${l.status}`) };
};

const SERVER_ENV = { ASSET_DIR: join(OUT, 'assets'), WEB_DIR: join(OUT, 'web'), ASSET_PORT: '8853', ASSET_TEST_HOOKS: '1', ASSET_CSP_CONNECT: 'ws://127.0.0.1:8854' };
let server, hub, browser;
try {
  // ---- setup ------------------------------------------------------------------------
  rmSync(E, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  log(`pipeline: ${pipeline()}`);
  server = await start('asset server', 'server/asset-server.mjs', SERVER_ENV, /asset server on/);
  hub = await start('hub', 'hub/hub.mjs', { HUB_PORT: '8854', HUB_TEST_HOOKS: '1' }, /hub on/);
  browser = await launch({ port: 8858, profile: PROFILE });
  log('servers and Edge up');
  const URL1 = `${SRV}/?autoplay=1&background=0&name=A`;
  const running = (tab) => tab.waitFor(`window.delivery?.phase === 'running' && window.delivery.app?.state().frames > 20`, { timeout: 60000 });
  const errors = (tab) => tab.eval('JSON.stringify(window.delivery?.errors ?? [])');

  // ---- first load ---------------------------------------------------------------------
  let tab;
  if (want('first')) {
    await statsReset();
    const t = Date.now();
    tab = await browser.open(URL1);
    await running(tab);
    const wall = Date.now() - t;
    const d = await tab.eval(`(() => { const a = delivery.launcher.assets; return { timing: delivery.timing, events: delivery.events, client: a.stats,
      fetched: a.stats.fetched.map((f) => f.path), sw: delivery.sw, sandRequested: delivery.app.state().sand.requested }; })()`);
    const s = await stats();
    results.first = { wallMsToRunning: wall, prepareMs: d.timing.prepareMs, playMs: d.timing.playMs, server: s, clientNetBytes: d.client.netBytes,
      filesFetched: d.fetched, sandFetched: d.sandRequested, serviceWorker: d.sw, events: d.events };
    await sleep(800);
    await tab.screenshot(join(SHOTS, '1-first-load.png'));
    log(`first load: running after ${wall} ms (prepare ${d.timing.prepareMs} ms); wire ${s.totalBodyBytes} bytes (objects ${s.objects.bytes}, manifest ${s.manifest.bytes}, web ${s.web.bytes}); identity ${d.client.netBytes}; files ${d.fetched.join(', ')}`);
  }

  // ---- on demand -------------------------------------------------------------------------
  if (want('ondemand')) {
    tab ??= await browser.open(URL1);
    await statsReset();
    const before = await tab.eval('delivery.app.state().sand');
    await tab.eval('delivery.app.place(-40, 150, 0), delivery.app.setInput(0.6, 0), 1');
    await tab.waitFor('delivery.app.state().sand.ready', { timeout: 30000 });
    const sand = await tab.eval('(() => { const s = delivery.app.state().sand; return { ms: Math.round(s.at - s.requestedAt) }; })()');
    const s = await stats();
    results.ondemand = { requestedBeforeApproach: before.requested, fetchMs: sand.ms, server: s };
    await sleep(500);
    await tab.screenshot(join(SHOTS, '2-sand-on-demand.png'));
    await tab.eval('delivery.app.setInput(null), 1');
    log(`on demand: sand not requested before (${!before.requested}); fetched in ${sand.ms} ms, wire ${s.objects.bytes} bytes (${Object.keys(s.perFile).join(', ')})`);
  }

  // ---- second visit -----------------------------------------------------------------------
  if (want('second')) {
    tab ??= await browser.open(URL1);
    await statsReset();
    const t = Date.now();
    await tab.navigate(URL1);
    await running(tab);
    const wall = Date.now() - t;
    const d = await tab.eval('({ client: delivery.launcher.assets.stats, timing: delivery.timing, controlled: !!navigator.serviceWorker.controller })');
    await sleep(300);
    const s = await stats();
    results.second = { wallMsToRunning: wall, prepareMs: d.timing.prepareMs, server: s, clientNetBytes: d.client.netBytes, fromStore: d.client.fromStore,
      fetched: d.client.fetched.map((f) => f.path), swControlled: d.controlled };
    log(`second visit: running after ${wall} ms; wire ${s.totalBodyBytes} bytes total (manifest ${s.manifest.bytes} [${s.manifestStatuses}], objects ${s.objects.bytes}, web ${s.web.bytes} [${s.webStatuses.join('; ')}]); SW controlled ${d.controlled}`);
  }

  // ---- one asset changed -------------------------------------------------------------------
  if (want('changed')) {
    tab ??= await browser.open(URL1);
    log(`pipeline --variant 1: ${pipeline('--variant', '1')}`);
    await statsReset();
    const t = Date.now();
    await tab.navigate(URL1);
    await running(tab);
    const wall = Date.now() - t;
    const d = await tab.eval('({ client: delivery.launcher.assets.stats })');
    await sleep(300);
    const s = await stats();
    results.changed = { wallMsToRunning: wall, server: s, clientNetBytes: d.client.netBytes, fetched: d.client.fetched.map((f) => `${f.path} (${f.net} bytes)`) };
    await tab.screenshot(join(SHOTS, '3-changed-dirt.png'));
    log(`changed asset: wire ${s.totalBodyBytes} bytes (objects ${s.objects.bytes}: ${Object.entries(s.perFile).map(([k, v]) => `${k} ${v.bytes} [${v.statuses}]`).join('; ')}; manifest ${s.manifest.bytes})`);
  }

  // A fresh namespace in the running page, same client code.
  const fresh = (ns, path, setup = '') => tab.eval(`(async () => {
    const { AssetManager, HttpBackend } = await import('/client/assets.js');
    const m = new AssetManager({ ns: '${ns}', backend: new HttpBackend({ manifestUrl: '/assets/manifest.json' }) });
    await m.forget(); await m.open(); ${setup}
    const t = performance.now();
    try { await m.get('${path}'); } catch (e) { m.close(); return { error: { code: e.code, message: e.message }, stats: m.stats }; }
    const f = await m.get('${path}'); const ms = Math.round(performance.now() - t);
    const sum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ok = sum === m.entry('${path}').sha256; await m.forget(); m.close();
    return { ms, ok, size: f.size, stats: m.stats };
  })()`);

  // ---- resume after a cut connection -----------------------------------------------------------
  if (want('resume')) {
    tab ??= await browser.open(URL1);
    const out = {};
    for (const [label, path, after] of [['grass (4 MiB, chunked, brotli on the wire)', 'textures/grass.rgba', 400000], ['grass, cut twice', 'textures/grass.rgba', '900000,500000']]) {
      await statsReset();
      await hook(`cut?path=${encodeURIComponent(path)}&after=${after}`);
      const r = await fresh(`resume-${out ? Object.keys(out).length : 0}`, path);
      const s = await stats();
      const f = r.stats.fetched[0] ?? {};
      out[label] = { ok: r.ok, ms: r.ms, error: r.error, attempts: f.attempts, rangesFrom: f.ranges, identityBytesWritten: f.net, fileSize: r.size,
        // re-sent = identity bytes served by the Range requests beyond what was missing after the first cut
        resentIdentityBytes: (() => { const rr = s.perFile[path]?.ranged ?? []; return rr.length ? rr.reduce((n, x) => n + x.bytes, 0) - (r.size - rr[0].start) : 0; })(),
        firstRequestWireBytes: s.perFile[path]?.bytes - (s.perFile[path]?.ranged ?? []).reduce((n, x) => n + x.bytes, 0), wireBytes: s.perFile[path]?.bytes, requests: s.perFile[path]?.statuses };
    }
    // the clean reference (wire bytes of one uncut download)
    await statsReset();
    const ref = await fresh('resume-ref', 'textures/grass.rgba');
    const rs = await stats();
    out.reference = { ok: ref.ok, wireBytes: rs.perFile['textures/grass.rgba']?.bytes, requests: rs.perFile['textures/grass.rgba']?.statuses, ms: ref.ms };
    results.resume = out;
    for (const [k, v] of Object.entries(out)) log(`resume ${k}: ${JSON.stringify(v)}`);
  }

  // ---- hash mismatch -------------------------------------------------------------------------
  if (want('corrupt')) {
    tab ??= await browser.open(URL1);
    const out = {};
    for (const [label, path, count] of [['chunked file, corrupt once', 'textures/dirt.rgba', 1], ['whole-file check, corrupt once', 'meshes/quad.bin', 1],
      ['corrupt every time', 'meshes/track.bin', 10]]) {
      await statsReset();
      await hook(`corrupt?path=${encodeURIComponent(path)}&count=${count}`);
      const r = await fresh(`corrupt-${Object.keys(out).length}`, path);
      await hook('clear');
      const s = await stats();
      const f = r.stats.fetched[0] ?? {};
      out[label] = { ok: r.ok ?? false, error: r.error, hashRetries: f.hashRetries, resentBytes: f.resent, attempts: f.attempts, requests: s.perFile[path]?.statuses, wireBytes: s.perFile[path]?.bytes };
    }
    results.corrupt = out;
    for (const [k, v] of Object.entries(out)) log(`corrupt ${k}: ${JSON.stringify(v)}`);
  }

  // ---- offline second load -----------------------------------------------------------------------
  if (want('offline')) {
    tab ??= await browser.open(URL1);
    await stop(server); server = null;
    const t = Date.now();
    await tab.navigate(URL1);
    await running(tab);
    const wall = Date.now() - t;
    const d = await tab.eval('({ offline: delivery.launcher.assets.offline, client: delivery.launcher.assets.stats, controlled: !!navigator.serviceWorker.controller, status: document.getElementById("status").textContent })');
    results.offline = { serverStopped: true, wallMsToRunning: wall, offline: d.offline, clientNetBytes: d.client.netBytes, fromStore: d.client.fromStore, swControlled: d.controlled, status: d.status };
    await sleep(500);
    await tab.screenshot(join(SHOTS, '4-offline.png'));
    log(`offline: running after ${wall} ms, offline=${d.offline}, net ${d.client.netBytes} bytes, ${d.client.fromStore} files from OPFS ("${d.status}")`);
    // and the clear error for a file never downloaded
    const never = await tab.eval(`(async () => { const { AssetManager, HttpBackend } = await import('/client/assets.js');
      const m = new AssetManager({ ns: 'never-online', backend: new HttpBackend({ manifestUrl: '/assets/manifest.json' }) });
      try { await m.open(); return 'opened?'; } catch (e) { return { code: e.code, message: e.message }; } finally { m.close(); } })()`);
    results.offline.firstVisitOfflineError = never;
    log(`offline, never visited: ${JSON.stringify(never)}`);
    server = await start('asset server', 'server/asset-server.mjs', SERVER_ENV, /asset server on/);
  }

  // ---- mode 2: local files ---------------------------------------------------------------------
  if (want('local')) {
    tab ??= await browser.open(URL1);
    const folder = join(E, 'picked', 'boxquad-files');
    const { buildTitle } = await import(new URL(`file:///${join(ROOT, 'title/build.mjs').replace(/\\/g, '/')}`).href);
    buildTitle(folder, { variant: 1 });
    await statsReset();
    await tab.navigate(`${SRV}/?background=0&hub=0`);
    await tab.waitFor('window.delivery?.phase === "idle" && !document.getElementById("play").disabled');
    const { root } = await tab.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await tab.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#pick' });
    await tab.send('DOM.setFileInputFiles', { nodeId, files: [folder] });
    await running(tab);
    const d = await tab.eval('({ source: delivery.launcher.assets.backend.kind, ns: delivery.launcher.assets.ns, client: delivery.launcher.assets.stats, files: delivery.launcher.assets.catalog.files.map((f) => f.path) })');
    const s1 = await stats();
    await tab.screenshot(join(SHOTS, '5-local-files.png'));
    await statsReset();
    await tab.navigate(`${SRV}/?source=local&autoplay=1&background=0&hub=0`);
    await running(tab);
    const d2 = await tab.eval('({ source: delivery.launcher.assets.backend.kind, client: delivery.launcher.assets.stats })');
    const s2 = await stats();
    results.local = { picked: { source: d.source, ns: d.ns, files: d.files, stored: d.client.fetched.length, serverObjectBytes: s1.objects.bytes },
      later: { source: d2.source, fromStore: d2.client.fromStore, serverObjectBytes: s2.objects.bytes, fetched: d2.client.fetched.length } };
    log(`local files: picked ${d.files.length} files (${d.client.fetched.length} stored, server object bytes ${s1.objects.bytes}); later visit without a pick: ${d2.client.fromStore} from OPFS, server object bytes ${s2.objects.bytes}`);
  }

  // ---- hub: two tabs -------------------------------------------------------------------------------
  if (want('hub')) {
    tab ??= await browser.open('about:blank');
    await tab.navigate(`${SRV}/?autoplay=1&background=0&name=A`);
    await running(tab);
    const tabB = await browser.open(`${SRV}/?autoplay=1&background=0&name=B`);
    await running(tabB);
    await tab.eval('delivery.app.place(160, 10, 1.57), delivery.app.setInput(0.3, 0), 1');
    await tabB.eval('delivery.app.place(160, -2, 1.57), delivery.app.setInput(0.3, 0), 1');
    const seen = async (t) => t.waitFor('(() => { const h = delivery.app.state().hub; return h?.connected && h.peers.some((p) => p.fresh) ? h : null; })()', { timeout: 20000 });
    const a = await seen(tab), b = await seen(tabB);
    await sleep(1500);
    const a2 = await tab.eval('delivery.app.state()'), b2 = await tabB.eval('delivery.app.state()');
    const hubInfo = await (await fetch('http://127.0.0.1:8854/')).json();
    results.hub = { hubPlayers: hubInfo.players, tabA: { id: a.id, peers: a2.hub.peers, sent: a2.hub.sent, received: a2.hub.received, me: { x: a2.x, y: a2.y } },
      tabB: { id: b.id, peers: b2.hub.peers, sent: b2.hub.sent, received: b2.hub.received, me: { x: b2.x, y: b2.y } } };
    const peerA = a2.hub.peers.find((p) => p.id === b.id), peerB = b2.hub.peers.find((p) => p.id === a.id);
    results.hub.check = { aSeesB: !!peerA?.fresh, bSeesA: !!peerB?.fresh, aViewOfB: peerA && { x: peerA.x, y: peerA.y }, bActual: { x: b2.x, y: b2.y } };
    await tab.screenshot(join(SHOTS, '6-hub-tab-A.png'));
    await tabB.screenshot(join(SHOTS, '7-hub-tab-B.png'));
    log(`hub: A (#${a.id}) sees B: ${results.hub.check.aSeesB}; B (#${b.id}) sees A: ${results.hub.check.bSeesA}; A's view of B ${JSON.stringify(results.hub.check.aViewOfB)} vs B ${JSON.stringify(results.hub.check.bActual)}`);
    await tabB.close();
  }
  // ---- the VPS routes: /demo/ (asset server) and /hub/ (hub) behind one origin -------------------
  // A small reverse proxy on 8855 stands in for Caddy (deploy/Caddyfile), with
  // the output built as for the VPS (--hub-url /hub/), served by a second asset
  // server on 8856.
  if (want('subpath')) {
    const OUT2 = join(E, 'out-deploy');
    execFileSync(process.execPath, [join(ROOT, 'pipeline/build.mjs'), '--out', OUT2, '--hub-url', '/hub/'], { encoding: 'utf8' });
    const srv2 = await start('asset server (deploy build)', 'server/asset-server.mjs', { ASSET_DIR: join(OUT2, 'assets'), WEB_DIR: join(OUT2, 'web'),
      ASSET_PORT: '8856', ASSET_TRUST_PROXY: '1' }, /asset server on/);
    const { createServer, request } = await import('node:http');
    const { connect } = await import('node:net');
    const proxy = createServer((req, res) => {
      if (req.url === '/demo') { res.writeHead(308, { location: '/demo/' }); return res.end(); }
      if (!req.url.startsWith('/demo/')) { res.writeHead(404); return res.end(); }
      const up = request({ host: '127.0.0.1', port: 8856, path: req.url.slice(5), method: req.method,
        headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => res.destroy());
      req.pipe(up);
    });
    proxy.on('upgrade', (req, sock, head) => {
      if (!req.url.startsWith('/hub/')) return sock.destroy();
      const up = connect(8854, '127.0.0.1', () => {
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
        up.write(head); up.pipe(sock); sock.pipe(up);
      });
      up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
    });
    await new Promise((r) => proxy.listen(8855, '127.0.0.1', r));
    try {
      const t2 = await browser.open(`http://127.0.0.1:8855/demo/?autoplay=1&background=0&name=S`);
      await running(t2);
      await t2.waitFor('delivery.app.state().hub?.connected', { timeout: 15000 });
      const d = await t2.eval('(async () => ({ scope: (await navigator.serviceWorker.getRegistration())?.scope, hub: delivery.app.state().hub, files: delivery.launcher.assets.stats.fetched.map((f) => f.path), manifest: delivery.launcher.assets.backend.manifestUrl }))()');
      results.subpath = { manifestUrl: d.manifest, swScope: d.scope, hubConnected: d.hub.connected, hubId: d.hub.id, filesFetched: d.files };
      await t2.screenshot(join(SHOTS, '8-deploy-routes-demo.png'));
      log(`deploy routes: /demo/ runs (manifest ${d.manifest}, SW ${d.scope}), hub via /hub/ connected as #${d.hub.id}`);
      await t2.close();
    } finally { proxy.close(); proxy.closeAllConnections?.(); await stop(srv2); }
  }

  // ---- the progress bar mid-stream (throttled server; screenshot only, not a number) -------------
  if (want('progress')) {
    tab ??= await browser.open(URL1);
    await tab.eval('delivery.launcher.forget().then(() => 1)');
    await hook('throttle?kBps=1500');
    try {
      await tab.navigate(URL1);
      const p = await tab.waitFor(`(() => { const s = document.getElementById('status').textContent; return /\\((2|3|4|5)\\d%\\), now textures\\/grass/.test(s) ? s : null; })()`, { timeout: 30000, every: 50 });
      await tab.screenshot(join(SHOTS, '0-streaming-progress.png'));
      results.progress = { status: p };
      log(`progress screenshot at "${p}"`);
      await running(tab);
    } finally { await hook('clear'); }
  }

  results.pageErrors = tab ? JSON.parse(await errors(tab)) : [];
  results.ok = true;
} catch (e) {
  results.ok = false;
  results.error = e.stack ?? String(e);
  console.error(e);
} finally {
  writeFileSync(join(E, 'results.json'), JSON.stringify(results, null, 1));
  if (browser) await browser.close();
  await stop(server); await stop(hub);
  for (const p of children) await stop(p);
  log(`results: ${join(E, 'results.json')}; ${results.ok ? 'OK' : 'FAILED'}`);
  process.exitCode = results.ok ? 0 : 1;
}
void existsSync;
