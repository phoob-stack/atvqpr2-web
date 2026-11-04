// site-serve.mjs - the project site on 127.0.0.1 with the headers of its own
// _headers file, as the static host applies them (tests only).
//
//   node test/site-serve.mjs --root <site> [--port 8849] [--connect-extra http://127.0.0.1:8855]
//
// The one change: --connect-extra appends local origins to the CSP's
// connect-src, so a local copy can reach the local R2 stand-in (the real
// _headers allows https://assets.atvqpr2.com; nothing else is altered).
// Prints "site on <url>" when listening.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };

/** _headers -> [{ pattern: RegExp, headers: {} }] (Cloudflare/Netlify form: a path line, then indented "Name: value"). */
export function parseHeaders(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pat = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      cur = { pattern: new RegExp(`^${pat}$`), headers: {} };
      blocks.push(cur);
    } else if (cur) {
      const m = /^\s+([\w-]+):\s*(.*)$/.exec(line);
      if (m) cur.headers[m[1]] = m[2];
    }
  }
  return blocks;
}

export async function startSite({ root, port = 8849, connectExtra = [] }) {
  root = resolve(root);
  const blocks = parseHeaders(readFileSync(join(root, '_headers'), 'utf8'));
  const headersFor = (path) => {
    const h = {};
    for (const b of blocks) if (b.pattern.test(path)) Object.assign(h, b.headers);
    if (connectExtra.length && h['Content-Security-Policy'])
      h['Content-Security-Policy'] = h['Content-Security-Policy'].replace(/connect-src ([^;]*)/, (m, v) => `connect-src ${v} ${connectExtra.join(' ')}`);
    return h;
  };
  const log = [];
  const srv = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    log.push(path);
    try {
      const file = resolve(join(root, path.endsWith('/') ? `${path}index.html` : path));
      if (file !== root && !file.startsWith(root + sep)) throw new Error('outside');
      if (file.split(sep).some((s) => s === '.git')) throw new Error('git');
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, { ...headersFor(path), 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { ...headersFor(path), 'Content-Type': 'text/plain' }); res.end('not found');
    }
  });
  await new Promise((ok, fail) => { srv.once('error', fail); srv.listen(port, '127.0.0.1', ok); });
  return { url: `http://127.0.0.1:${port}`, log, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const s = await startSite({ root: opt('--root'), port: Number(opt('--port', 8849)), connectExtra: argv.flatMap((a, i) => (a === '--connect-extra' ? [argv[i + 1]] : [])) });
  console.log(`site on ${s.url}`);
}
