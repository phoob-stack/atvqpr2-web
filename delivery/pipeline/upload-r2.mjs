#!/usr/bin/env node
// upload-r2.mjs - put the pipeline's versioned tree (out/r2) into the R2 bucket
// with wrangler, or point latest.json back at an older version (rollback).
//
//   node pipeline/upload-r2.mjs [--out out] [--title <id>] [--dry-run]
//   node pipeline/upload-r2.mjs --rollback <version> --title <id> [--from <an out/r2 folder>] [--dry-run]
//   node pipeline/upload-r2.mjs --check [--out out] [--title <id>]   (after an upload: read it back over HTTPS)
//
// The bucket holds one versioned tree per title, under its profile's prefix
// (profiles/<id>.json, remote.prefix = games/<id>/):
//   games/<id>/latest.json, games/<id>/v/<N.N.N-12hex>/manifest.json, games/<id>/v/<version>/<path>
// --title <id> limits an upload or a check to one title; a rollback always names one.
//
// Upload: reads out/r2-upload-plan.json (written by pipeline/build.mjs) and,
// before anything is sent:
//   - every key must be games/<id>/latest.json or games/<id>/v/<N.N.N-12hex>/<safe
//     path> of a title in the plan (never an ATV 2 name: the profile rule and
//     the gate refuse it), and every file must be out/r2/<key> with the plan's
//     size and SHA-256;
//   - the plan must list exactly the files of out/r2;
//   - the no-game-content gate (verify-package.mjs --delivery --r2, with this
//     repository as --source-root) must pass on out/r2.
// Then, in the plan's order (per title: the version's files, its manifest,
// its latest.json last), one command per object:
//   npx wrangler r2 object put <bucket>/<key> --file <file> --cache-control <cc> --content-type <ct> --remote
// The first failure stops it; latest.json is only written after everything
// else is there, so a broken upload leaves the old version live.
// Nothing is ever deleted: older v/<version>/ trees stay in the bucket.
//
// Rollback (per title): games/<id>/latest.json for an older version of that
// title that is still in the bucket. Its manifest is read from --from (an
// out/r2 folder that has it) or from the public URL
// (<publicBase>/games/<id>/v/<version>/manifest.json, plain HTTPS GET),
// checked, and games/<id>/latest.json is put again (public, max-age=30). The file it
// puts is written to <out>/rollback/<id>/latest.json first.
//
// --dry-run prints the commands and runs nothing. No credentials are read or
// needed here: wrangler uses its own login (`npx wrangler login`).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage, nameProblems, SAFE_REL, TITLE_ID, NEVER_TITLE } from './verify-package.mjs';
import { latestFor, CACHE_IMMUTABLE, CACHE_POINTER, VERSION_RE } from './manifest.mjs';
import { walk } from './lib/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry-run');
const OUT = resolve(opt('--out', join(ROOT, 'out')));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const die = (m, code = 1) => { console.error(`upload-r2: ${m}`); process.exit(code); };
const KEY = /^games\/([a-z0-9][a-z0-9-]{0,31})\/(?:latest\.json|v\/([0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12})\/(.+))$/;
const TITLE = opt('--title');
if (TITLE !== undefined && !TITLE_ID.test(TITLE)) die(`--title must be a title id like boxquad (got ${TITLE})`);
if (TITLE && NEVER_TITLE.test(TITLE)) die(`${TITLE}: ATV 2 is derived from the retail game; nothing of it is ever uploaded`);
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** One wrangler call, as an argv list (also what --dry-run prints). */
export function putCommand(bucket, key, file, cacheControl, contentType) {
  return ['npx', 'wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--cache-control', cacheControl, '--content-type', contentType, '--remote'];
}
const quote = (a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
const show = (cmd) => cmd.map(quote).join(' ');

function run(cmd) {
  console.log(`$ ${show(cmd)}`);
  if (DRY) return;
  // npx is npx.cmd on Windows, which Node only starts through a shell; every argument is quoted.
  const r = spawnSync(show(cmd), { shell: true, stdio: 'inherit' });
  if (r.status !== 0) die(`stopped: "${show(cmd)}" exited ${r.status}. Objects after this one were not uploaded; latest.json was not changed unless it was this command.`);
}

/** Every check of the upload; returns the plan (only --title's objects when given). Exported for the tests. */
export function checkPlan(out, { title = TITLE } = {}) {
  const planFile = join(out, 'r2-upload-plan.json');
  if (!existsSync(planFile)) die(`no ${planFile}: run node pipeline/build.mjs first`);
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const problems = [];
  if (plan.format !== 'delivery-upload-plan/2' || !Array.isArray(plan.objects) || !Array.isArray(plan.titles)) die(`${planFile} is not an upload plan (delivery-upload-plan/2)`);
  if (!BUCKET_RE.test(plan.bucket ?? '')) problems.push(`bad bucket name ${plan.bucket}`);
  const titles = new Map();
  for (const t of plan.titles) {
    if (!TITLE_ID.test(t.id ?? '') || NEVER_TITLE.test(t.id) || t.prefix !== `games/${t.id}/`) problems.push(`bad title ${JSON.stringify(t)}`);
    if (!VERSION_RE.test(t.version ?? '')) problems.push(`${t.id}: bad version ${t.version}`);
    titles.set(t.id, t);
  }
  if (title && !titles.has(title)) die(`${title} is not a title of this plan (${[...titles.keys()].join(', ')})`);
  const seen = new Set(), last = new Map();
  plan.objects.forEach((o, i) => {
    const m = KEY.exec(o.key ?? '');
    if (!m) { problems.push(`${o.key}: not games/<id>/latest.json or games/<id>/v/<version>/<path>`); return; }
    const t = titles.get(m[1]);
    if (!t || o.title !== m[1]) { problems.push(`${o.key}: not a title of this plan`); return; }
    if (m[2] && m[2] !== t.version) problems.push(`${o.key}: not ${t.id}'s version ${t.version}`);
    if (m[3] && (!SAFE_REL.test(m[3]) || nameProblems(m[3], { allowWasm: true }).length)) problems.push(`${o.key}: ${nameProblems(m[3], { allowWasm: true }).join('; ') || 'unsafe path'}`);
    if (seen.has(o.key)) problems.push(`${o.key}: listed twice`); seen.add(o.key);
    if (o.file !== `r2/${o.key}`) problems.push(`${o.key}: file must be r2/<key> (got ${o.file})`);
    const pointer = !m[2];
    const want = pointer ? CACHE_POINTER : CACHE_IMMUTABLE;
    if (o.cacheControl !== want) problems.push(`${o.key}: Cache-Control must be "${want}"`);
    if (!/^[\w.+-]+\/[\w.+-]+(; charset=utf-8)?$/.test(o.contentType ?? '')) problems.push(`${o.key}: bad Content-Type`);
    const abs = join(out, ...String(o.file).split('/'));
    if (!existsSync(abs)) { problems.push(`${o.key}: ${abs} is missing`); return; }
    const body = readFileSync(abs);
    if (body.length !== o.size || sha(body) !== o.sha256) problems.push(`${o.key}: size/SHA-256 differ from the plan (changed after the build)`);
    if (pointer) last.set(t.id, i);
    else if (last.has(t.id)) problems.push(`${o.key}: after ${t.id}'s latest.json (the pointer must be its title's last object)`);
  });
  for (const t of titles.values()) if (!seen.has(`${t.prefix}latest.json`)) problems.push(`${t.id}: the plan has no ${t.prefix}latest.json`);
  const tree = join(out, 'r2');
  for (const f of walk(tree)) if (!seen.has(f.rel)) problems.push(`r2/${f.rel}: in out/r2 but not in the plan`);
  // the gate, again, on exactly what would be uploaded
  const gate = verifyPackage(tree, { quiet: true, delivery: true, r2: true, sourceRoot: ROOT });
  for (const p of gate.problems) problems.push(`gate: ${p.file}: ${p.why}`);
  if (problems.length) {
    for (const p of problems) console.error(`  FAIL ${p}`);
    die(`refusing to upload: ${problems.length} problem(s) in ${planFile}`);
  }
  const objects = title ? plan.objects.filter((o) => o.title === title) : plan.objects;
  console.log(`checked: ${objects.length} objects, ${(objects.reduce((n, o) => n + o.size, 0) / 1048576).toFixed(2)} MB, ` +
    `${[...titles.values()].filter((t) => !title || t.id === title).map((t) => `${t.id} ${t.version}`).join(', ')}; gate passed (${gate.files} files)`);
  return { ...plan, objects, titles: plan.titles.filter((t) => !title || t.id === title) };
}

async function rollback(version) {
  if (!VERSION_RE.test(version)) die(`--rollback needs a version like 1.1.0-0123456789ab (got ${version})`);
  if (!TITLE) die('--rollback needs --title <id> (each title has its own latest.json)');
  const prefix = `games/${TITLE}/`;
  const bucket = opt('--bucket', 'atvqpr2-assets');
  const base = opt('--public-base', 'https://assets.atvqpr2.com').replace(/\/$/, '');
  if (!BUCKET_RE.test(bucket)) die(`bad bucket ${bucket}`);
  let body, where;
  const from = opt('--from');
  if (from) {
    where = join(resolve(from), 'games', TITLE, 'v', version, 'manifest.json');
    if (!existsSync(where)) die(`${where} does not exist`);
    body = readFileSync(where);
  } else {
    where = `${base}/${prefix}v/${version}/manifest.json`;
    const r = await fetch(where, { cache: 'no-store' }).catch((e) => die(`cannot GET ${where} (${e.message})`));
    if (!r.ok) die(`${where} answered HTTP ${r.status}: that version is not in the bucket (rollback needs a kept version)`);
    body = Buffer.from(await r.arrayBuffer());
  }
  let m;
  try { m = JSON.parse(body.toString('utf8')); } catch (e) { die(`${where} is not JSON (${e.message})`); }
  if (m.version !== version || !Array.isArray(m.files)) die(`${where} is not the manifest of ${version}`);
  if (m.title !== TITLE) die(`${where} is ${m.title}'s manifest, not ${TITLE}'s`);
  for (const e of m.files) if (nameProblems(e.path, { allowWasm: true }).length) die(`${where} lists ${e.path}: ${nameProblems(e.path, { allowWasm: true }).join('; ')}`);
  if (!from && !argv.includes('--no-check')) {
    // every file of that version must still be there
    for (const e of m.files) {
      // identity: Cloudflare compresses small files and then leaves out Content-Length
      const u = `${base}/${prefix}v/${version}/${e.path}`;
      const r = await fetch(u, { method: 'HEAD', cache: 'no-store', headers: { 'accept-encoding': 'identity' } }).catch(() => null);
      if (!r?.ok || Number(r.headers.get('content-length')) !== e.size) die(`${u} is missing or has the wrong size: not rolling back to ${version}`);
    }
  }
  const latest = latestFor(m.title, version, body);
  const dir = join(OUT, 'rollback', TITLE);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'latest.json');
  writeFileSync(file, JSON.stringify(latest, null, 1) + '\n');
  console.log(`rollback: ${prefix}latest.json -> ${version} (manifest ${latest.sha256.slice(0, 16)}…, ${m.files.length} files, from ${where})`);
  run(putCommand(bucket, `${prefix}latest.json`, file, CACHE_POINTER, 'application/json'));
  return { file, latest };
}

