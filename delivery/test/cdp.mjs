// cdp.mjs - a minimal Edge driver over the DevTools protocol (no packages;
// adapted from atvrecomp's web/tools/cdp.mjs): one browser, a kept profile,
// any number of tabs on one browser-level connection (flattened sessions).
//
//   const b = await launch({ port: 8858, profile: '.test/edge-profile' });
//   const tab = await b.open('http://127.0.0.1:8853/');
//   await tab.eval('1 + 1');  await tab.screenshot('x.png');
//   await b.close();
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const CANDIDATES = [process.env.BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 8858, profile, headless = true, extraArgs = [] }) {
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('no Edge found; set BROWSER=');
  profile = resolve(profile);
  mkdirSync(profile, { recursive: true });
  const args = [...extraArgs, headless ? '--headless=new' : '', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync',
    // tabs in the background keep running (the hub test drives two tabs at once)
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1100,1000', 'about:blank'].filter(Boolean);
  const proc = spawn(exe, args, { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 150 && !ver; i++) {
    await sleep(100);
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { /* not up yet */ }
  }
  if (!ver) { kill(proc); throw new Error('browser did not come up'); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method) for (const f of listeners) f(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((r, j) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? j(new Error(`${method}: ${msg.error.message}`)) : r(msg.result)));
    ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params }));
  });
  const tabs = [];
  const b = {
    proc, profile, send,
    on(f) { listeners.add(f); return () => listeners.delete(f); },
    async open(url) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const logs = [];
      const off = b.on((m) => {
        if (m.sessionId !== sessionId) return;
        if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
        if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
      });
      await send('Runtime.enable', {}, sessionId);
      await send('Page.enable', {}, sessionId);
      const tab = {
        targetId, sessionId, logs,
        send: (m, p) => send(m, p, sessionId),
        async navigate(u) {
          const loaded = new Promise((r) => { const o = b.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { o(); r(); } }); });
          await send('Page.navigate', { url: u }, sessionId);
          await Promise.race([loaded, sleep(20000)]);
        },
        async eval(expression, { timeout = 60000 } = {}) {
          const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId),
            sleep(timeout).then(() => { throw new Error(`eval timed out: ${expression.slice(0, 80)}`); })]);
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
          return r.result?.value;
        },
        async waitFor(expression, { timeout = 60000, every = 100 } = {}) {
          const t = Date.now();
          for (;;) {
            let v;
            try { v = await tab.eval(expression, { timeout: 10000 }); } catch { v = undefined; }
            if (v) return v;
            if (Date.now() - t > timeout) throw new Error(`timed out waiting for ${expression}\n${logs.slice(-15).join('\n')}`);
            await sleep(every);
          }
        },
        async screenshot(file) {
          const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, Buffer.from(r.data, 'base64'));
          return file;
        },
        async close() { off(); await send('Target.closeTarget', { targetId }).catch(() => {}); },
      };
      tabs.push(tab);
      if (url) await tab.navigate(url);
      return tab;
    },
    async close() {
      try { await send('Browser.close'); } catch { /* gone */ }
      const exited = new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once('exit', r); });
      await Promise.race([exited, sleep(8000)]);
      const lock = join(profile, 'lockfile');
      for (let i = 0; i < 50 && existsSync(lock); i++) { try { rmSync(lock); } catch { /* held */ } await sleep(100); }
      try { ws.close(); } catch { /* closed */ }
      kill(proc);
    },
  };
  return b;
}

function kill(proc) {
  // Only the browser this file started, and its children.
  if (proc.exitCode !== null && proc.signalCode === null) { /* launcher exited; children may live on */ }
  try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
