#!/usr/bin/env node
// verify-package.mjs - fail if a folder holds anything taken or generated
// from the game. Run it on this package before it goes anywhere, and on any
// other folder that should hold only our code (a site, a release staging dir).
//
//   node verify-package.mjs [folder=this package] [--json] [--quiet]
//
// Exit 0 = clean, 1 = violations (listed), 2 = usage error. `.git` is skipped
// (it holds only what was committed from this folder, and is never shipped).
//
// Rules:
//  1. extensions: disc and game files, audio, compiled code and toolchain
//     binaries (.xbe .iso .bah .bad .xpr .wav .wasm .obj .lib .exe and the
//     extras in BAD_EXT below);
//  2. any file over 5 MB;
//  3. any file under a src/recomp/gen folder, or named like the lifter's or
//     the wasm build's output (recomp_NNNN.c, recomp_dispatch.c,
//     recomp_funcs.h, recomp_stubs_unresolved.c, pipelines.json,
//     atv2.memory.json);
//  4. content: the banners and per-function header comments the lifter
//     (xboxrecomp tools/recomp/translator.py) writes into generated C, or more
//     than 20 generated-style function definitions in one file;
//  5. magic numbers: an XBE ("XBEH"), an Xbox disc image ("MICROSOFT*XBOX*MEDIA"
//     at 0x10000), a wasm module, a RIFF/WAVE file, whatever the name.
//
// --site: the folder is a web site to publish (the project site, whose /play/
// runs the game from the player's own files). On top of the rules above:
//  6. no images, audio, video or fonts at all (game screens, textures, sounds,
//     movies); the site's own art, once there is some, is checked by hand and
//     listed with --allow-media <relative path> (repeatable);
//  7. no file over 1 MB;
//  8. generated WGSL by content (the shader generator's uniform blocks: the
//     game's shaders translated, e.g. a pipeline list or a shader dump), and
//     more than 4 WGSL entry points in one file;
//  9. no large embedded binary (a base64 run over 16 KB, or a base64 data:
//     URL over 4 KB): a way to smuggle any of the above into a text file;
// 10. no save files (.xbx, "Rider Data", "Records");
// 11. play/: every file must be one tools/sync-play.mjs wrote, as listed (path,
//     size, SHA-256) in play/sync.json: copied from atvrecomp's committed page
//     code, never dropped in by hand.
// --list prints every file with its size (what the site would serve).
//
// [delivery] This copy (delivery/pipeline/verify-package.mjs) adds --delivery,
// the hard gate of the delivery pipeline and the asset server's start-up
// check. On top of rules 1-5 (and 6-11 with --site):
// 12. .wasm (by name or by its magic number, whatever the name) only when it
//     is a declared artifact of this repository: its SHA-256 is in the
//     declarations (artifacts.json at the root, or the manifest's `artifact`
//     records in --assets mode) with a recorded source (each source file with
//     its SHA-256) and toolchain. With --source-root, each recorded source
//     file must exist there with that SHA-256 and pass rules 3-4 itself.
//     Never a module named like the game's (atv2*.wasm), declared or not.
// 13. known game files by SHA-256 (the reference atv2.wasm build, the retail
//     default.xbe), whatever the name.
// 14. recompiled-function markers in every file, binary ones too: the lifter
//     banners of rule 4, and more than 20 lifted-function names
//     (sub_XXXXXXXX, as a wasm name section or symbol map would carry them).
// 15. generated WGSL from the game (rule 8's uniform blocks) in every text file.
// 16. paths of the game's build and storage: src/recomp/gen, build-wasm,
//     atv2-play, atv2-game, atv2-build, atv2-game-cache; save files (.xbx).
// --assets (with --delivery): the folder is an asset backend / CDN layout:
// 17. manifest.json is required and well formed; every other file is an
//     object the manifest lists (objects/<aa>/<sha256>) with that size and
//     SHA-256 (nothing unlisted, nothing changed); every logical path in the
//     manifest passes the name rules (1, 3, 12, 16): no atv2.wasm, no
//     default.xbe, no recomp_*.c, by name either.
// --r2 (with --delivery): the folder is a versioned bucket tree (what
//     pipeline/upload-r2.mjs uploads to R2):
// 18. latest.json is required and well formed and points at an existing
//     v/<version>/manifest.json with that size and SHA-256; every
//     v/<version>/manifest.json is well formed (rule 17's entry checks, url =
//     path, version = its folder); every other file is v/<version>/<path> of
//     a file that manifest lists, with that size and SHA-256; nothing else.
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { walk } from './lib/util.mjs';

