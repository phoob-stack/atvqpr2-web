// Small shared helpers for the builder: processes, hashing, paths. Node only,
// no packages.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const isWin = process.platform === 'win32';

// The tar that understands Windows paths and .tar.gz/.zip: the one Windows
// ships (bsdtar) rather than Git's GNU tar, which reads "C:" as a host name.
export function tarExe() {
  if (isWin) {
    const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(sys)) return sys;
  }
  return 'tar';
}

export async function sha256File(file) {
  const h = createHash('sha256');
  await new Promise((res, rej) => createReadStream(file).on('data', (c) => h.update(c)).on('end', res).on('error', rej));
  return h.digest('hex');
}

export const toPosix = (p) => p.split(sep).join('/');

// Every file under dir (relative posix paths). Symlinks and junctions are
// listed as themselves and never followed.
export function walk(dir, { skip = () => false } = {}) {
  const out = [];
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = toPosix(relative(dir, p));
      if (skip(rel, e)) continue;
      if (e.isSymbolicLink()) { out.push({ rel, link: true }); continue; }
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push({ rel, size: lstatSync(p).size });
    }
  };
  rec(dir);
  return out;
}

// Run a command; its output goes to the log file (and, with echo, to the
// console line by line through echo(line)). Resolves with the exit code.
export function run(cmd, args, { cwd, env, log, echo } = {}) {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const ws = log ? createWriteStream(log, { flags: 'a' }) : null;
    if (ws) ws.write(`\n$ ${[cmd, ...args].join(' ')}\n  (cwd ${cwd ?? process.cwd()})\n`);
    let tail = '';
    const onData = (c) => {
      ws?.write(c);
      if (!echo) return;
      tail += c.toString();
      let i;
      while ((i = tail.indexOf('\n')) >= 0) { echo(tail.slice(0, i).replace(/\r$/, '')); tail = tail.slice(i + 1); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => { ws?.end(); rejectP(e); });
    p.on('close', (code) => {
      if (echo && tail) echo(tail);
      if (ws) ws.end(() => resolveP(code)); else resolveP(code);
    });
  });
}

// Quick synchronous probe: { ok, out } (stdout+stderr), never throws.
export function probe(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, ...opts });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), status: r.status };
  } catch (e) {
    return { ok: false, out: String(e.message ?? e) };
  }
}

export function ensureDir(d) { mkdirSync(d, { recursive: true }); return d; }

export const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${(s % 60).toFixed(0).padStart(2, '0')} s` : `${s.toFixed(1)} s`);
export const fmtBytes = (n) => (n >= 1 << 30 ? `${(n / 2 ** 30).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
