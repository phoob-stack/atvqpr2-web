#!/usr/bin/env node
// web/tools/sync-delivery.mjs - copy the delivery client (the asset manager,
// its worker, the streaming SHA-256, game profiles) from the delivery
// repository into web/host/delivery/, where the game page's asset source
// (web/host/assetsource.js) uses it. These copies are made only by this
// script: do not edit web/host/delivery/ by hand; change delivery and sync.
//
//   node web/tools/sync-delivery.mjs [--delivery <repo>] [--commit <rev>] [--check]
//        defaults: ../delivery next to this repository's folder (or $DELIVERY_REPO), HEAD
//
// - Files come from git (`git show <rev>:<path>`): only committed bytes of
//   the files in ALLOW. Nothing else of the delivery repository comes in
//   (no pipeline, server, test title or output).
// - Every relative import of a copied file must be a copied file.
// - web/host/delivery/sync.json records the delivery commit and each file's
//   size and SHA-256. --check: change nothing; exit 1 if a sync would differ.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(REPO_ROOT, 'web', 'host', 'delivery');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DELIVERY = resolve(opt('--delivery', process.env.DELIVERY_REPO ?? join(REPO_ROOT, '..', 'delivery')));
const REV = opt('--commit', 'HEAD');
const CHECK = argv.includes('--check');
const die = (m) => { console.error(`sync-delivery: ${m}`); process.exit(1); };
const git = (...a) => execFileSync('git', ['-C', DELIVERY, '-c', 'core.autocrlf=false', ...a], { maxBuffer: 16 << 20 });
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// delivery path -> name under web/host/delivery/. The whole list.
const ALLOW = {
  'client/assets.js': 'assets.js',
  'client/asset-worker.js': 'asset-worker.js',
  'client/sha256.js': 'sha256.js',
  'client/profile.js': 'profile.js',
};
const MAX_FILE = 100 * 1024;

if (!existsSync(join(DELIVERY, '.git'))) die(`${DELIVERY} is not a git repository (pass --delivery)`);
const commit = git('rev-parse', '--verify', `${REV}^{commit}`).toString().trim();
const tracked = new Set(git('ls-tree', '-r', '--name-only', commit, '--', 'client').toString().split('\n').filter(Boolean));
const files = new Map();
for (const [src, dst] of Object.entries(ALLOW)) {
  if (!tracked.has(src)) die(`${src} is in the allow-list but not in delivery ${commit.slice(0, 7)}`);
  const body = git('show', `${commit}:${src}`);
  if (body.length > MAX_FILE) die(`refusing ${src}: ${body.length} bytes (over ${MAX_FILE})`);
  if (body.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) die(`refusing ${src}: a wasm module`);
  files.set(dst, body);
}
const code = (b) => b.toString('utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
for (const [p, body] of files) {
  for (const re of [/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g, /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g]) {
    for (const m of code(body).matchAll(re)) {
      const t = posix.normalize(posix.join(posix.dirname(p), m[1]));
      if (!files.has(t)) die(`${p} imports ${m[1]}, which is not copied`);
    }
  }
}
const record = { comment: 'Written by web/tools/sync-delivery.mjs from the delivery repository (client/). Do not edit these files by hand.',
  delivery: commit, files: [...files].map(([p, b]) => ({ path: p, from: Object.keys(ALLOW).find((k) => ALLOW[k] === p), size: b.length, sha256: sha256(b) })) };
files.set('sync.json', Buffer.from(JSON.stringify(record, null, 1) + '\n'));

// (a checkout with core.autocrlf may have turned LF into CRLF: compared as LF)
const lf = (b) => Buffer.from(b.toString('utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)));
const current = new Map(existsSync(OUT) ? readdirSync(OUT).map((n) => [n, lf(readFileSync(join(OUT, n)))]) : []);
const changed = [...files].filter(([p, b]) => !current.get(p)?.equals(b)).map(([p]) => p);
const extra = [...current.keys()].filter((p) => !files.has(p));
if (CHECK) {
  if (changed.length || extra.length) die(`web/host/delivery differs from delivery ${commit.slice(0, 7)}: ${[...changed, ...extra.map((p) => `${p} (extra)`)].join(', ')}`);
  console.log(`sync-delivery: web/host/delivery matches delivery ${commit.slice(0, 7)}`);
  process.exit(0);
}
if (extra.length) die(`web/host/delivery has files that are not synced: ${extra.join(', ')} (remove them)`);
mkdirSync(OUT, { recursive: true });
for (const [p, b] of files) writeFileSync(join(OUT, p), b);
console.log(`sync-delivery: ${files.size - 1} files from delivery ${commit.slice(0, 7)}${changed.length ? ` (changed: ${changed.join(', ')})` : ' (unchanged)'}`);