const MAX_BYTES = 5 * 1024 * 1024;
export const BAD_EXT = new Set([
  // required by the package rules
  '.xbe', '.iso', '.bah', '.bad', '.xpr', '.wav', '.wasm', '.obj', '.lib', '.exe',
  // more of the same kinds: disc images and game media, compiled objects and
  // libraries, compressed modules, debug databases
  '.xiso', '.xmv', '.xwb', '.xsb', '.wma', '.o', '.a', '.dll', '.pdb', '.br', '.so', '.dylib',
]);
const GEN_NAMES = /^(recomp_\d{4}\.c|recomp_dispatch\.c|recomp_funcs\.h|recomp_stubs_unresolved\.c|pipelines\.json|atv2\.memory\.json|game\.memory\.json)$/i;
const TEXT_EXT = new Set(['.c', '.h', '.cc', '.cpp', '.hpp', '.inc', '.txt', '.md', '.json', '.js', '.mjs', '.py', '.sh',
  '.html', '.css', '.wgsl', '.hlsl', '.cmd', '.bat', '.ps1', '.cmake', '']);
// What the lifter writes (translator.py): a chunk banner, the dispatch and
// declaration banners, and one header comment per function.
const MARKERS = [
  // (the lifter's own source has these as f-strings: "{title}", "{ci}", or the
  // title on another line, so they need the full emitted line form)
  [/^ \* [^{}"\n]+ - Recompiled code chunk \d+\s*$/m, 'lifter chunk banner'],
  [/^ \* [^{}"\n]+ - Recompiled Function (Dispatch Table|Declarations)\s*$/m, 'lifter table banner'],
  [/Maps \d+ Xbox VAs to translated function pointers/, 'lifter dispatch banner'],
  [/^ \* Original: 0x[0-9A-Fa-f]{8} - 0x[0-9A-Fa-f]{8} \(\d+ bytes, \d+ insns\)/m, 'lifted-function header comment'],
  [/addresses called by translated code but not\s*\n \* detected as functions/, 'lifter stub banner'],
  // build-wasm/pipelines.json (web/tools/mp.mjs --save-pipes): the game's
  // shaders translated to WGSL, keyed by hash.
  [/"shaders"\s*:\s*\{\s*"[0-9a-f]{12,}"\s*:\s*"(struct |fn |@)/, 'saved WebGPU pipeline list (generated WGSL)'],
];
const FUNC_DEF = /^void sub_[0-9A-Fa-f]{8}\(void\)\s*$/gm;
const MAX_FUNC_DEFS = 20;

// --site
const SITE_MAX_BYTES = 1024 * 1024;
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.tga', '.dds', '.ico', '.tif', '.tiff', '.psd',
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.ogg', '.ogv', '.mp3', '.m4a', '.aac', '.flac', '.opus', '.wma', '.mid',
  '.ttf', '.otf', '.woff', '.woff2', '.svg', '.xbx', '.bin', '.dat', '.zip', '.7z', '.rar', '.gz']);
const SAVE_NAMES = /^(rider data|records|savemeta\.xbx|titlemeta\.xbx|saveimage\.xbx|titleimage\.xbx)$/i;
const SITE_TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.md', '.txt', '.xml', '.map', '']);
const GEN_WGSL = /var<uniform>\s+[KXPU]\s*:\s*(VsC|XfC|PsC|TvC)\b|struct\s+VsC\s*\{\s*c\s*:\s*array<vec4f,\s*192>/;
const ENTRY_POINTS = /@(vertex|fragment|compute)\b/g;
const B64_RUN = /[A-Za-z0-9+/]{16384,}={0,2}/;
const B64_DATA_URL = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/]{4096,}/;

// --delivery
/** Known game files by SHA-256 (hashes only, from builder/config/build-expected.json
 *  and the builder's game check; the files themselves are never read here). */
export const DENY_SHA256 = new Map([
  ['a211cd18508fe02122d554feffe4830948edf513ffce33d2125481c75ed4181e', 'the ATV 2 game module (reference atv2.wasm build)'],
  ['1e3c2fcebf62709f2f867da846942470ef3455da6c46a0f3eb2f18aec93bd22f', 'the retail default.xbe'],
]);
const DELIVERY_BAD_EXT = new Set(['.xbx']);
const GAME_WASM_NAME = /^atv2[^/]*\.wasm$/i;
const GAME_PATHS = /(^|\/)(src\/recomp\/gen|build-wasm|atv2-play|atv2-game|atv2-build|atv2-game-cache)(\/|$)/i;
const SUB_NAME = /sub_[0-9A-Fa-f]{8}/g;
const MAX_SUB_NAMES = 20;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** A manifest's logical path: relative, forward slashes, no dot segments. */
export const SAFE_REL = /^(?!\/)(?!.*\/\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\-/]+$/;

/** Name rules (1, 3, 12, 16) for a path that is not a file on disk (a manifest's logical path). */
export function nameProblems(rel, { allowWasm = false } = {}) {
  const out = [];
  const ext = extname(rel).toLowerCase();
  if (BAD_EXT.has(ext) && !(allowWasm && ext === '.wasm')) out.push(`forbidden file type ${ext}`);
  if (DELIVERY_BAD_EXT.has(ext)) out.push(`forbidden file type ${ext} (save file)`);
  if (GEN_NAMES.test(basename(rel))) out.push('named like lifter output');
  if (GAME_WASM_NAME.test(basename(rel))) out.push('named like the game module (atv2*.wasm)');
  if (GAME_PATHS.test(rel)) out.push('under a path of the game\'s build or storage');
  if (SAVE_NAMES.test(basename(rel))) out.push('named like a save file');
  return out;
}

/** Declarations from artifacts.json ({ artifacts: { name: record } }) -> Map sha256 -> record. */
export function readDeclarations(file) {
  const out = new Map();
  const j = JSON.parse(readFileSync(file, 'utf8'));
  for (const [name, rec] of Object.entries(j.artifacts ?? {})) if (rec && HEX64.test(rec.sha256 ?? '')) out.set(rec.sha256, { name, ...rec });
  return out;
}

/** Rule 12: a declaration must record its source and toolchain; with
 *  sourceRoot, every source file must be there, unchanged and clean. */
export function declarationProblems(d, sourceRoot) {
  const out = [];
  if (GAME_WASM_NAME.test(basename(d.name ?? ''))) out.push('named like the game module (atv2*.wasm)');
  if (!Array.isArray(d.source) || !d.source.length) { out.push('no recorded source'); return out; }
  if (!d.toolchain) out.push('no recorded toolchain');
  for (const s of d.source) {
    if (!s || typeof s.path !== 'string' || !SAFE_REL.test(s.path) || !HEX64.test(s.sha256 ?? '')) { out.push(`bad source record ${JSON.stringify(s)}`); continue; }
    for (const w of nameProblems(s.path)) out.push(`source ${s.path}: ${w}`);
    if (!sourceRoot) continue;
    const abs = join(sourceRoot, s.path);
    if (!existsSync(abs)) { out.push(`source ${s.path} is not in ${sourceRoot}`); continue; }
    const text = readFileSync(abs);
    if (sha256(text) !== s.sha256) out.push(`source ${s.path} changed since the build (SHA-256 differs)`);
    const t = text.toString('latin1');
    for (const [re, what] of MARKERS) if (re.test(t)) out.push(`source ${s.path} contains ${what}`);
    if ((t.match(FUNC_DEF)?.length ?? 0) > MAX_FUNC_DEFS || (t.match(SUB_NAME)?.length ?? 0) > MAX_SUB_NAMES) out.push(`source ${s.path} holds lifted functions`);
  }
  return out;
}

/** Rule 17: read and check an asset folder's manifest.json; adds its wasm
 *  declarations to `declared`. Returns { files, byUrl } (empty when unusable). */
function assetsManifest(root, problems, declared, { rel = 'manifest.json', prefix = null } = {}) {
  const bad = (why) => problems.push({ file: rel, why });
  const empty = { files: [], byUrl: new Map(), json: null };
  let m;
  try { m = JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch (e) { bad(`missing or unreadable (${e.message})`); return empty; }
  if (!Array.isArray(m.files)) { bad('no files list'); return empty; }
  const files = [];
  const seen = new Set();
  for (const e of m.files) {
    const where = `${rel}: ${e?.path ?? '(no path)'}`;
    const p = (why) => problems.push({ file: where, why });
    if (!e || typeof e.path !== 'string' || !SAFE_REL.test(e.path)) { p('bad or unsafe path'); continue; }
    if (seen.has(e.path.toLowerCase())) p('listed twice'); seen.add(e.path.toLowerCase());
    if (!Number.isSafeInteger(e.size) || e.size < 0) p('bad size');
    if (!HEX64.test(e.sha256 ?? '')) { p('bad sha256'); continue; }
    if (prefix === null && e.url !== `objects/${e.sha256.slice(0, 2)}/${e.sha256}`) p(`url must be objects/${e.sha256.slice(0, 2)}/<sha256>`);
    if (prefix !== null && e.url !== e.path) p('url must be the path (versioned layout)');
    if (e.required !== undefined && typeof e.required !== 'boolean') p('required must be true or false');
    if (e.group !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(String(e.group))) p('bad group name');
    for (const w of nameProblems(e.path, { allowWasm: true })) p(w);
    if (DENY_SHA256.has(e.sha256)) p(`is ${DENY_SHA256.get(e.sha256)} (known SHA-256)`);
    if (extname(e.path).toLowerCase() === '.wasm' && !e.artifact) p('wasm without an artifact record (source, toolchain)');
    if (e.artifact) declared.set(e.sha256, { name: e.path, ...e.artifact, sha256: e.sha256 });
    if (e.chunks !== undefined) {
      if (!Number.isSafeInteger(e.chunkSize) || e.chunkSize <= 0 || !Array.isArray(e.chunks) ||
        e.chunks.length !== Math.ceil(e.size / e.chunkSize) || !e.chunks.every((c) => HEX64.test(c))) p('bad chunk list');
    }
    files.push(e);
  }
  return { files, byUrl: new Map(files.map((e) => [prefix === null ? e.url : `${prefix}${e.path}`, e])), json: m };
}

/** Rule 18: a versioned bucket tree. Returns { byUrl: tree path -> entry, extra: Set of allowed non-file paths }. */
function r2Tree(root, problems, declared) {
  const byUrl = new Map(), extra = new Set(['latest.json']);
  const bad = (file, why) => problems.push({ file, why });
  const versions = existsSync(join(root, 'v')) ? readdirSync(join(root, 'v')) : [];
  if (!versions.length) bad('v/', 'no versions');
  for (const v of versions) {
    const rel = `v/${v}/manifest.json`;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$/.test(v)) bad(`v/${v}`, 'version folder name must be <N.N.N>-<12 hex>');
    extra.add(rel);
    const m = assetsManifest(root, problems, declared, { rel, prefix: `v/${v}/` });
    if (m.json && m.json.version !== v) bad(rel, `version ${m.json.version} differs from its folder ${v}`);
    for (const [k, e] of m.byUrl) byUrl.set(k, e);
  }
  let latest;
  try { latest = JSON.parse(readFileSync(join(root, 'latest.json'), 'utf8')); } catch (e) { bad('latest.json', `missing or unreadable (${e.message})`); return { byUrl, extra }; }
  if (latest.format !== 'delivery-latest/1' || typeof latest.version !== 'string' || latest.manifest !== `v/${latest.version}/manifest.json` || !HEX64.test(latest.sha256 ?? ''))
    bad('latest.json', 'not a version pointer ({ format: delivery-latest/1, version, manifest: v/<version>/manifest.json, sha256, size })');
  else if (!existsSync(join(root, latest.manifest))) bad('latest.json', `points at ${latest.manifest}, which is not in the tree`);
  else {
    const body = readFileSync(join(root, latest.manifest));
    if (sha256(body) !== latest.sha256 || body.length !== latest.size) bad('latest.json', `size/SHA-256 differ from ${latest.manifest}`);
  }
  return { byUrl, extra };
}

function head(file, at, n) {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, at); return b.subarray(0, got); } finally { closeSync(fd); }
}

export function verifyPackage(root, { quiet = false, site = false, allowMedia = [], list = false,
  delivery = false, assets = false, r2 = false, declared = null, sourceRoot = null } = {}) {
  root = resolve(root);
  const problems = [];
  // --delivery: what may be a wasm module here (rule 12).
  let manifest = null;
  if (delivery) {
    declared = new Map(declared ?? []);
    if (existsSync(join(root, 'artifacts.json'))) {
      try { for (const [k, v] of readDeclarations(join(root, 'artifacts.json'))) declared.set(k, v); }
      catch (e) { problems.push({ file: 'artifacts.json', why: `unreadable (${e.message})` }); }
    }
    if (assets) manifest = assetsManifest(root, problems, declared);
    else if (r2) manifest = r2Tree(root, problems, declared);
  }
  const files = walk(root, { skip: (rel) => rel === '.git' });
  // play/sync.json: what tools/sync-play.mjs wrote (site mode).
  let synced = null;
  if (site && existsSync(join(root, 'play', 'sync.json'))) {
    try { synced = new Map(JSON.parse(readFileSync(join(root, 'play', 'sync.json'), 'utf8')).files.map((f) => [`play/${f.path}`, f])); }
    catch (e) { problems.push({ file: 'play/sync.json', why: `unreadable (${e.message})` }); synced = new Map(); }
  }
  let bytes = 0;
  for (const f of files) {
    const add = (why) => problems.push({ file: f.rel, why });
    if (f.link) { add('symlink or junction (could point at game data)'); continue; }
    const abs = join(root, f.rel);
    const ext = extname(f.rel).toLowerCase();
    bytes += f.size;
    const wasmExt = ext === '.wasm';
    if (BAD_EXT.has(ext) && !(delivery && wasmExt)) add(`forbidden file type ${ext}`);
    let wasmMagic = false;
    if (f.size > MAX_BYTES) add(`over 5 MB (${f.size} bytes)`);
    if (/(^|\/)src\/recomp\/gen(\/|$)/i.test(f.rel)) add('inside src/recomp/gen');
    if (GEN_NAMES.test(basename(f.rel))) add('named like lifter output');
    if (f.size >= 4) {
      const h = head(abs, 0, 8);
      if (h.subarray(0, 4).toString('latin1') === 'XBEH') add('XBE header (XBEH)');
      if (h.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) { if (delivery) wasmMagic = true; else add('wasm module header'); }
      if (h.subarray(0, 4).toString('latin1') === 'RIFF' && head(abs, 8, 4).toString('latin1') === 'WAVE') add('RIFF/WAVE audio');
    }
    if (f.size >= 0x10014 && head(abs, 0x10000, 20).toString('latin1') === 'MICROSOFT*XBOX*MEDIA') add('Xbox disc image');
    if (TEXT_EXT.has(ext) && f.size <= MAX_BYTES * 4) {
      const text = readFileSync(abs, 'latin1');
      for (const [re, what] of MARKERS) if (re.test(text)) add(`contains ${what}`);
      const defs = text.match(FUNC_DEF)?.length ?? 0;
      if (defs > MAX_FUNC_DEFS) add(`${defs} lifted-function definitions (void sub_XXXXXXXX(void))`);
    }
    if (site) siteRules(f, abs, ext, add);
    if (delivery) deliveryRules(f, abs, ext, add, wasmExt || wasmMagic);
  }
  if (manifest) {
    // rules 17/18: every file is a manifest, the pointer, artifacts.json (17) or a listed object.
    const listed = manifest.byUrl;
    const allowed = manifest.extra ?? new Set(['manifest.json', 'artifacts.json']);
    for (const f of files) {
      if (f.link || allowed.has(f.rel)) continue;
      const e = listed.get(f.rel);
      if (!e) problems.push({ file: f.rel, why: `not an object listed in ${manifest.extra ? 'a v/<version>/manifest.json' : 'manifest.json'} (only listed objects may be served)` });
      else if (e.size !== f.size) problems.push({ file: f.rel, why: `size ${f.size} differs from the manifest's ${e.size} (${e.path})` });
    }
    const present = new Set(files.map((f) => f.rel));
    for (const [u, e] of listed) if (!present.has(u)) problems.push({ file: u, why: `listed in a manifest (${e.path}) but missing` });
  }
  function deliveryRules(f, abs, ext, add, isWasm) {
    if (DELIVERY_BAD_EXT.has(ext)) add(`forbidden file type ${ext} (save file)`);
    if (GAME_PATHS.test(f.rel)) add("under a path of the game's build or storage");
    if (GAME_WASM_NAME.test(basename(f.rel))) add('named like the game module (atv2*.wasm)');
    if (f.size > MAX_BYTES * 16) { if (isWasm) add('wasm module that is not a declared artifact (too large to check)'); return; }
    const buf = readFileSync(abs);
    const sum = sha256(buf);
    if (DENY_SHA256.has(sum)) add(`is ${DENY_SHA256.get(sum)} (known SHA-256)`);
    if (manifest && manifest.byUrl.get(f.rel) && manifest.byUrl.get(f.rel).sha256 !== sum)
      add(`SHA-256 differs from the manifest's (${manifest.byUrl.get(f.rel).path})`);
    const text = buf.toString('latin1');
    if (!TEXT_EXT.has(ext)) for (const [re, what] of MARKERS) if (re.test(text)) add(`contains ${what}`);
    const subs = text.match(SUB_NAME)?.length ?? 0;
    if (subs > MAX_SUB_NAMES) add(`${subs} recompiled-function names (sub_XXXXXXXX)`);
    if ((TEXT_EXT.has(ext) || SITE_TEXT_EXT.has(ext)) && GEN_WGSL.test(text)) add('contains generated WGSL from the game (the shader generator\'s uniform blocks)');
    if (isWasm) {
      const d = declared.get(sum);
      if (!d) { add('wasm module that is not a declared artifact of this repository (no declaration with its SHA-256)'); return; }
      const why = declarationProblems(d, sourceRoot);
      for (const w of why) add(`declared wasm ${d.name ?? ''}: ${w}`);
    }
  }
  if (site) {
    if (synced) {
      for (const rel of synced.keys()) if (!files.some((f) => f.rel === rel)) problems.push({ file: rel, why: 'listed in play/sync.json but missing' });
    } else if (files.some((f) => f.rel.startsWith('play/'))) problems.push({ file: 'play/', why: 'no play/sync.json: play/ must be written by tools/sync-play.mjs' });
  }
  function siteRules(f, abs, ext, add) {
    const name = basename(f.rel);
    if (MEDIA_EXT.has(ext) && !allowMedia.includes(f.rel)) add(`media or archive file ${ext} (game screens, textures, sounds and movies are never allowed; ` +
      'check our own art by hand and pass --allow-media)');
    if (SAVE_NAMES.test(name)) add('named like a save file');
    if (f.size > SITE_MAX_BYTES) add(`over 1 MB (${f.size} bytes)`);
    if (SITE_TEXT_EXT.has(ext) && f.size <= MAX_BYTES * 4) {
      const text = readFileSync(abs, 'latin1');
      if (GEN_WGSL.test(text)) add('contains generated WGSL (the shader generator\'s uniform blocks)');
      const eps = text.match(ENTRY_POINTS)?.length ?? 0;
      if (eps > 4) add(`${eps} WGSL entry points in one file (a shader dump?)`);
      if (B64_RUN.test(text)) add('a long base64 run (embedded binary data)');
      else if (B64_DATA_URL.test(text)) add('a large base64 data: URL (embedded binary data)');
    } else if (!SITE_TEXT_EXT.has(ext) && !MEDIA_EXT.has(ext) && !BAD_EXT.has(ext) && !/^(_headers|_redirects|LICENSE|\.assetsignore|\.gitattributes)$/.test(name))
      add(`unexpected file type ${ext || '(none)'} for a static site`);
    if (synced && f.rel.startsWith('play/') && f.rel !== 'play/sync.json') {
      const s = synced.get(f.rel);
      if (!s) add('in play/ but not written by tools/sync-play.mjs (not in play/sync.json)');
      else if (s.size !== f.size || s.sha256 !== createHash('sha256').update(readFileSync(abs)).digest('hex'))
        add('changed since tools/sync-play.mjs wrote it (size or SHA-256 differs from play/sync.json)');
    }
  }
  const ok = problems.length === 0;
  if (list && !quiet) for (const f of files) console.log(`      ${String(f.size ?? 0).padStart(9)}  ${f.rel}`);
  if (!quiet) {
    for (const p of problems) console.log(`FAIL  ${p.file}: ${p.why}`);
    console.log(`${ok ? 'OK' : 'FAILED'}: ${root}: ${files.length} files, ${(bytes / 2 ** 20).toFixed(1)} MB, ${problems.length} problem(s)`);
  }
  return { ok, root, files: files.length, bytes, problems };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const allowMedia = args.flatMap((a, i) => (a === '--allow-media' && args[i + 1] ? [args[i + 1].replace(/\\/g, '/')] : []));
  const dir = args.find((a, i) => !a.startsWith('--') && !['--allow-media', '--source-root', '--artifacts'].includes(args[i - 1])) ?? dirname(fileURLToPath(import.meta.url));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { console.error(`not a folder: ${dir}`); process.exit(2); }
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const r = verifyPackage(dir, { quiet: args.includes('--quiet') || args.includes('--json'), site: args.includes('--site'), allowMedia,
    list: args.includes('--list'), delivery: args.includes('--delivery') || args.includes('--assets') || args.includes('--r2'), assets: args.includes('--assets'), r2: args.includes('--r2'),
    sourceRoot: val('--source-root') ? resolve(val('--source-root')) : null,
    declared: val('--artifacts') ? readDeclarations(val('--artifacts')) : null });
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