async function checkPublic() {
  const planFile = join(OUT, 'r2-upload-plan.json');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const base = plan.publicBase.replace(/\/$/, '');
  let bad = 0;
  for (const o of plan.objects) {
    if (TITLE && o.title !== TITLE) continue;
    const r = await fetch(`${base}/${o.key}`, { method: 'HEAD', cache: 'no-store', headers: { origin: 'https://atvqpr2.com', 'accept-encoding': 'identity' } }).catch((e) => ({ ok: false, status: e.message, headers: new Headers() }));
    const h = r.headers;
    const why = [];
    if (!r.ok) why.push(`HTTP ${r.status}`);
    else {
      if (!o.key.endsWith('/latest.json') && Number(h.get('content-length')) !== o.size) why.push(`size ${h.get('content-length')}`);
      if (h.get('cache-control') !== o.cacheControl) why.push(`cache-control ${h.get('cache-control')}`);
      if (!String(h.get('content-type')).startsWith(o.contentType.split(';')[0])) why.push(`content-type ${h.get('content-type')}`);
      if (!['https://atvqpr2.com', '*'].includes(h.get('access-control-allow-origin')))   // '*': the zone's response header rule (cache-safe)
      why.push(`no CORS for https://atvqpr2.com (${h.get('access-control-allow-origin')})`);
    }
    console.log(`${why.length ? 'FAIL' : 'ok  '} ${o.key}${why.length ? `: ${why.join(', ')}` : ''}`);
    bad += why.length ? 1 : 0;
  }
  for (const t of plan.titles) {
    if (TITLE && t.id !== TITLE) continue;
    const latest = await (await fetch(`${base}/${t.prefix}latest.json`, { cache: 'no-store' })).json().catch(() => null);
    console.log(`live ${t.prefix}latest.json: ${latest?.version ?? '(unreadable)'}${latest?.version === t.version ? ' (this build)' : ''}`);
  }
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (argv.includes('--rollback')) await rollback(opt('--rollback'));
  else if (argv.includes('--check')) await checkPublic();
  else {
    if (!existsSync(OUT) || !statSync(OUT).isDirectory()) die(`no ${OUT}: run node pipeline/build.mjs first`);
    const plan = checkPlan(OUT);
    if (DRY) console.log('dry run: nothing is uploaded; these are the commands, in order:');
    for (const o of plan.objects) run(putCommand(plan.bucket, o.key, join(OUT, ...o.file.split('/')), o.cacheControl, o.contentType));
    console.log(DRY ? `dry run done: ${plan.objects.length} commands` : `uploaded ${plan.objects.length} objects; ` +
      plan.titles.map((t) => `${plan.publicBase}/${t.prefix}latest.json -> ${t.version}`).join(', '));
  }
}
