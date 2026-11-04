#!/usr/bin/env node
// build.mjs - the delivery pipeline, one command:
//
//   node pipeline/build.mjs [--out out] [--site ../site] [--site-ref HEAD] [--no-site]
//        [--manifest-url ./assets/manifest.json] [--hub-url ws://127.0.0.1:8854/]
//        [--variant N] [--chunk-size bytes] [--wasi-sdk dir] [--root <repo>]
//        [--bucket atvqpr2-assets] [--public-base https://assets.atvqpr2.com] [--vps-title boxquad]
//
// It builds OUR artifacts only and lays them out. The titles are the game
// profiles in profiles/ with a remote source (client/profile.js; each names
// its build folder, whose build.mjs exports buildTitle(outDir)): adding a
// title is a profile and its build, nothing here.
//   out/assets/       manifest.json + objects/<aa>/<sha256>: the asset server's
//                     folder (VPS / CDN-behind-the-server layout), for --vps-title
//   out/r2/           the versioned bucket tree for R2, per title:
//                     games/<id>/latest.json + games/<id>/v/<version>/manifest.json
//                     + games/<id>/v/<version>/<path>
//   out/r2-upload-plan.json  every object key of out/r2 with its title, file,
//                     size, SHA-256, Content-Type and Cache-Control; per title
//                     the files, the manifest, then its latest.json
//                     (pipeline/upload-r2.mjs runs it; it never runs here)
//   out/web/          the launcher page, the client library, the test title's
//                     page code, sw.js (shell list stamped in), config.json
//   out/site/         the project site, exactly as committed (git archive <ref>)
//   out/app/          the asset server and the free-roam hub (what the
//                     containers run), with the scan they use at start-up
//   out/artifacts.json  every compiled artifact: SHA-256, sources, toolchain
//   out/build.json    what was built, from which commits, and the gate's result
//
// Then the no-game-content scan (pipeline/verify-package.mjs --delivery) runs
// as a HARD gate over the inputs and the whole output; any problem fails the
// build and nothing is written to --out (the build happens in <out>.staging,
// which replaces <out> only after the gate passed).
//
// What it never does: read, package or serve the ATV 2 build or anything
// derived from the game. There is no option for it. Paths of the game's
// build trees are refused as inputs and outputs (guardPath below).
// --with-atv-runtime is reserved and refused: see README "The ATV 2 runtime".
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage, NEVER_TITLE } from './verify-package.mjs';
import { buildManifest, writeLayout, writeVersionedTree, DEFAULT_CHUNK, CACHE_IMMUTABLE, CACHE_POINTER } from './manifest.mjs';
import { walk } from './lib/util.mjs';
import { headersToCaddy } from './caddy-headers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const t0 = performance.now();
const log = (s) => console.log(`[${((performance.now() - t0) / 1000).toFixed(2).padStart(6)}s] ${s}`);

if (argv.includes('--with-atv-runtime')) {
  console.error('build: --with-atv-runtime is not supported. The pipeline never packages the ATV 2 build or its files; ' +
    'ATV 2 keeps its "player picks their own files" path on the site. See README, "The ATV 2 runtime".');
  process.exit(2);
}

const ROOT = resolve(opt('--root', join(HERE, '..')));
const OUT = resolve(opt('--out', join(ROOT, 'out')));
const STAGE = `${OUT}.staging`;
const SITE = argv.includes('--no-site') ? null : resolve(opt('--site', join(ROOT, '..', 'site')));
const SITE_REF = opt('--site-ref', 'HEAD');
const VARIANT = Number(opt('--variant', 0));
const CHUNK = Number(opt('--chunk-size', DEFAULT_CHUNK));
const MANIFEST_URL = opt('--manifest-url', './assets/manifest.json');
const HUB_URL = opt('--hub-url', 'ws://127.0.0.1:8854/');
const WASI_SDK = opt('--wasi-sdk');
const BUCKET = opt('--bucket', 'atvqpr2-assets');
const PUBLIC_BASE = opt('--public-base', 'https://assets.atvqpr2.com');
const VPS_TITLE = opt('--vps-title', 'boxquad');
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(BUCKET)) { console.error(`build: --bucket ${BUCKET} is not an R2 bucket name`); process.exit(2); }
if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(PUBLIC_BASE)) { console.error(`build: --public-base must be https://host (got ${PUBLIC_BASE})`); process.exit(2); }

