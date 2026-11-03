// Minimal headless Edge/Chrome driver over the DevTools protocol, no npm
// packages: Node >= 22 has fetch and WebSocket built in.
//
//   const srv = await serve({ '/': 'web', '/data/': 'captures' });
//   const b = await launch(`${srv.url}/validate.html`);
//   const v = await b.eval('validate(...)');   // awaits promises, returns JSON
//   await b.close();
//
// The browser is the one already on the machine (Edge ships with Windows):
// BROWSER=<path to msedge.exe/chrome.exe> overrides. WebGPU comes from the
// browser's own Dawn; nothing is downloaded.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// A static file server on 127.0.0.1 (a secure context, so WebGPU and module
// scripts work, which file:// does not give). mounts: url prefix -> folder.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wgsl': 'text/plain', '.json': 'application/json' };
export async function serve(mounts) {
  const keys = Object.keys(mounts).sort((a, b) => b.length - a.length);
  const srv = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const k = keys.find((p) => path.startsWith(p));
    const file = k && resolve(mounts[k], '.' + path.slice(k.length - 1));
    if (!file || !file.startsWith(resolve(mounts[k]))) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

export function findBrowser() {
  const b = CANDIDATES.find((p) => existsSync(p));
  if (!b) throw new Error('no Edge/Chrome found; set BROWSER=');
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// profile: a user-data-dir to keep (e.g. OPFS with an imported game folder
// across runs); default a fresh temporary one in build-wasm/profiles/ (not
// %TEMP%: a profile's OPFS gets game data, which stays in this project),
// deleted again on close.
// extraArgs: more browser switches (e.g. --disable-features=WebGPU to check
// the page's feature messages).
// waitReady: false returns as soon as the page target is there (to set up
// injected scripts and then Page.navigate).
export async function launch(url, { port = 9300 + Math.floor(Math.random() * 500), headless = true, profile, extraArgs = [], waitReady = true } = {}) {
  const exe = findBrowser();
  const temp = !profile;
  if (temp) mkdirSync(TEMP_PROFILES, { recursive: true });
  profile = profile ? resolve(profile) : mkdtempSync(join(TEMP_PROFILES, 'tmp-'));
  const args = [
    ...extraArgs,
    headless ? '--headless=new' : '',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--enable-unsafe-webgpu',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    url,
  ].filter(Boolean);
  const proc = spawn(exe, args, { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(100);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.startsWith(url.slice(0, 20)));
    } catch { /* not up yet */ }
  }
  if (!target) { kill(proc); throw new Error('browser did not come up'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  const listeners = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.consoleAPICalled' && !msg.sessionId)
      logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method) for (const f of listeners) f(msg);
  };
  // sessionId: a flattened child session (Target.setAutoAttach flatten:true),
  // e.g. a Worker's, for per-thread profiling.
  const send = (method, params = {}, sessionId) => new Promise((r) => {
    const n = ++id; pending.set(n, r);
    ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params }));
  });
  await send('Runtime.enable');
  // Wait for the page's own `ready` promise.
  for (let i = 0; waitReady && i < 100; i++) {
    const r = await send('Runtime.evaluate', { expression: 'typeof window.ready', returnByValue: true });
    if (r.result?.result?.value === 'object') break;
    await sleep(100);
  }
  return {
    logs, send,
    /** Every protocol event ({ method, params, sessionId? }); returns an unsubscribe. */
    on(f) { listeners.add(f); return () => listeners.delete(f); },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails)
        throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    },
    async close() { try { ws.close(); } catch {} kill(proc); if (temp) await removeProfile(profile); },
    /** Browser.close (the profile is flushed: HTTP cache, wasm code cache),
     *  then the forced kill as a fallback. */
    async closeGracefully(timeoutMs = 15000) {
      try {
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const bws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((r, j) => { bws.onopen = r; bws.onerror = j; });
        bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch { /* already gone */ }
      const exited = new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once('exit', r); });
      await Promise.race([exited, sleep(timeoutMs)]);
      // The launcher process exits early on Windows; wait for the profile lock to go.
      const lock = join(profile, 'lockfile');
      for (let i = 0; i < timeoutMs / 100 && existsSync(lock); i++) {
        try { rmSync(lock); } catch { /* still held */ }
        await sleep(100);
      }
      try { ws.close(); } catch {}
      kill(proc);
      if (temp) await removeProfile(profile);
    },
    profile,
  };
}

const TEMP_PROFILES = resolve(dirname(fileURLToPath(import.meta.url)), '../../build-wasm/profiles');
async function removeProfile(dir) {
  // The browser's processes let go of the files a moment after they exit.
  for (let i = 0; i < 40; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(250); }
  }
}

function kill(proc) {
  // Only the browser we started, and its children.
  try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}
