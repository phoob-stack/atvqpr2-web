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
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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

function head(file, at, n) {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, at); return b.subarray(0, got); } finally { closeSync(fd); }
}

export function verifyPackage(root, { quiet = false, site = false, allowMedia = [], list = false } = {}) {
  root = resolve(root);
  const problems = [];
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
    if (BAD_EXT.has(ext)) add(`forbidden file type ${ext}`);
    if (f.size > MAX_BYTES) add(`over 5 MB (${f.size} bytes)`);
    if (/(^|\/)src\/recomp\/gen(\/|$)/i.test(f.rel)) add('inside src/recomp/gen');
    if (GEN_NAMES.test(basename(f.rel))) add('named like lifter output');
    if (f.size >= 4) {
      const h = head(abs, 0, 8);
      if (h.subarray(0, 4).toString('latin1') === 'XBEH') add('XBE header (XBEH)');
      if (h.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) add('wasm module header');
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
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--allow-media') ?? dirname(fileURLToPath(import.meta.url));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { console.error(`not a folder: ${dir}`); process.exit(2); }
  const r = verifyPackage(dir, { quiet: args.includes('--quiet') || args.includes('--json'), site: args.includes('--site'), allowMedia,
    list: args.includes('--list') });
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