// (Git Bash rewrites a lone "/hub/" into a Windows path: refuse that rather than ship it)
if (HUB_URL && !/^(wss?:\/\/[\w.:[\]-]+\/|\/(?!\/)[\w./-]*$)/.test(HUB_URL)) { console.error(`build: --hub-url must be ws(s)://host/... or /path/ (got ${HUB_URL}; in Git Bash use MSYS_NO_PATHCONV=1)`); process.exit(2); }
if (!/^(https?:\/\/[\w.:[\]-]+\/|\.{0,2}\/(?!\/))[\w./-]*$/.test(MANIFEST_URL)) { console.error(`build: --manifest-url must be http(s)://... or a relative/absolute path (got ${MANIFEST_URL})`); process.exit(2); }

// ---- guard: the game's build trees are never inputs or outputs ----------------------
// The workspace is the folder that holds this repository next to the game's
// trees (atvrecomp, xboxrecomp, builder, work, ...); the rewrite project sits
// next to the workspace. ATV2_FORBIDDEN_DIRS (path-list separated) adds more.
const LOCAL = process.env.LOCALAPPDATA ?? '';
const WORKSPACES = [...new Set([resolve(ROOT, '..'), resolve(HERE, '..', '..')])];
const FORBIDDEN_DIRS = [
  ...WORKSPACES.flatMap((w) => ['atvrecomp', 'xboxrecomp', 'builder', 'work', 'dumps', 'saves', 'saves-seed', 'screens'].map((d) => join(w, d))),
  ...WORKSPACES.map((w) => join(w, '..', 'atv2rewrite')),
  ...String(process.env.ATV2_FORBIDDEN_DIRS ?? '').split(delimiter).filter(Boolean),
  LOCAL && join(LOCAL, 'xboxrecomp'), LOCAL && join(LOCAL, 'atv2-builder')].filter(Boolean).map((p) => resolve(p).toLowerCase());
const GAME_PATH = /[\\/](src[\\/]recomp[\\/]gen|build-wasm|atv2-play|atv2-game|game[\\/]atv2)([\\/]|$)/i;
export function guardPath(p, what) {
  const a = resolve(p).toLowerCase();
  for (const d of FORBIDDEN_DIRS) if (a === d || a.startsWith(d + sep)) throw new Error(`${what} ${p} is inside ${d}, which the pipeline never reads or writes`);
  if (GAME_PATH.test(a)) throw new Error(`${what} ${p} is a path of the game's build or storage`);
  // wherever they are checked out: the recompiler projects and the builder's folders
  if (/[\\/](atvrecomp|xboxrecomp|atv2rewrite|atv2-builder)([\\/]|$)/i.test(a))
    throw new Error(`${what} ${p} is inside a recompiler or builder tree, which the pipeline never reads or writes`);
}

function fail(msg, problems = []) {
  for (const p of problems) console.error(`  FAIL ${p.where ? `${p.where}: ` : ''}${p.file}: ${p.why}`);
  console.error(`build FAILED: ${msg}`);
  if (existsSync(STAGE) && !argv.includes('--keep-staging')) rmSync(STAGE, { recursive: true, force: true });
  process.exit(1);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const git = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, ...args], { maxBuffer: 512 << 20, ...opts });

// ---- tar (git archive output) -----------------------------------------------------------
function untar(buf, dest) {
  const files = [];
  let pax = {};
  for (let o = 0; o + 512 <= buf.length;) {
    const h = buf.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, n) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 155);
    let name = pax.path ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    const body = buf.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      const rec = {};
      for (let i = 0; i < body.length;) {
        const sp = body.indexOf(0x20, i);
        const len = Number(body.subarray(i, sp).toString());
        const kv = body.subarray(sp + 1, i + len - 1).toString('utf8');
        const eq = kv.indexOf('=');
        rec[kv.slice(0, eq)] = kv.slice(eq + 1);
        i += len;
      }
      if (type === 'x') pax = rec;
      continue;
    }
    pax = {};
    name = name.replace(/\/$/, '');
    if (!name || name.split('/').some((s) => s === '..' || s === '') || name.startsWith('/')) throw new Error(`unsafe path in archive: ${name}`);
    if (type === '5') { mkdirSync(join(dest, name), { recursive: true }); continue; }
    if (type !== '0') throw new Error(`archive entry ${name} has type ${type} (links are refused)`);
    mkdirSync(dirname(join(dest, name)), { recursive: true });
    writeFileSync(join(dest, name), body);
    files.push(name);
  }
  return files;
}

