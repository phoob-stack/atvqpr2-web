#!/usr/bin/env node
// builder.mjs - build ATV: Quad Power Racing 2 for the browser from your own
// game files, on your own machine, and play it on http://127.0.0.1.
//
//   node builder.mjs [<game folder>] [options]        (Windows: build-atv2.cmd)
//
// <game folder> is your extracted USA retail disc: the folder with default.xbe,
// ATV.bah and ATV.bad. Without it you are asked for it.
//
// Options:
//   --game <dir>           the game folder (same as the first argument)
//   --work <dir>           work folder for the lifted code and the build
//                          (default: %LOCALAPPDATA%\atv2-builder\work on Windows,
//                          ~/.local/share/atv2-builder/work on Linux,
//                          ~/Library/Application Support/atv2-builder/work on macOS)
//   --wasi-sdk <dir>       an installed wasi-sdk 34 (else WASI_SDK_PATH, else the
//                          builder's own toolchains folder, else download it)
//   --toolchains <dir>     where a downloaded wasi-sdk goes (default <data dir>/toolchains)
//   --wasi-sdk-mirror <u>  base URL (http/https/file) to download wasi-sdk from
//                          instead of the GitHub release
//   --yes                  download wasi-sdk without asking
//   --python <cmd>         Python 3.10+ to run the lifter (default: py -3 / python3)
//   --bash <path>          bash for web/wasm/build.sh (default: Git Bash on Windows)
//   --port <n>             local server port (default 8460)
//   --import               serve without the game folder: the page asks you to
//                          import it into the browser's storage instead
//   --no-serve             build only; do not start the server
//   --no-open              start the server but do not open the browser
//   --play-dir <dir>       where to write the play folder for the project site
//                          (default <data dir>/atv2-play, next to the work folder)
//   --no-play-dir          do not write the play folder
//   --rebuild              redo every stage even if its inputs did not change
//   --verify-only          only check the game folder and the tools
//   --help
//
// Stages (each timed; a stage whose inputs did not change is skipped):
//   1. tools       Python + capstone, bash, Node, wasi-sdk (found or downloaded)
//   2. game        default.xbe size and SHA-256 = the USA retail game
//   3. sources     copy this package's sources into <work>/tree
//   4. lift        xboxrecomp: xbe_parser, disasm, func_id, abi_analysis, recomp
//                  -> <work>/tree/atvrecomp/src/recomp/gen (generated C)
//   5. compile     web/wasm/build.sh with wasi-sdk -> <work>/tree/atvrecomp/build-wasm/atv2.wasm
//                  (reproducible: the same bytes on every PC; compared with
//                  config/build-expected.json, the build the project site takes)
//   6. play folder <data dir>/atv2-play: your game files (hard links, or copies
//                  on another drive) + atv2.wasm + atv2-build.json, the one
//                  folder to pick on the project site ("Select local game files")
//   7. serve       web/host/serve.mjs on 127.0.0.1, then the browser
// Everything made from the game stays in <work> and the play folder; this
// package and your game folder are never written.
import { existsSync, readFileSync, writeFileSync, appendFileSync, rmSync, rmdirSync, statSync, copyFileSync, readdirSync, statfsSync } from 'node:fs';
import { join, resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import { isWin, run, probe, walk, ensureDir, fmtSecs, fmtBytes, toPosix, sha256File } from './lib/util.mjs';
import { verifyGameFolder, GameError, GAME } from './lib/game.mjs';
import { ensureWasiSdk, WASI_SDK_VERSION } from './lib/wasi-sdk.mjs';
import { findPython, findBash, bashVersion, findBrowser } from './lib/tools.mjs';
import { makePlayFolder, PlayError } from './lib/play.mjs';

const PKG = dirname(fileURLToPath(import.meta.url));
const PINNED = JSON.parse(readFileSync(join(PKG, 'PINNED.json'), 'utf8'));
const SOURCES = join(PKG, 'sources');
// The build the project site's page was made for (size and SHA-256 only).
const EXPECTED = (() => { try { return JSON.parse(readFileSync(join(PKG, 'config', 'build-expected.json'), 'utf8')); } catch { return null; } })();
// Measured on the reference PC (README): the work folder ends up at ~220 MB.
const WORK_BYTES_NEEDED = 1 * 2 ** 30;
const SDK_BYTES_NEEDED = 3 * 2 ** 30;   // archive + unpacked, during a download

// ---- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
const FLAGS = new Set(['--yes', '--import', '--no-serve', '--no-open', '--no-play-dir', '--rebuild', '--verify-only', '--help', '-h']);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS.has(a)) opts[a.replace(/^-+/, '')] = true;
  else if (a.startsWith('--')) {
    if (i + 1 >= argv.length) die(`${a} needs a value`);
    opts[a.slice(2)] = argv[++i];
  } else positional.push(a);
}
if (opts.help || opts.h) {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const KNOWN = ['game', 'work', 'wasi-sdk', 'toolchains', 'wasi-sdk-mirror', 'python', 'bash', 'port', 'play-dir', ...[...FLAGS].map((f) => f.replace(/^-+/, ''))];
for (const k of Object.keys(opts)) if (!KNOWN.includes(k)) die(`unknown option --${k} (see --help)`);

function die(msg, code = 1) { console.error(`\nERROR: ${msg}`); process.exit(code); }
const say = (s = '') => console.log(s);

function dataDir() {
  if (isWin) return join(process.env.LOCALAPPDATA ?? join(os.homedir(), 'AppData', 'Local'), 'atv2-builder');
  if (process.platform === 'darwin') return join(os.homedir(), 'Library', 'Application Support', 'atv2-builder');
  return join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local', 'share'), 'atv2-builder');
}
const inside = (parent, p) => { const r = relative(resolve(parent), resolve(p)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

// ---- timing --------------------------------------------------------------------
const timings = [];
async function stage(name, fn) {
  const t0 = performance.now();
  say(`\n== ${name}`);
  try {
    const r = await fn();
    const s = (performance.now() - t0) / 1000;
    timings.push({ stage: name, seconds: +s.toFixed(2), status: r?.skipped ? 'skipped' : 'ok', ...(r?.note ? { note: r.note } : {}) });
    say(`   ${r?.skipped ? 'up to date, skipped' : 'done'} (${fmtSecs(s)})`);
    return r;
  } catch (e) {
    timings.push({ stage: name, seconds: +((performance.now() - t0) / 1000).toFixed(2), status: 'failed', error: String(e.message ?? e) });
    throw e;
  }
}

// ---- prompts -------------------------------------------------------------------
async function ask(question) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}
async function confirm(message) {
  if (opts.yes) { say(message + ' (--yes)'); return true; }
  const a = await ask(`${message} [y/N] `);
  return a !== null && /^y(es)?$/i.test(a);
}
async function pickGameFolder() {
  if (isWin && process.stdin.isTTY) {
    say('Choose your ATV: Quad Power Racing 2 game folder (the one with default.xbe) in the window that opens...');
    const ps = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
      "$d.Description = 'Your extracted ATV: Quad Power Racing 2 (USA) game folder: the one with default.xbe, ATV.bah and ATV.bad'; " +
      "$d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8' });
    const p = (r.stdout ?? '').trim();
    if (p) return p;
  }
  const a = await ask('Game folder (the one with default.xbe): ');
  return a ? a.replace(/^"(.*)"$/, '$1') : null;
}

// ---- state (what each stage was last built from) -----------------------------
let W, STATE_FILE, state;
const keyOf = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 32);
function saveState() { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function treeHash(dir) {
  const h = createHash('sha256');
  for (const f of walk(dir).sort((a, b) => (a.rel < b.rel ? -1 : 1))) { h.update(f.rel + '\0'); h.update(readFileSync(join(dir, f.rel))); }
  return h.digest('hex').slice(0, 32);
}

// Mirror src into dst: copy every file, remove files dst has that src does
// not, never touch `keep` (relative paths) and never follow a link.
function mirror(src, dst, keep = []) {
  ensureDir(dst);
  const want = new Set();
  for (const f of walk(src)) {
    want.add(f.rel);
    const to = join(dst, f.rel);
    ensureDir(dirname(to));
    copyFileSync(join(src, f.rel), to);
  }
  const kept = (rel) => keep.some((k) => rel === k || rel.startsWith(k + '/')) || rel.split('/').includes('__pycache__');
  const prune = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = toPosix(relative(dst, p));
      if (kept(rel) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) { prune(p); if (!readdirSync(p).length) rmdirSync(p); }
      else if (!want.has(rel)) rmSync(p, { force: true });
    }
  };
  prune(dst);
}

