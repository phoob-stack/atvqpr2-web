// Small shared helpers (copied from builder/lib/util.mjs: walk, toPosix,
// sha256File). Node only, no packages.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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