// ---- steps --------------------------------------------------------------------------------
const report = { tool: 'delivery-pipeline', version: 1, started: new Date().toISOString(), inputs: {}, outputs: {}, gate: {} };
try {
  guardPath(ROOT, 'root'); guardPath(OUT, 'output'); if (SITE) guardPath(SITE, 'site');
  if (existsSync(OUT)) {
    let ok = false;
    try { ok = JSON.parse(readFileSync(join(OUT, 'build.json'), 'utf8')).tool === 'delivery-pipeline'; } catch { /* not ours */ }
    if (!ok) throw new Error(`${OUT} exists and was not written by this pipeline (no build.json); pick another --out`);
  }
} catch (e) { fail(e.message); }

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// 1. The inputs, before anything is read from them.
const INPUT_DIRS = ['profiles', 'title', 'titles', 'client', 'web', 'server', 'hub', 'pipeline', 'deploy', 'test'].filter((d) => existsSync(join(ROOT, d)));
{
  const problems = [];
  for (const d of INPUT_DIRS) {
    const r = verifyPackage(join(ROOT, d), { quiet: true, delivery: true });
    problems.push(...r.problems.map((p) => ({ where: `input ${d}`, ...p })));
  }
  report.gate.inputs = { dirs: INPUT_DIRS, problems: problems.length };
  if (problems.length) fail(`the inputs hold forbidden files (${problems.length} problem(s)); nothing was built`, problems);
  log(`inputs clean: ${INPUT_DIRS.join(', ')}`);
}
try {
  report.inputs.commit = (() => { try { return git(ROOT, ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } })();
} catch { /* not a repo */ }

// 2. The titles: every profile in profiles/ with a remote source (our own titles only:
//    checkProfile refuses a remote source for a retail-derived profile, and an ATV 2
//    id is refused here and by the gate). Each is built by its profile's build.dir/build.mjs.
const titles = [];
let artifacts = {};
try {
  const { checkProfile } = await import(new URL(`file:///${join(ROOT, 'client', 'profile.js').replace(/\\/g, '/')}`).href);
  const dir = join(ROOT, 'profiles');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const p = checkProfile(JSON.parse(readFileSync(join(dir, f), 'utf8')), `profiles/${f}`);
    if (f !== `${p.id}.json`) throw new Error(`profiles/${f}: the file must be named after its id (${p.id}.json)`);
    if (NEVER_TITLE.test(p.id)) throw new Error(`profiles/${f}: ${p.id} is an ATV 2 name; ATV 2 is never built, packaged or served here`);
    if (!p.sources.includes('remote')) { log(`profile ${p.id}: no remote source, not built`); continue; }
    if (!p.build?.dir) throw new Error(`profiles/${f}: a remote title needs build.dir (its build.mjs)`);
    guardPath(join(ROOT, p.build.dir), `profile ${p.id} build.dir`);
    titles.push({ ...p });
  }
  if (!titles.length) throw new Error('no profile with a remote source in profiles/');
  for (const p of titles) {
    const out = join(STAGE, '.titles', p.id);
    const { buildTitle } = await import(new URL(`file:///${join(ROOT, p.build.dir, 'build.mjs').replace(/\\/g, '/')}`).href);
    const r = buildTitle(out, { variant: VARIANT, wasiSdk: WASI_SDK });
    for (const [name, a] of Object.entries(r.artifacts)) {
      const got = sha(readFileSync(join(out, name)));
      if (got !== a.sha256) throw new Error(`${p.id}/${name}: built file and its record differ`);
      artifacts[`${p.id}/${name}`] = a;
    }
    const extraDir = join(ROOT, p.build.dir, 'static');
    if (existsSync(extraDir)) cpSync(extraDir, out, { recursive: true });
    p.out = out; p.artifacts = r.artifacts;
    log(`title ${p.id} built: ${Object.entries(r.artifacts).map(([n, a]) => `${n} ${a.size} bytes`).join(', ')} (${Object.values(r.artifacts)[0]?.toolchain.split(' (')[0]})`);
  }
} catch (e) { fail(`titles: ${e.message}`); }

