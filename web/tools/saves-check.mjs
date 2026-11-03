// Check browser saves end to end in headless Edge (web/host/saves.js):
//
//   node web/tools/saves-check.mjs [--port 8833] [--profile dir] [--native <folder>] [--opfs] [--out dir]
//
//  1. boot, make a profile in the game (title -> SAVED PROFILES: A creates one ->
//     CHOOSE A RIDER: A -> NAME YOUR RIDER: A on OK) and wait until its save
//     files are in OPFS (atv2-saves);
//  2. reload the page, then close and relaunch the browser on the same profile:
//     the I/O worker must load the same files (SHA-1 of every file compared);
//  3. "Export saves": the downloaded .zip must hold exactly those files, in the
//     native layout (UDATA/4143000a/...), with atv2-saves.json;
//  4. imports that must be refused (not a zip, a damaged zip, a zip of another
//     game's saves): an error in the panel, OPFS unchanged, no backup;
//  5. --native <folder>: "Import the Windows build's save folder" (the
//     <input webkitdirectory> path) with a COPY of a native save dir: after the
//     page restarts the saves are that folder's UDATA/TDATA 4143000a files and
//     the previous ones are a backup; "Put back the previous saves" returns them;
//  6. importing the exported .zip gives the step-1 saves back;
//  7. --opfs (the profile has the game imported, web/tools/import.mjs):
//     "Forget game files" deletes the game files and keeps the saves.
// The profile defaults to a fresh temporary one (it must start without saves).
// Use only copies of saves-seed or saves made by tests, never
// %LOCALAPPDATA%\xboxrecomp. <out> (default build-wasm/saves-check) gets the
// exported zip and the page log.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { readZip, writeZip } = await import(pathToFileURL(join(ROOT, 'web/host/zip.js')).href);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('--port', 8833));
const out = resolve(opt('--out', join(ROOT, 'build-wasm/saves-check')));
const profile = resolve(opt('--profile', mkdtempSync(join(tmpdir(), 'atv2-saves-'))));
const native = opt('--native') && resolve(opt('--native'));
const opfs = argv.includes('--opfs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-web.log'),
  ...(opfs ? [] : ['--game', join(ROOT, 'game/atv2')])], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const url = `http://127.0.0.1:${port}/host/index.html?env=RECOMP_SKIP_MOVIES=1`;