// clang's -ffile-prefix-map for the tree, in the spellings clang can be given
// it: on Windows Git Bash hands native programs C:/... (drive letter upper
// case), and a path typed with a lower-case drive stays that way.
function reproducibleFlags(tree) {
  const p = toPosix(resolve(tree));
  // build.sh does not quote its paths: a tree with a space in it does not build at all.
  if (/\s/.test(p)) return '';
  const forms = new Set([p]);
  if (/^[A-Za-z]:\//.test(p)) { forms.add(p[0].toUpperCase() + p.slice(1)); forms.add(p[0].toLowerCase() + p.slice(1)); }
  return [...forms].map((f) => `-ffile-prefix-map=${f}=atv2`).join(' ');
}

// ================================================================================
async function main() {
  say(`ATV: Quad Power Racing 2 builder ${PINNED.version} (atvrecomp ${PINNED.atvrecomp.commit.slice(0, 7)}, xboxrecomp ${PINNED.xboxrecomp.commit.slice(0, 7)})`);
  if (!existsSync(join(SOURCES, 'atvrecomp', 'web', 'wasm', 'build.sh')) || !existsSync(join(SOURCES, 'xboxrecomp', 'tools', 'recomp')))
    die(`this package is incomplete: ${SOURCES} is missing sources`);

  // Folders.
  const DATA = dataDir();
  W = resolve(opts.work ?? join(DATA, 'work'));
  const TOOLCHAINS = resolve(opts.toolchains ?? join(DATA, 'toolchains'));
  if (inside(PKG, W)) die(`the work folder must be outside this package (${PKG})`);
  const legacy = isWin && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'xboxrecomp') : null;
  if (legacy && inside(legacy, W)) die(`do not use ${legacy} as the work folder (that is where the native game keeps its saves)`);
  let gameDir = opts.game ?? positional[0] ?? null;
  if (!gameDir) gameDir = await pickGameFolder();
  if (!gameDir) die('no game folder. Run: build-atv2 <your game folder>   (the folder with default.xbe)');
  gameDir = resolve(gameDir);
  if (inside(gameDir, W) || inside(W, gameDir)) die('the work folder and the game folder must not contain each other');
  const PLAY = opts['no-play-dir'] ? null : resolve(opts['play-dir'] ?? join(DATA, 'atv2-play'));
  if (PLAY && (inside(PKG, PLAY) || inside(PLAY, PKG))) die(`the play folder must be outside this package (${PKG})`);
  if (PLAY && (inside(gameDir, PLAY) || inside(PLAY, gameDir))) die('the play folder and the game folder must not contain each other (the game folder is never written)');
  if (PLAY && (inside(PLAY, W) || inside(W, PLAY))) die('the play folder and the work folder must be separate folders');
  ensureDir(W);
  ensureDir(join(W, 'logs'));
  STATE_FILE = join(W, 'state.json');
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { state = {}; }
  say(`game folder:  ${gameDir}`);
  say(`work folder:  ${W}`);

  // 1. tools
  const tools = await stage('1. tools', async () => {
    const node = process.versions.node;
    if (Number(node.split('.')[0]) < 18) throw new Error(`Node ${node} is too old: install Node 22 LTS or newer`);
    if (Number(node.split('.')[0]) < 22) say(`   warning: Node ${node}; tested with 24.13.1 (22+ recommended)`);
    const python = findPython(opts.python);
    say(`   node ${node}`);
    say(`   python ${python.version} (${[python.cmd, ...python.args].join(' ')}), capstone ${python.capstone}`);
    const bash = findBash(opts.bash);
    say(`   bash ${bashVersion(bash) ?? '?'} (${bash})`);
    try {
      const free = statfsSync(W).bavail * statfsSync(W).bsize;
      say(`   free space at the work folder: ${fmtBytes(free)}`);
      if (free < WORK_BYTES_NEEDED) say(`   warning: less than ${fmtBytes(WORK_BYTES_NEEDED)} free; the build may run out of space`);
    } catch { /* statfs not available */ }
    const sdk = await ensureWasiSdk({ explicit: opts['wasi-sdk'] && resolve(opts['wasi-sdk']), toolchains: TOOLCHAINS,
      mirror: opts['wasi-sdk-mirror'], log: join(W, 'logs', 'wasi-sdk.log'), say: (s) => say(s),
      confirm: async (m) => {
        try { if (statfsSync(dirname(TOOLCHAINS)).bavail * statfsSync(dirname(TOOLCHAINS)).bsize < SDK_BYTES_NEEDED) say(`   warning: under ${fmtBytes(SDK_BYTES_NEEDED)} free for the SDK`); } catch { /* */ }
        return confirm(m);
      } });
    say(`   wasi-sdk ${sdk.version} (${sdk.dir}${sdk.source === 'given' ? '' : `, ${sdk.source}`})`);
    return { python, bash, sdk };
  });

  // 2. game
  const game = await stage('2. game files', async () => {
    try {
      const g = await verifyGameFolder(gameDir);
      say(`   ${GAME.title}, ${GAME.region}: default.xbe ${g.size} bytes, SHA-256 ${g.sha256.slice(0, 16)}... matches`);
      return g;
    } catch (e) {
      if (e instanceof GameError) die(e.message);
      throw e;
    }
  });
  if (opts['verify-only']) { finish(); return; }

  // 3. sources
  const TREE = join(W, 'tree');
  const ATV = join(TREE, 'atvrecomp');
  const RT = join(TREE, 'xboxrecomp');
  const GEN = join(ATV, 'src', 'recomp', 'gen');
  const WASM = join(ATV, 'build-wasm', 'atv2.wasm');
  const hashes = await stage('3. sources', async () => {
    const h = { atvrecomp: treeHash(join(SOURCES, 'atvrecomp')), xboxrecomp: treeHash(join(SOURCES, 'xboxrecomp')) };
    mirror(join(SOURCES, 'xboxrecomp'), RT);
    // gen/ and build-wasm/ are this build's own output; game/ may be a
    // developer's link to test data. None of them is in the package.
    mirror(join(SOURCES, 'atvrecomp'), ATV, ['src/recomp', 'build-wasm', 'game']);
    say(`   ${TREE}`);
    return h;
  });

  // 4. lift
  const seed = join(ATV, 'config', 'seed_functions.json');
  const liftKey = keyOf({ v: 1, xbe: game.sha256, xboxrecomp: hashes.xboxrecomp, seed: createHash('sha256').update(readFileSync(seed)).digest('hex') });
  const LIFT = join(W, 'lift');
  const liftFresh = !opts.rebuild && state.lift === liftKey && existsSync(join(GEN, 'recomp_dispatch.c'));
  await stage('4. lift (xboxrecomp pipeline)', async () => {
    if (liftFresh) return { skipped: true };
    delete state.lift; delete state.compile; saveState();
    rmSync(LIFT, { recursive: true, force: true });
    ensureDir(LIFT);
    rmSync(GEN, { recursive: true, force: true });
    ensureDir(GEN);
    // The pipeline reads its own copy of default.xbe in the work folder, so the
    // game folder is only ever read (and the analysis JSON lands here too).
    const xbe = join(LIFT, 'default.xbe');
    copyFileSync(game.xbe, xbe);
    const analysis = join(LIFT, 'default_analysis.json');
    const py = (mod, args) => async () => {
      const log = join(W, 'logs', `lift-${mod}.log`);
      rmSync(log, { force: true });
      const code = await run(tools.python.cmd, [...tools.python.args, '-m', `tools.${mod}`, ...args], { cwd: RT, log });
      if (code !== 0) {
        const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-25).join('\n');
        throw new Error(`tools.${mod} failed (exit ${code}); log ${log}\n${tail}`);
      }
      return { note: `log ${log}` };
    };
    const D = join(LIFT, 'disasm'), F = join(LIFT, 'func_id'), A = join(LIFT, 'abi'), R = join(LIFT, 'recomp');
    await stage('4a. lift: xbe_parser', py('xbe_parser', [xbe, '--json', analysis, '--quiet']));
    await stage('4b. lift: disasm', py('disasm', [xbe, '-o', D, '--analysis-json', analysis, '--seed-functions', seed]));
    await stage('4c. lift: func_id', py('func_id', [xbe, '--functions', join(D, 'functions.json'), '--strings', join(D, 'strings.json'),
      '--xrefs', join(D, 'xrefs.json'), '-o', F]));
    await stage('4d. lift: abi_analysis', py('abi_analysis', [xbe, '--disasm-dir', D, '--func-id-dir', F, '--output-dir', A]));
    await stage('4e. lift: recomp', py('recomp', [xbe, '--all', '--split', '250', '--gen-dir', GEN, '--disasm-dir', D, '--func-id-dir', F,
      '--abi-dir', A, '-o', R, '--icall-sites', join(R, 'icall_sites.none.json')]));
    const disp = readFileSync(join(GEN, 'recomp_dispatch.c'), 'utf8').match(/Maps (\d+) Xbox VAs/)?.[1];
    const chunks = readdirSync(GEN).filter((f) => /^recomp_\d{4}\.c$/.test(f)).length;
    say(`   generated C: ${chunks} chunk files, ${disp} dispatch entries in ${GEN}`);
    state.lift = liftKey; state.liftInfo = { chunks, dispatch: Number(disp) }; saveState();
    return { note: `${chunks} chunks, ${disp} dispatch entries` };
  });

  // 5. compile
  // The work folder's path must not end up in the module (an assert's __FILE__
  // does): every build of the same sources is then byte-identical, wherever its
  // work folder is, and the project site can check it against EXPECTED.
  const prefixMap = reproducibleFlags(TREE);
  const compileKey = keyOf({ v: 2, lift: liftKey, atvrecomp: hashes.atvrecomp, sdk: tools.sdk.version, prefixMap: true });
  const compileFresh = !opts.rebuild && state.compile === compileKey && existsSync(WASM);
  await stage('5. compile (wasi-sdk -> atv2.wasm)', async () => {
    if (compileFresh) return { skipped: true };
    delete state.compile; saveState();
    const log = join(W, 'logs', 'compile.log');
    rmSync(log, { force: true });
    const t0 = Date.now();
    let section = '', fails = [], oks = 0;
    const env = { ...process.env, PATH: `${dirname(process.execPath)}${isWin ? ';' : ':'}${process.env.PATH}`,
      WASM_CFLAGS_EXTRA: prefixMap };
    delete env.WASM_KEEP_DEBUG; delete env.SKIP_GEN;
    const sdkArg = isWin ? tools.sdk.dir.split(sep).join('/') : tools.sdk.dir;
    const code = await run(tools.bash, [toPosix(join(ATV, 'web', 'wasm', 'build.sh')), sdkArg], { cwd: ATV, env, log,
      echo: (l) => {
        if (l.startsWith('== ')) { section = l; say(`   ${l}`); }
        else if (l.startsWith('OK ')) oks++;
        else if (l.startsWith('FAIL ')) { fails.push(`${section}: ${l}`); say(`   ${l}`); }
        else if (/undefined symbols|atv2\.wasm$/.test(l)) say(`   ${l}`);
      } });
    say(`   ${oks} files compiled, ${fails.length} failed; log ${log}`);
    if (!existsSync(WASM) || statSync(WASM).mtimeMs < t0 - 2000)
      throw new Error(`no new atv2.wasm (build.sh exit ${code}); see ${log}`);
    if (fails.some((f) => f.includes('generated shards'))) throw new Error(`generated code failed to compile; see ${log}`);
    say(`   ${WASM} (${fmtBytes(statSync(WASM).size)})`);
    state.compile = compileKey; saveState();
    return { note: `${oks} compiled, ${fails.length} failed` };
  });

  // Is it the reference build (the one the project site's page takes)?
  const wasmSha = await sha256File(WASM), wasmSize = statSync(WASM).size;
  const ref = EXPECTED && EXPECTED.builder === PINNED.version && EXPECTED.atvrecomp === PINNED.atvrecomp.commit &&
    EXPECTED.xboxrecomp === PINNED.xboxrecomp.commit && EXPECTED.wasiSdk === tools.sdk.version ? EXPECTED : null;
  const reference = ref ? ref.wasm.size === wasmSize && ref.wasm.sha256 === wasmSha : null;
  say(`   atv2.wasm ${wasmSize} bytes, SHA-256 ${wasmSha}`);
  if (reference === true) say("   = the reference build of this builder version: the project site's page takes it");
  else if (reference === false) say(`   warning: this is not the reference build (${ref.wasm.sha256.slice(0, 16)}..., ${ref.wasm.size} bytes). ` +
    'It runs on the local server, but the project site will refuse it. Run again with --rebuild; if it still differs, report it.');
  else say(`   (no reference hash for builder ${PINNED.version} with wasi-sdk ${tools.sdk.version}: the project site may refuse this build)`);

  // 6. play folder
  if (PLAY) {
    await stage('6. play folder (for the project site)', async () => {
      let r;
      try {
        r = await makePlayFolder({ dir: PLAY, gameDir, game, wasm: WASM, memoryJson: join(ATV, 'build-wasm', 'atv2.memory.json'),
          info: { builder: PINNED.version, atvrecomp: PINNED.atvrecomp.commit, xboxrecomp: PINNED.xboxrecomp.commit, wasiSdk: tools.sdk.version, reference } });
      } catch (e) { if (e instanceof PlayError) die(e.message); throw e; }
      say(`   ${PLAY}`);
      say(`   ${r.files} game files (${fmtBytes(r.bytes)}; ${r.how === 'hardlinks' ? 'hard links, no extra space' : r.how === 'copies' ? 'copies' : `${r.linked} hard links, ${r.copied} copies`}` +
        `${r.removed ? `, ${r.removed} old files removed` : ''}) + atv2.wasm + atv2-build.json`);
      say('   To play on the project site: Play > "Select local game files" > choose this folder.');
      state.play = { dir: PLAY, wasm: r.wasmSha256 }; saveState();
      return { note: `${r.files} files, ${r.how}` };
    });
  }

  finish();
  if (opts['no-serve']) return;

  // 6. serve
  const port = Number(opts.port ?? 8460);
  const url = `http://127.0.0.1:${port}/`;
  say(`\n== 7. play on this computer`);
  const srvArgs = [join(ATV, 'web', 'host', 'serve.mjs'), '--port', String(port), '--log', join(W, 'logs', 'web.log'),
    ...(opts.import ? [] : ['--game', gameDir])];
  const srv = spawn(process.execPath, srvArgs, { cwd: ATV, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(W, 'server.pid'), String(srv.pid));
  let ready = false, errText = '';
  srv.stderr.on('data', (c) => { errText += c; if (ready) process.stderr.write(c); });
  await new Promise((res, rej) => {
    srv.stdout.on('data', (c) => {
      const s = c.toString();
      if (!ready && s.includes('dev server')) { ready = true; res(); }
      if (ready && /compressed/.test(s)) say(`   (module compressed for faster loading)`);
    });
    srv.on('exit', (code) => { if (!ready) rej(new Error(/EADDRINUSE/.test(errText) ? `port ${port} is in use: pass --port <another>` : `server exited (${code}): ${errText.trim()}`)); });
    setTimeout(() => !ready && rej(new Error('server did not start within 15 s')), 15000);
  });
  say(`   server: ${url}  (127.0.0.1 only, pid ${srv.pid})`);
  say(opts.import ? '   the page will ask for your game folder once and keep a copy in the browser\'s storage'
    : `   game files are read from ${gameDir}`);
  say('   Click the page (or press a key) once to start the sound. Enter = START, Z = A, X = B, arrows; or a gamepad.');
  say('   Press Ctrl+C here to stop the server.');
  if (!opts['no-open']) openBrowser(url);
  const stop = () => { try { srv.kill(); } catch { /* gone */ } rmSync(join(W, 'server.pid'), { force: true }); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  srv.on('exit', (code) => { rmSync(join(W, 'server.pid'), { force: true }); process.exit(code ?? 0); });
}

function openBrowser(url) {
  const b = findBrowser();
  try {
    if (b) spawn(b, [url], { detached: true, stdio: 'ignore' }).unref();
    else if (isWin) spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    say(`   opened ${b ? b.split(/[\\/]/).pop() : 'the default browser'} on ${url} (needs Edge or Chrome with WebGPU)`);
  } catch (e) {
    say(`   could not open a browser (${e.message}); open ${url} yourself in Edge or Chrome`);
  }
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const total = timings.reduce((a, t) => a + (/^\d+\./.test(t.stage) && !/^\d+[a-z]\./.test(t.stage) ? t.seconds : 0), 0);
  say('\n== stage times');
  for (const t of timings) say(`   ${t.stage.padEnd(38)} ${fmtSecs(t.seconds).padStart(12)}  ${t.status}`);
  say(`   ${'total'.padEnd(38)} ${fmtSecs(total).padStart(12)}`);
  try {
    // timings.json: this run; timings-history.jsonl: every run (a later run
    // that skips everything does not hide the first build's times).
    const rec = { date: new Date().toISOString(), host: os.hostname(),
      cpu: os.cpus()[0]?.model, cpus: os.cpus().length, node: process.versions.node, platform: `${process.platform}-${process.arch}`,
      builder: PINNED.version, stages: timings, totalSeconds: +total.toFixed(2) };
    writeFileSync(join(W, 'timings.json'), JSON.stringify(rec, null, 2));
    appendFileSync(join(W, 'timings-history.jsonl'), JSON.stringify(rec) + '\n');
  } catch { /* no work folder yet */ }
}

main().catch((e) => { finish(); die(e.message ?? String(e)); });