// 3. Assets: per title the manifest (required files, groups: the profile), the versioned
//    R2 tree under its prefix games/<id>/, and one upload plan for all of them; the asset
//    server's layout (VPS) for --vps-title.
let r2plan;
try {
  const objects = [];
  report.outputs.titles = {};
  for (const p of titles) {
    const files = walk(p.out).map((f) => ({ path: f.rel, abs: join(p.out, f.rel), artifact: p.artifacts[f.rel] }));
    const built = buildManifest(files, { title: p.id, name: p.title, titleVersion: p.titleVersion, entry: p.entry, required: p.required ?? [], groups: p.groups ?? {} }, { chunkSize: CHUNK });
    if (p.id === VPS_TITLE) {
      const m = writeLayout(join(STAGE, 'assets'), built);
      report.outputs.assets = { title: p.id, version: m.version, files: m.files.length, bytes: m.files.reduce((n, e) => n + e.size, 0) };
    }
    const tree = writeVersionedTree(join(STAGE, 'r2'), built, { prefix: p.remote.prefix });
    const mine = tree.keys.map((k) => ({ key: k.key, title: p.id, file: `r2/${k.key}`, size: k.size, sha256: k.sha256, contentType: k.type,
      cacheControl: k.key.endsWith('/latest.json') ? CACHE_POINTER : CACHE_IMMUTABLE }));
    // upload order per title: the version's files, then its manifest, then its pointer (latest.json never names a half-uploaded version)
    const rank = (o) => (o.key.endsWith('/latest.json') ? 2 : o.key.endsWith('/manifest.json') ? 1 : 0);
    mine.sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : 1));
    objects.push(...mine);
    const m = built.manifest;
    const bytes = m.files.reduce((n, e) => n + e.size, 0);
    report.outputs.titles[p.id] = { version: m.version, prefix: p.remote.prefix, files: m.files.length, bytes, required: m.files.filter((e) => e.required).map((e) => e.path),
      groups: Object.fromEntries([...new Set(m.files.filter((e) => e.group).map((e) => e.group))].map((g) => [g, m.files.filter((e) => e.group === g).map((e) => e.path)])) };
    log(`${p.id}: ${m.files.length} files, ${(bytes / 1048576).toFixed(2)} MB, version ${m.version} -> ${p.remote.prefix} (required ${report.outputs.titles[p.id].required.length}, groups ${Object.keys(report.outputs.titles[p.id].groups).join(', ') || '-'})`);
  }
  if (!report.outputs.assets) throw new Error(`--vps-title ${VPS_TITLE} is not a remote title of profiles/`);
  r2plan = { format: 'delivery-upload-plan/2', comment: 'Written by pipeline/build.mjs. Run with pipeline/upload-r2.mjs (it re-checks every file and runs the gate first).',
    bucket: BUCKET, publicBase: PUBLIC_BASE,
    titles: titles.map((p) => ({ id: p.id, prefix: p.remote.prefix, version: report.outputs.titles[p.id].version })),
    source: { commit: report.inputs.commit ?? null }, objects };
  writeFileSync(join(STAGE, 'r2-upload-plan.json'), JSON.stringify(r2plan, null, 1) + '\n');
  report.outputs.r2 = { bucket: BUCKET, publicBase: PUBLIC_BASE, titles: r2plan.titles, objects: objects.length, bytes: objects.reduce((n, o) => n + o.size, 0) };
  log(`r2 tree: ${objects.length} objects for ${BUCKET} (${r2plan.titles.map((t) => `${t.prefix}v/${t.version}/`).join(', ')}, each with its latest.json)`);
} catch (e) { fail(`assets: ${e.message}`); }
rmSync(join(STAGE, '.titles'), { recursive: true, force: true });
writeFileSync(join(STAGE, 'artifacts.json'), JSON.stringify({ comment: 'Every compiled artifact of this build (<title>/<file>): what the gate accepts as a wasm module, nothing else.', artifacts }, null, 1) + '\n');

// 4. Web shell: launcher page, client library, title page code, sw.js, config.json.
try {
  const web = join(STAGE, 'web');
  cpSync(join(ROOT, 'web'), web, { recursive: true });
  mkdirSync(join(web, 'client'), { recursive: true });
  for (const f of ['assets.js', 'asset-worker.js', 'launcher.js', 'sha256.js', 'profile.js']) cpSync(join(ROOT, 'client', f), join(web, 'client', f));
  writeFileSync(join(web, 'config.json'), JSON.stringify({ ns: 'boxquad', manifest: MANIFEST_URL, hub: HUB_URL || null, background: true }, null, 1) + '\n');
  const shell = walk(web).map((f) => f.rel).sort();
  const version = sha(shell.map((p) => `${p}\0${sha(readFileSync(join(web, p)))}\n`).join('')).slice(0, 16);
  const sw = readFileSync(join(ROOT, 'client', 'sw.js'), 'utf8').replace("'__VERSION__'", JSON.stringify(version)).replace('__SHELL__', JSON.stringify(shell));
  writeFileSync(join(web, 'sw.js'), sw);
  report.outputs.web = { files: shell.length + 1, shellVersion: version };
  log(`web shell: ${shell.length + 1} files, shell version ${version}`);
} catch (e) { fail(`web: ${e.message}`); }