let b = await launch(url, { profile });
const t0 = Date.now();
const say = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${s}`);
let failures = 0;
const check = (ok, what) => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// SHA-1 (12 hex) and size of every file in OPFS atv2-saves, after pending writes.
const opfsHashes = () => b.eval(`(async () => { await atv.saves.idle(); const out = {};
  const walk = async (d, p) => { for await (const h of d.values()) { if (h.kind === 'directory') await walk(h, p + h.name + '/');
    else { const u = new Uint8Array(await (await h.getFile()).arrayBuffer());
      out[p + h.name] = [...new Uint8Array(await crypto.subtle.digest('SHA-1', u))].slice(0, 6).map((v) => v.toString(16).padStart(2, '0')).join('') + ' ' + u.length; } } };
  try { await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('atv2-saves'), ''); } catch { /* none */ }
  return out; })()`);
const sha = (u8) => createHash('sha1').update(u8).digest('hex').slice(0, 12) + ' ' + u8.length;
const same = (a, b2) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b2).sort());
const statusText = () => b.eval(`document.getElementById('status').textContent`).catch(() => '');
const waitTitle = async () => {
  for (let s = 0; s < 150; s++) { await sleep(1000); if ((await statusText()).includes('draws 18,')) return true; }
  throw new Error('no title screen in 150 s');
};
const savesLine = () => b.eval(`atv.log.find((l) => l.includes('saves:') && l.includes('game folder (')) ?? ''`);
const key = async (vk, wait = 4000) => { await b.eval(`atv.key(${vk}, 1)`); await sleep(200); await b.eval(`atv.key(${vk}, 0)`); await sleep(wait); };
const node = async (sel) => {
  const doc = await b.send('DOM.getDocument', { depth: 0 });
  return (await b.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: sel })).result.nodeId;
};
const panelMsg = () => b.eval(`[document.getElementById('saves-msg').className, document.getElementById('saves-msg').textContent]`);
const backups = () => b.eval('atv.saves.backups()');
// Hand a file (or folder) to an input of the Saves panel; true if the page restarted.
const give = async (sel, path) => {
  await b.eval(`window.__sameDoc = 1; document.getElementById('saves').hidden = false; document.getElementById('saves-msg').className = ''; 1`);
  await b.send('DOM.setFileInputFiles', { nodeId: await node(sel), files: [path] });
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const r = await b.eval('typeof window.__sameDoc').catch(() => 'reloading');
    if (r !== 'number') { await waitTitle(); return true; }
    const [cls] = await panelMsg();
    if (cls === 'err') return false;
  }
  return false;
};

try {
  // 1. a profile
  await waitTitle();
  say(`title; ${await savesLine()}`);
  check(Object.keys(await opfsHashes()).length <= 3, 'no profile saves at the start (fresh browser profile)');
  await key(13); await key(90); await key(90); await key(90, 1000);
  let h1 = {};
  for (let i = 0; i < 30; i++) {
    h1 = await opfsHashes();
    if (Object.keys(h1).some((p) => p.endsWith('Rider Data')) && Object.keys(h1).some((p) => p.endsWith('Records'))) break;
    if (i === 10) await key(90, 1000);                       // a press the menu missed
    await sleep(1000);
  }
  check(Object.keys(h1).some((p) => p.endsWith('Rider Data')), `the game's profile save is in OPFS: ${Object.keys(h1).join(', ')}`);
  await sleep(2000);
  h1 = await opfsHashes();

  // 2. reload, then a browser restart
  await b.send('Page.reload', {});
  await sleep(1500); await waitTitle();
  check(same(await opfsHashes(), h1) && (await savesLine()).includes(`saves: ${Object.keys(h1).length} files`),
    `after a reload the I/O worker loaded them: ${(await savesLine()).replace(/.*saves:/, 'saves:')}`);
  await b.close(); await sleep(1500);
  b = await launch(url, { profile });
  await waitTitle();
  check(same(await opfsHashes(), h1) && (await savesLine()).includes(`saves: ${Object.keys(h1).length} files`),
    `after a browser restart too: ${(await savesLine()).replace(/.*saves:/, 'saves:')}`);

  // 3. export
  const dl = join(out, 'download');
  mkdirSync(dl, { recursive: true });
  await b.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  const before = new Set(readdirSync(dl));
  await b.eval(`document.getElementById('saves-btn').click(); new Promise((r) => setTimeout(r, 500)).then(() => document.getElementById('saves-export').click())`);
  let zipPath = null;
  for (let i = 0; i < 20 && !zipPath; i++) {
    await sleep(500);
    const n = readdirSync(dl).find((f) => !before.has(f) && f.endsWith('.zip'));
    if (n) zipPath = join(dl, n);
  }
  check(!!zipPath, `Export saves downloaded ${zipPath}`);
  const zipBytes = new Uint8Array(readFileSync(zipPath));
  const z = await readZip(zipBytes);
  const zh = Object.fromEntries(z.filter((e) => !e.dir && e.path !== 'atv2-saves.json').map((e) => [e.path, sha(e.data)]));
  const man = JSON.parse(new TextDecoder().decode(z.find((e) => e.path === 'atv2-saves.json').data));
  check(same(zh, h1) && man.format === 'atv2-saves' && Object.keys(zh).every((p) => /^(UDATA|TDATA)\/4143000a\//.test(p)),
    `the zip holds exactly the OPFS files, native layout (${Object.keys(zh).length} files, ${zipBytes.length} bytes)`);

  // 4. refused imports
  const bad = join(out, 'bad');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'not-a-zip.zip'), 'this is not a zip file');
  const damaged = zipBytes.slice(); damaged[zipBytes.length >> 1] ^= 0xff;
  writeFileSync(join(bad, 'damaged.zip'), damaged);
  writeFileSync(join(bad, 'other-game.zip'), writeZip([{ path: 'UDATA/4d530004/SAVE/x.bin', data: new Uint8Array([1, 2, 3]) }]));
  writeFileSync(join(bad, 'path-escape.zip'), writeZip([{ path: 'UDATA/4143000a/../../x', data: new Uint8Array([1]) }]));
  for (const f of readdirSync(bad)) {
    const restarted = await give('#saves-file', join(bad, f));
    const [cls, msg] = await panelMsg();
    check(!restarted && cls === 'err' && same(await opfsHashes(), h1) && !(await backups()).length, `${f} refused: "${msg}"`);
  }

  // 5. a native save folder (a copy), and putting the old saves back
  if (native) {
    const want = {};
    const walk = (d, p) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f, p + n + '/'); else want[p + n] = sha(readFileSync(f)); } };
    for (const r of ['UDATA', 'TDATA']) if (existsSync(join(native, r, '4143000a'))) walk(join(native, r, '4143000a'), `${r}/4143000a/`);
    check(await give('#saves-dir', native), `folder import of ${native} restarted the game`);
    const h = await opfsHashes();
    check(same(h, want) && (await savesLine()).includes('imported saves swapped in'), `the saves are now the folder's ${Object.keys(want).length} ATV 2 files`);
    const bk = await backups();
    check(bk.length === 1, `the previous saves were backed up (${bk.join(', ')})`);
    await b.eval(`document.getElementById('saves-btn').click(); 1`); await sleep(800);
    await b.eval(`window.__sameDoc = 1; document.getElementById('saves-restore').click(); 1`);
    await sleep(3000); await waitTitle();
    check(same(await opfsHashes(), h1), 'Put back the previous saves returned the step-1 saves');
  }

  // 6. the exported zip back in
  const nb = (await backups()).length;
  check(await give('#saves-file', zipPath), 'importing the exported zip restarted the game');
  check(same(await opfsHashes(), h1), 'the saves equal the exported ones');
  check((await backups()).length === Math.min(5, nb + 1), `one more backup (${(await backups()).length})`);

  // 8. the API other pages use (saves.js exports)
  const api = (expr) => b.eval(`import('/host/saves.js').then(async (s) => ${expr})`);
  const profs = await api('s.listProfiles()');
  const prof = profs.find((p) => p.kind === 'profile');
  check(prof?.rider === 'Player One' && prof?.name === 'Profile 1' && profs.some((p) => p.kind === 'records'),
    `listProfiles: ${profs.map((p) => `${p.id} ${p.kind} "${p.name}" rider "${p.rider}" ${p.bytes} B`).join('; ')}`);
  const ex = await api(`s.exportSaves({ ids: [${JSON.stringify(prof.id)}] }).then((r) => ({ name: r.name, size: r.size, files: r.files }))`);
  check(ex.files === 5, `exportSaves({ ids: [profile] }): ${ex.name}, ${ex.files} files (the profile's 2 + the title's 3), ${ex.size} bytes`);
  check(await api('s.gameRunningElsewhere()') === false, 'gameRunningElsewhere() is false on the game page itself');
  const del = await api(`s.deleteProfile(${JSON.stringify(prof.id)})`);
  check(del.restartNeeded && !!del.backup, `deleteProfile: staged, backup ${del.backup}`);
  await b.send('Page.reload', {}); await sleep(1500); await waitTitle();
  const left = await api('s.listProfiles()');
  check(!left.some((p) => p.id === prof.id) && !Object.keys(await opfsHashes()).some((p) => p.includes(prof.id)), `after the restart the profile is gone (${left.map((p) => p.kind).join(', ')})`);
  await api('s.listBackups().then((b) => s.restoreBackup(b[0]))');
  await b.send('Page.reload', {}); await sleep(1500); await waitTitle();
  check(same(await opfsHashes(), h1), 'restoreBackup(listBackups()[0]) brought it back');

  // 7. Forget game files keeps the saves
  if (opfs) {
    await b.eval(`document.getElementById('forget').click(); setTimeout(() => document.getElementById('forget').click(), 300); 1`);
    let phase = '';
    for (let i = 0; i < 30 && phase !== 'waiting'; i++) { await sleep(1000); phase = await b.eval('atv.loader.phase').catch(() => ''); }
    const top = await b.eval(`(async () => { const n = []; for await (const h of (await navigator.storage.getDirectory()).values()) n.push(h.name); return n; })()`);
    check(phase === 'waiting' && !top.includes('atv2-game') && same(await opfsHashes(), h1),
      `Forget game files: game files gone, saves kept (OPFS: ${top.join(', ')})`);
  }
} catch (e) {
  failures++;
  say(`FAILED: ${e.message}`);
} finally {
  writeFileSync(join(out, 'saves-check.log'), (await b.eval('atv.log.join("\\n")').catch(() => '')) + '\n');
  await b.close();
  srv.kill();
}
say(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
