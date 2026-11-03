// Drive the page's "Choose your ATV 2 game folder" import in headless Edge.
//
//   node web/tools/import.mjs <game folder> --profile <dir> [--port 8470] [--skip-movies]
//        [--forget] [--expect-error] [--check-handle] [--stop-after MB] [--out dir]
//
// Starts web/host/serve.mjs WITHOUT --game (no /data/: the server has no game
// data), opens the page with a kept browser profile (OPFS lives there, per
// origin, so later runs use the same --profile and --port: boot.mjs/race.mjs
// --opfs), and hands <game folder> to the page's <input webkitdirectory>
// fallback with DOM.setFileInputFiles (a real directory picker cannot be
// clicked headless). Then it follows atv.loader (validation, import progress,
// MB/s) until the import is done or fails.
//   --forget        open with ?forget=1 first (a fresh import)
//   --expect-error  the folder must be rejected and nothing may be imported
//   --check-handle  afterwards, run the showDirectoryPicker code path
//                   (scanHandle + validate) over the imported OPFS folder
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const folder = argv[0] && !argv[0].startsWith('--') ? resolve(argv[0]) : null;
if (!folder || !opt('--profile')) { console.log('usage: import.mjs <game folder> --profile <dir> [--port n] ...'); process.exit(2); }
const port = Number(opt('--port', 8470));
const out = resolve(opt('--out', join(ROOT, 'build-wasm')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-import.log')],
  { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const qs = new URLSearchParams({ dev: '0', env: 'RECOMP_SKIP_MOVIES=1' });
if (argv.includes('--forget')) qs.set('forget', '1');
const b = await launch(`http://127.0.0.1:${port}/host/index.html?${qs}`, { profile: opt('--profile') });
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const loader = () => b.eval('JSON.parse(JSON.stringify(atv.loader))');
const opfsList = () => b.eval(`(async () => { const r = await navigator.storage.getDirectory(); const out = [];
  const walk = async (d, p) => { for await (const h of d.values()) { if (h.kind === 'directory') await walk(h, p + h.name + '/');
    else out.push([p + h.name, (await h.getFile()).size]); } };
  try { await walk(await r.getDirectoryHandle('atv2-game'), ''); } catch { return null; } return out; })()`);
let code = 1;
try {
  let st;
  for (let i = 0; i < 300; i++) {
    st = await loader();
    if (st.phase !== 'idle') break;
    await sleep(100);
  }
  console.log(`${el()} loader: ${st.phase}${st.phase === 'ready' ? ' (already imported; --forget for a fresh import)' : ''}`);
  if (st.phase === 'waiting') {
    if (argv.includes('--skip-movies')) await b.eval(`document.getElementById('skipmovies').checked = true`);
    const doc = await b.send('DOM.getDocument', { depth: 0 });
    const q = await b.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#gamedir' });
    const r = await b.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [folder] });
    if (r.error) throw new Error(`setFileInputFiles: ${r.error.message}`);
    let lastP = '';
    for (;;) {
      await sleep(500);
      st = await loader();
      const p = st.progress;
      const line = p ? `${p.file}/${p.files} files, ${(p.done / 1048576).toFixed(0)}/${(p.total / 1048576).toFixed(0)} MB, ${p.mbps.toFixed(0)} MB/s, ${p.path}` : '';
      if (line && line !== lastP && st.phase === 'importing') { console.log(`${el()} ${line}`); lastP = line; }
      // --stop-after MB: close the browser mid-import (the resume check: the next run skips what is there).
      if (p && opt('--stop-after') && p.done >= Number(opt('--stop-after')) * 1048576) { console.log(`${el()} stopping the browser mid-import`); code = 0; break; }
      if (st.phase === 'error') {
        console.log(`${el()} REJECTED: ${st.error}`);
        const files = await opfsList();
        console.log(`${el()} OPFS atv2-game: ${files === null ? 'absent' : `${files.length} files`}`);
        code = argv.includes('--expect-error') && (files === null || files.length === 0) ? 0 : 1;
        break;
      }
      if (st.phase === 'done' || st.phase === 'ready') {
        const r2 = st.result;
        console.log(`${el()} IMPORTED ${r2.files} files, ${(r2.bytes / 1048576).toFixed(0)} MB (${(r2.copied / 1048576).toFixed(0)} MB copied, ` +
          `${r2.skipped} already there) in ${r2.secs.toFixed(1)} s = ${r2.mbps.toFixed(0)} MB/s; persistent storage: ${r2.persisted}`);
        code = argv.includes('--expect-error') ? 1 : 0;
        break;
      }
    }
  } else if (st.phase === 'ready') code = argv.includes('--expect-error') ? 1 : 0;
  if (code === 0 && !argv.includes('--expect-error') && !opt('--stop-after')) {
    const files = await opfsList();
    console.log(`${el()} OPFS atv2-game: ${files.length} files, ${(files.reduce((a, f) => a + f[1], 0) / 1048576).toFixed(0)} MB`);
    // The page goes on to boot from OPFS; wait for the I/O worker's mount line.
    for (let i = 0; i < 60; i++) {
      const l = await b.eval(`atv.log.find((l) => l.includes('game folder ('))`);
      if (l) { console.log(`${el()} ${l}`); break; }
      await sleep(500);
    }
    if (argv.includes('--check-handle')) {
      const h = await b.eval(`import('/host/loader.js').then(async (m) => {
        const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('atv2-game');
        const e = await m.scanHandle(d); return { files: e.length, sha: await m.validate(e) }; })`);
      console.log(`${el()} directory-handle path over the import: ${h.files} files, default.xbe SHA-256 ${h.sha}`);
    }
  }
} catch (e) {
  console.log(`${el()} FAILED: ${e.message}`);
} finally {
  await b.close();
  srv.kill();
}
process.exit(code);
