// Check the start page, settings, saves/game-data/about tabs and the in-game
// menu in headless Edge, with real input events (CDP Input.*), and save page
// screenshots.
//
//   node web/tools/site.mjs --profile <dir> [--port 8837] [--out dir] [--shots dir] [--game <folder>]
//        [--skip-game] [--first-use <game folder>]
//
// The profile should hold an imported game folder (web/tools/import.mjs with
// the same --profile and --port; OPFS belongs to the profile and the origin),
// or pass --game <folder> to serve one at /data/ instead. Steps:
//   1. the start page: Play tab, game files ready, every tab, phone width;
//   2. settings: change some through the forms and the text box, reload,
//      check they persisted and that the env the game would get changed;
//   3. Play (a real click): the game boots with that env (the page log's
//      "[page] env:" line), the loading card goes away at the first frame;
//   4. the in-game menu: F1 opens it, the game gets no keys meanwhile, FPS
//      counter on, Screenshot saves a PNG, Download log saves a .txt, Esc
//      closes it; the corner button opens it too;
//   5. the settings are reset at the end (the profile is left as found, apart
//      from the import).
// Downloads land in <out>/downloads. Screens are page captures (the game
// frame in them is game-derived: keep <shots> inside atv2-web).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('--port', 8837));
const out = resolve(opt('--out', join(ROOT, 'build-wasm/site')));
const shots = resolve(opt('--shots', join(out, 'screens')));
const dl = join(out, 'downloads');
const game = opt('--game');
const firstUse = opt('--first-use');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(shots, { recursive: true });
rmSync(dl, { recursive: true, force: true });
mkdirSync(dl, { recursive: true });