// 5. The site, exactly as committed.
if (SITE) {
  try {
    const commit = git(SITE, ['rev-parse', SITE_REF]).toString().trim();
    const tar = git(SITE, ['-c', 'core.autocrlf=false', 'archive', '--format=tar', commit]);
    const files = untar(tar, join(STAGE, 'site'));
    // the site's own headers for Caddy (deploy/Caddyfile imports out/site.caddy)
    const hdr = join(STAGE, 'site', '_headers');
    writeFileSync(join(STAGE, 'site.caddy'), existsSync(hdr) ? headersToCaddy(readFileSync(hdr, 'utf8')) : '# no _headers in the site\n');
    report.inputs.site = { dir: SITE, ref: SITE_REF, commit };
    report.outputs.site = { files: files.length };
    log(`site: git archive ${commit.slice(0, 10)} of ${SITE}: ${files.length} files`);
  } catch (e) { fail(`site: ${e.message}`); }
}

// 6. The servers (asset backend + hub) and the scan they run at start-up.
try {
  const app = join(STAGE, 'app');
  for (const d of ['server', 'hub']) cpSync(join(ROOT, d), join(app, d), { recursive: true });
  mkdirSync(join(app, 'pipeline', 'lib'), { recursive: true });
  cpSync(join(ROOT, 'pipeline', 'verify-package.mjs'), join(app, 'pipeline', 'verify-package.mjs'));
  cpSync(join(ROOT, 'pipeline', 'lib', 'util.mjs'), join(app, 'pipeline', 'lib', 'util.mjs'));
  cpSync(join(ROOT, 'LICENSE'), join(app, 'LICENSE'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'delivery-app', private: true, type: 'module', license: 'MIT' }, null, 1) + '\n');
  log('app: asset server + hub');
} catch (e) { fail(`app: ${e.message}`); }

// 7. THE GATE: the whole output, then the asset layout and the site by their own rules.
{
  const problems = [];
  const all = verifyPackage(STAGE, { quiet: true, delivery: true, sourceRoot: ROOT });
  problems.push(...all.problems.map((p) => ({ where: 'out', ...p })));
  const assets = verifyPackage(join(STAGE, 'assets'), { quiet: true, delivery: true, assets: true, sourceRoot: ROOT });
  problems.push(...assets.problems.map((p) => ({ where: 'out/assets', ...p })));
  const r2 = verifyPackage(join(STAGE, 'r2'), { quiet: true, delivery: true, r2: true, sourceRoot: ROOT });
  problems.push(...r2.problems.map((p) => ({ where: 'out/r2', ...p })));
  // the upload plan names exactly the files of out/r2, unchanged
  const inTree = new Set(walk(join(STAGE, 'r2')).map((f) => `r2/${f.rel}`));
  for (const o of r2plan.objects) {
    if (!inTree.delete(o.file) || o.file !== `r2/${o.key}`) { problems.push({ where: 'r2-upload-plan.json', file: o.key, why: 'not a file of out/r2' }); continue; }
    if (sha(readFileSync(join(STAGE, o.file))) !== o.sha256) problems.push({ where: 'r2-upload-plan.json', file: o.key, why: 'SHA-256 differs from the file' });
  }
  for (const f of inTree) problems.push({ where: 'out/r2', file: f, why: 'not in the upload plan' });
  if (SITE) {
    const site = verifyPackage(join(STAGE, 'site'), { quiet: true, site: true, delivery: true });
    problems.push(...site.problems.map((p) => ({ where: 'out/site', ...p })));
  }
  // every wasm in the output is one we just built
  const builtWasm = new Set(Object.values(artifacts).map((a) => a.sha256));
  for (const f of walk(STAGE)) {
    const abs = join(STAGE, f.rel);
    if (f.size >= 4 && readFileSync(abs).subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d])) && !builtWasm.has(sha(readFileSync(abs))))
      problems.push({ where: 'out', file: f.rel, why: 'wasm module not built by this run' });
  }
  report.gate.output = { files: all.files, bytes: all.bytes, problems: problems.length, r2: { files: r2.files, bytes: r2.bytes } };
  if (problems.length) fail(`the no-game-content gate failed (${problems.length} problem(s)); ${OUT} was not changed`, problems);
  log(`gate passed: ${all.files} files, ${(all.bytes / 1048576).toFixed(2)} MB, 0 problems`);
}

// 8. Swap in.
report.finished = new Date().toISOString();
report.seconds = Number(((performance.now() - t0) / 1000).toFixed(2));
writeFileSync(join(STAGE, 'build.json'), JSON.stringify(report, null, 1) + '\n');
rmSync(OUT, { recursive: true, force: true });
renameSync(STAGE, OUT);
log(`done: ${OUT}`);
void readdirSync; void statSync; void relative;
