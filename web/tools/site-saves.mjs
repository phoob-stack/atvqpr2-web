// Check the start page's Saves tab against the saves module (web/host/saves.js)
// in headless Edge: list the profiles, Download backup, delete a profile,
// Restore from .zip, the automatic backups, Delete all. Uses made-up test
// saves (two profiles written into OPFS by this script), never real ones,
// and removes them at the end.
//
//   node web/tools/site-saves.mjs --profile <dir> [--port 8837] [--out dir] [--shots dir] [--overlay <dir>]
//
// --overlay <dir>: serve.mjs --overlay, for trying the saves worker's
// saves.js/zip.js/vfs.js before they are merged (the start page only; the
// game is not started).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('--port', 8837));
const out = resolve(opt('--out', join(ROOT, 'build-wasm/site')));
const shots = resolve(opt('--shots', join(out, 'screens')));
const dl = join(out, 'downloads-saves');
const overlay = opt('--overlay');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(shots, { recursive: true });
rmSync(dl, { recursive: true, force: true });
mkdirSync(dl, { recursive: true });

const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-saves.log'),
  ...(overlay ? ['--overlay', resolve(overlay)] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const b = await launch(`http://127.0.0.1:${port}/#saves`, { profile: opt('--profile') });
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
let fails = 0;
const check = (ok, what) => { console.log(`${el()} ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; return ok; };
const until = async (expr, secs = 10) => {
  for (let i = 0; i < secs * 10; i++) { if (await b.eval(expr).catch(() => false)) return true; await sleep(100); }
  return false;
};
const shot = async (name) => {
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync(join(shots, name), Buffer.from(r.result.data, 'base64'));
  console.log(`${el()} screen ${join(shots, name)}`);
};
const text = () => b.eval(`document.getElementById('saves-body').innerText`);
const btn = (label) => b.eval(`[...document.querySelectorAll('#saves-body button')].find((x) => x.textContent.startsWith(${JSON.stringify(label)}))?.click() ?? 'none'`);
const redraw = async () => { await b.eval(`location.hash = 'play'`); await sleep(200); await b.eval(`location.hash = 'saves'`); await sleep(1200); };

// Two made-up profiles in the game's layout (SaveMeta.xbx holds the name, UTF-16).
const seed = `(async () => {
  const root = await navigator.storage.getDirectory();
  for (const n of ['atv2-saves', 'atv2-saves-backups', 'atv2-saves-incoming']) await root.removeEntry(n, { recursive: true }).catch(() => {});
  const put = async (path, bytes) => {
    let d = root; const parts = path.split('/');
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(bytes); await w.close();
  };
  const u16 = (s) => { const a = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { a[2 * i] = s.charCodeAt(i); } return a; };
  for (const [dir, name] of [['A1B2C3D4E5F6', 'TEST RIDER ONE'], ['0F0E0D0C0B0A', 'TEST RIDER TWO']]) {
    await put('atv2-saves/UDATA/4143000a/' + dir + '/SaveMeta.xbx', u16('\\uFEFFName=' + name + '\\r\\n'));
    await put('atv2-saves/UDATA/4143000a/' + dir + '/profile.dat', new Uint8Array(2048).fill(7));
  }
  await put('atv2-saves/TDATA/4143000a/settings.dat', new Uint8Array(64).fill(1));
  return true; })()`;

try {
  await b.send('Page.enable');
  await b.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(`document.body.classList.contains('mode-home')`);
  check(await b.eval(seed), 'test saves written');
  await redraw();
  check(await until(`!document.querySelector('#saves-body .notice')?.textContent.includes('this session only')`, 5), 'saves module present');
  let t = await text();
  check(t.includes('TEST RIDER ONE') && t.includes('TEST RIDER TWO'), 'both profiles listed by name');
  await shot('saves-list.png');

  await btn('Download backup');
  await sleep(1500);
  const zips = readdirSync(dl).filter((f) => f.endsWith('.zip'));
  check(zips.length === 1 && statSync(join(dl, zips[0])).size > 1000, `backup downloaded: ${zips[0] ?? 'none'}`);

  // Delete profile two (two clicks).
  const delTwo = `[...document.querySelectorAll('#saves-body tbody tr')].find((r) => r.innerText.includes('TEST RIDER TWO')).querySelector('button').click()`;
  await b.eval(delTwo); await sleep(100); await b.eval(delTwo);
  await sleep(2000);
  const rows = await b.eval(`document.querySelector('#saves-body tbody').innerText`);
  t = await text();
  check(!rows.includes('TEST RIDER TWO') && rows.includes('TEST RIDER ONE'), 'profile two deleted, profile one kept');
  check(/before-delete/.test(t), 'a backup was made before the delete');

  // Restore the zip: both again.
  const doc = await b.send('DOM.getDocument', { depth: -1 });
  const q = await b.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#saves-body input[type=file][accept]' });
  await b.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [join(dl, zips[0])] });
  check(await until(`document.querySelector('#saves-body .set-msg')?.textContent.startsWith('Restored')`, 10), 'restore from .zip: ' +
    await b.eval(`document.querySelector('#saves-body .set-msg')?.textContent`));
  await sleep(1500);
  t = await text();
  check(t.includes('TEST RIDER ONE') && t.includes('TEST RIDER TWO'), 'both profiles back after the restore');
  await shot('saves-restored.png');

  // Delete all.
  await btn('Delete all saves'); await sleep(100); await btn('Click again');
  await sleep(2000);
  t = await text();
  check(!t.includes('TEST RIDER') && /No profiles/.test(t), 'delete all: no profiles left');
  check((await b.eval(`[...document.querySelectorAll('#saves-body ul.backups li')].length`)) >= 2, 'backups listed');
  await shot('saves-empty.png');
} catch (e) {
  console.log(`${el()} FAILED: ${e.stack ?? e.message}`);
  fails++;
} finally {
  await b.eval(`(async () => { const r = await navigator.storage.getDirectory();
    for (const n of ['atv2-saves', 'atv2-saves-backups', 'atv2-saves-incoming']) await r.removeEntry(n, { recursive: true }).catch(() => {}); })()`).catch(() => {});
  await sleep(300);
  await b.close();
  srv.kill();
}
console.log(`${fails ? `${fails} FAILED` : 'all passed'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(fails ? 1 : 0);