const srv = spawn(process.execPath, [join(ROOT, 'web/host/serve.mjs'), '--port', String(port), '--log', join(out, 'serve-site.log'),
  ...(game ? ['--game', game] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const base = `http://127.0.0.1:${port}`;
const b = await launch(`${base}/`, { profile: opt('--profile') });
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
let fails = 0;
const check = (ok, what) => { console.log(`${el()} ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; return ok; };
const until = async (expr, secs = 20) => {
  for (let i = 0; i < secs * 10; i++) { if (await b.eval(expr).catch(() => false)) return true; await sleep(100); }
  return false;
};
const shot = async (name) => {
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync(join(shots, name), Buffer.from(r.result.data, 'base64'));
  console.log(`${el()} screen ${join(shots, name)}`);
};
const viewport = (w, h, mobile = false) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
const center = (sel) => b.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const click = async (sel) => {
  const p = await center(sel);
  for (const type of ['mousePressed', 'mouseReleased'])
    await b.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
};
const KEYS = { F1: 112, Escape: 27, Enter: 13, KeyZ: 90 };
const key = async (code, type = 'both') => {
  const k = { code, key: code.replace(/^Key/, '').toLowerCase().replace(/^f1$/, 'F1').replace(/^escape$/, 'Escape').replace(/^enter$/, 'Enter'),
    windowsVirtualKeyCode: KEYS[code] };
  if (type !== 'up') await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
  if (type !== 'down') await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
};
const downloads = () => readdirSync(dl).filter((f) => !f.endsWith('.crdownload')).map((f) => ({ f, size: statSync(join(dl, f)).size }));

try {
  await b.send('Page.enable');
  await b.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await viewport(1280, 860);
  // Start from the default settings (an earlier run's may be left if the browser was killed before it wrote them out).
  await until(`document.body.classList.contains('mode-home')`);
  await b.eval(`localStorage.removeItem('atv2.settings.v1')`);
  await b.send('Page.reload', {});
  await sleep(1000);

  // 0. --first-use <game folder>: a profile with no import. The Play tab shows the import panel, Play is off until
  // the folder is imported (the <input webkitdirectory> fallback, as import.mjs).
  if (firstUse) {
    check(await until(`!document.getElementById('import-slot').hidden && document.getElementById('import-slot').contains(document.getElementById('importer'))
      && !document.getElementById('importer').hidden`, 20), 'first use: the import panel is in the Play tab');
    check(await b.eval(`document.getElementById('btn-play').disabled`), 'first use: Play is off until the import');
    await shot('home-first-use.png');
    const doc = await b.send('DOM.getDocument', { depth: -1 });
    const q = await b.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#gamedir' });
    await b.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [resolve(firstUse)] });
    await sleep(2500);
    await shot('home-importing.png');
    check(await until(`document.getElementById('game-state').classList.contains('ok') && !document.getElementById('btn-play').disabled`, 180),
      'first use: imported, Play on: ' + await b.eval(`document.getElementById('game-state').textContent`));
  }

  // 1. the start page
  check(await until(`document.body.classList.contains('mode-home')`), 'the start page shows (no game boot without a parameter)');
  check(await until(`document.getElementById('game-state').classList.contains('ok')`, 30), 'game files found: ' +
    await b.eval(`document.getElementById('game-state').textContent`));
  check(await b.eval(`!document.getElementById('btn-play').disabled && !document.getElementById('btn-freeride').disabled`), 'Play and Free Ride enabled');
  check(await b.eval(`typeof window.atv === 'undefined'`), 'main.js not loaded on the start page');
  await shot('home-play.png');
  for (const t of ['settings', 'saves', 'data', 'about']) {
    await b.eval(`location.hash = '${t}'`);
    await sleep(t === 'data' ? 2500 : 900);
    check(await b.eval(`!document.getElementById('tab-${t}').hidden && document.getElementById('tab-${t}').innerText.length > 100`), `tab ${t} drawn`);
    await shot(`home-${t}.png`);
  }
  check(await b.eval(`document.querySelectorAll('#changelog > li').length >= 5`), 'changelog listed');
  check(await b.eval(`/Game files \\(your import\\)|Developer/.test(document.getElementById('data-body').innerText) && /Storage is/.test(document.getElementById('data-body').innerText)`), 'game data: storage report');
  await viewport(390, 844, true);
  await b.eval(`location.hash = 'play'`); await sleep(500);
  await shot('phone-play.png');
  check(await b.eval(`document.documentElement.scrollWidth <= innerWidth + 1`), 'phone width: no sideways scroll (play)');
  await b.eval(`location.hash = 'settings'`); await sleep(500);
  await shot('phone-settings.png');
  check(await b.eval(`document.getElementById('home').scrollWidth <= innerWidth + 1`), 'phone width: no sideways scroll (settings)');
  await viewport(1280, 860);

  // 2. settings through the forms, then the text box
  await b.eval(`location.hash = 'settings'`); await sleep(400);
  await b.eval(`(() => { const s = document.getElementById('set-res_scale'); s.value = '2'; s.dispatchEvent(new Event('change')); })()`);
  await click('#set-skip_movies');
  await b.eval(`(() => { const r = document.getElementById('set-volume'); r.value = '40'; r.dispatchEvent(new Event('change')); })()`);
  await click('#set-fps_counter');
  let env = await b.eval(`document.querySelector('[data-env]').dataset.env`);
  check(env.includes('RECOMP_RES_SCALE=2') && env.includes('RECOMP_SKIP_MOVIES=1'), `forms -> env: ${env}`);
  // The text box: MSAA 4 and a bad line.
  await b.eval(`document.querySelector('.set-textbox').open = true`);
  await b.eval(`(() => { const t = document.querySelector('.set-text'); t.value = t.value.replace(/^msaa = .*$/m, 'msaa = 4') + '\\nnot_a_setting = 3\\n'; })()`);
  await b.eval(`[...document.querySelectorAll('.set-textbox button')].find((x) => x.textContent === 'Apply text').click()`);
  await sleep(300);
  check(await b.eval(`document.querySelector('.set-notes').innerText.includes('not_a_setting')`), 'text box: bad line refused with a note');
  await shot('home-settings-changed.png');
  // Rebind A to Space through "Set" + a real key press.
  await b.eval(`[...document.querySelectorAll('table.ctl tbody tr')][0].querySelector('button').click()`);
  await sleep(100);
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  await sleep(200);
  check(await b.eval(`JSON.parse(localStorage.getItem('atv2.settings.v1')).values.key_a === 'Space'`), 'rebind: A = Space stored');
  // Gamepad: a fake standard pad (as boot.mjs --pad); Set on "B", then its button 3 goes down.
  await b.eval(`(() => {
    const p = { id: 'site.mjs fake pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
    window.__padSet = (k, v) => { p.buttons[k] = { pressed: !!v, touched: !!v, value: v ? 1 : 0 }; };
    Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [p, null, null, null] });
    [...document.querySelectorAll('table.ctl')][1].querySelectorAll('tbody tr')[1].querySelector('button').click(); })()`);
  await sleep(200);
  await b.eval(`__padSet(3, 1)`); await sleep(300); await b.eval(`__padSet(3, 0)`);
  check(await b.eval(`JSON.parse(localStorage.getItem('atv2.settings.v1')).values.pad_b === '3'`), 'gamepad rebind: B = button 3 stored');
  await b.eval(`(() => { const v = JSON.parse(localStorage.getItem('atv2.settings.v1')); delete v.values.pad_b; localStorage.setItem('atv2.settings.v1', JSON.stringify(v)); })()`);
  await b.send('Page.reload', {});
  await sleep(1500);
  await until(`document.body.classList.contains('mode-home')`);
  const stored = await b.eval(`JSON.parse(localStorage.getItem('atv2.settings.v1')).values`);
  check(stored.res_scale === '2' && stored.msaa === '4' && stored.skip_movies === true && stored.volume === 40 && stored.fps_counter === true,
    `settings persist across a reload: ${JSON.stringify(stored)}`);
  check(await b.eval(`document.getElementById('set-msaa')?.value === '4' && document.getElementById('set-res_scale').value === '2'`), 'forms show the stored values after the reload');
  check(await b.eval(`document.getElementById('play-summary').textContent.includes('2x resolution')`), 'Play tab summary: ' +
    await b.eval(`document.getElementById('play-summary').textContent`));

  if (!argv.includes('--skip-game')) {
    // 3. Play with a real click
    await b.eval(`location.hash = 'play'`); await sleep(300);
    await click('#btn-play');
    check(await until(`document.body.classList.contains('mode-game') && location.search.includes('play=1')`, 5), 'Play: game mode, ?play=1 in the address');
    check(await until(`!document.getElementById('loading').hidden`, 5), 'loading card shown');
    await sleep(150);
    await shot('game-loading.png');
    check(await until(`(window.atv?.log ?? []).some((l) => l.startsWith('[page] env:'))`, 60), 'game booting');
    const envLine = await b.eval(`atv.log.find((l) => l.startsWith('[page] env:'))`);
    check(/RECOMP_RES_SCALE=2/.test(envLine) && /RECOMP_MSAA=4/.test(envLine) && /RECOMP_SKIP_MOVIES=1/.test(envLine), `settings reach the game env: ${envLine.slice(0, 400)}`);
    check(await until(`document.getElementById('loading').hidden`, 90), 'loading card gone at the first frame');
    check(await until(`document.getElementById('status').textContent.includes('draws 18,')`, 120), 'title screen');
    await sleep(1500);
    check(await b.eval(`!document.getElementById('fps').hidden && /fps/.test(document.getElementById('fps').textContent)`), 'fps counter: ' +
      await b.eval(`document.getElementById('fps').textContent`));
    await shot('game-title.png');

    // 4. the menu
    await key('F1');
    check(await until(`document.getElementById('menu').open && atvSite.menuOpen`, 3), 'F1 opens the menu');
    await key('KeyZ', 'down');
    await sleep(100);
    check(await b.eval(`atv.input ? atv.input.keys[0x5a] === 0 && atv.input.keys[0x20] === 0 : true`), 'no key reaches the game while the menu is open');
    await key('KeyZ', 'up');
    await shot('game-menu.png');
    await click('#mn-fps');
    check(await b.eval(`document.getElementById('fps').hidden`), 'menu: FPS counter off');
    await click('#mn-fps');
    check(await b.eval(`!document.getElementById('fps').hidden`), 'menu: FPS counter on');
    await click('#mn-full');
    const fs = await until(`!!document.fullscreenElement`, 3);
    check(fs, 'menu: fullscreen on');
    if (fs) { await click('#mn-full'); check(await until(`!document.fullscreenElement`, 3), 'menu: fullscreen off'); }
    await click('#mn-shot');
    await until(`/Saved atv2-.*png/.test(document.getElementById('mn-note').textContent)`, 5);
    await sleep(800);
    const png = downloads().find((d) => d.f.endsWith('.png'));
    check(png && png.size > 10000, `screenshot saved: ${png ? `${png.f}, ${png.size} bytes` : 'none'}`);
    await click('#mn-log');
    await sleep(800);
    const txt = downloads().find((d) => d.f.startsWith('atv2-log-') && d.f.endsWith('.txt'));
    check(txt && txt.size > 2000, `log saved: ${txt ? `${txt.f}, ${txt.size} bytes` : 'none'}`);
    await click('#mn-settings');
    await sleep(500);
    check(await b.eval(`!document.getElementById('mn-settings-pane').hidden && !!document.querySelector('#mn-settings-body #set-volume')`), 'menu: settings open');
    await shot('game-menu-settings.png');
    await key('Escape');
    check(await until(`!document.getElementById('menu').open && !atvSite.menuOpen`, 3), 'Esc closes the menu');
    await click('#menu-btn');
    check(await until(`document.getElementById('menu').open`, 3), 'the corner button opens the menu');
    await key('F1');
    check(await until(`!document.getElementById('menu').open`, 3), 'F1 closes it');
    // The game gets keys again: Z (= A) reaches the key table.
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
    await sleep(50);
    check(await b.eval(`atv.input.keys[0x5a] === 1`), 'after closing: Space (rebound to A) presses VK Z in the game ' +
      await b.eval(`import('/host/site/keymap.js').then((m) => JSON.stringify({ space: m.keyVks('Space'), menuOpen: atvSite.menuOpen, down: [...atv.input.down] }))`));
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
    await sleep(50);
    check(await b.eval(`atv.input.keys[0x5a] === 0`), 'and lets go');
    check(await b.eval(`atv.state.error === undefined && atv.state.trap === null`), 'no boot error or trap');

    // Quit (two clicks) goes back to the start page.
    await key('F1'); await sleep(200);
    await click('#mn-quit'); await sleep(100); await click('#mn-quit');
    check(await until(`document.body.classList.contains('mode-home') && !location.search`, 10), 'Quit: back on the start page');
  }
  // Free Ride: the env gets RECOMP_FREERIDE=1 (the address is what the button pushes).
  await b.eval(`localStorage.removeItem('atv2.settings.v1')`);
  await b.send('Page.navigate', { url: `${base}/host/index.html?play=freeride` });
  check(await until(`(window.atv?.log ?? []).some((l) => l.startsWith('[page] env:') && l.includes('RECOMP_FREERIDE=1'))`, 30), 'Free Ride: RECOMP_FREERIDE=1 in the env');
  check(await b.eval(`document.getElementById('loading-title').textContent === 'Free Ride'`), 'Free Ride: loading card title');
  // A start that fails: the card says so and offers Retry / Reload / Download log.
  await b.send('Page.navigate', { url: `${base}/host/index.html?play=1&wasm=no-such-module.wasm` });
  check(await until(`document.getElementById('loading').classList.contains('failed')`, 30), 'failed start: ' +
    await b.eval(`document.getElementById('loading-msg')?.textContent`).catch(() => ''));
  check(await b.eval(`['ld-retry', 'ld-reload', 'ld-log'].every((id) => !document.getElementById(id).hidden)`), 'Retry / Reload / Download log offered');
  await shot('game-failed.png');
  const logsBefore = readdirSync(dl).filter((f) => f.startsWith('atv2-log-')).length;
  await click('#ld-log'); await sleep(800);
  check(readdirSync(dl).filter((f) => f.startsWith('atv2-log-')).length === logsBefore + 1, 'log from the loading card saved');
  await click('#ld-reload');
  check(await until(`document.body.classList.contains('mode-home')`, 10), 'Reload: the start page');
} catch (e) {
  console.log(`${el()} FAILED: ${e.stack ?? e.message}`);
  fails++;
} finally {
  // 5. leave the settings as found
  await b.eval(`localStorage.removeItem('atv2.settings.v1')`).catch(() => {});
  await b.close();
  srv.kill();
}
console.log(`${fails ? `${fails} FAILED` : 'all passed'} (${((Date.now() - t0) / 1000).toFixed(0)} s); downloads in ${dl}`);
process.exit(fails ? 1 : 0);
