// run-edge.mjs - run a threaded test module in headless Edge (real Web
// Workers) through web/host/threads.js, on a localhost-only server that
// sends COOP/COEP (SharedArrayBuffer needs a cross-origin isolated page).
//
//   node web/tests/threads/run-edge.mjs [module.wasm] [pool] [ENV=value ...]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tools/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const argv = process.argv.slice(2);
const wasmPath = argv[0] && argv[0].endsWith('.wasm')
  ? path.resolve(argv.shift()) : path.join(root, 'build-wasm/threads/threads_test.wasm');
const pool = argv[0] && /^\d+$/.test(argv[0]) ? +argv.shift() : 8;
const env = Object.fromEntries(argv.filter((a) => a.includes('=')).map((a) => a.split(/=(.*)/s).slice(0, 2)));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm' };
const mounts = { '/build/': path.dirname(wasmPath), '/': path.join(root, 'web') };
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const k = Object.keys(mounts).find((m) => p.startsWith(m));
  const file = path.resolve(mounts[k], '.' + p.slice(k.length - 1));
  if (!file.startsWith(path.resolve(mounts[k]))) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const b = await launch(`${base}/tests/threads/edge.html`);
let code = 1;
try {
  const r = await b.eval(`runTest('/build/${path.basename(wasmPath)}', ${pool}, ${JSON.stringify(env)})`);
  if (r.error) throw new Error(r.error);
  for (const l of r.lines) console.log(l);
  for (const t of r.traps) console.log(`[edge] TRAP ${t.role} slot ${t.slot} tid ${t.tid}: ${t.message}\n${t.stack}`);
  console.log(`[edge] ${r.ua}`);
  console.log(`[edge] exit ${r.code} after ${r.ms} ms (pool of ${pool} up in ${r.poolStartMs} ms,`
    + ` ${r.cores} cores); workers ${JSON.stringify(r.stats)}`);
  code = typeof r.code === 'number' ? r.code : 124;
} catch (e) {
  console.log(`[edge] ${e.message}`);
} finally {
  await b.close();
  srv.close();
}
process.exit(code);
