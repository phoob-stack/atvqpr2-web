// The start page: tabs (Play, Settings, Saves, Game data, About) chosen by
// the address's #hash, the game-files check on Play (the import panel the
// first time), and the buttons that start the game.
import { readyGame, importedGame, prepareGame } from '../loader.js';
import { SITE } from '../deploy.js';
import { siteLog, downloadLog } from './logs.js';
import { loadSettings, setSetting, CHANGED_EVENT } from './settings.js';
import { h } from './settings-ui.js';

const $ = (id) => document.getElementById(id);
const TABS = ['play', 'settings', 'saves', 'data', 'about'];
let ctx = null;
const drawn = new Set();

export async function init(c) {
  ctx = c;
  document.title = 'ATV 2 · Quad Power Racing (browser)';
  for (const a of document.querySelectorAll('#nav a')) a.addEventListener('click', () => setTimeout(route));
  addEventListener('hashchange', route);
  route();
  $('btn-play').onclick = () => ctx.startGame('play', { fromClick: true });
  $('btn-freeride').onclick = () => ctx.startGame(loadSettings().freeride_pick ? 'freeride-pick' : 'freeride', { fromClick: true });
  const pick = $('fr-pick');
  pick.checked = loadSettings().freeride_pick;
  pick.onchange = () => setSetting('freeride_pick', pick.checked);
  addEventListener(CHANGED_EVENT, () => { pick.checked = loadSettings().freeride_pick; });
  $('btn-homelog').onclick = () => { $('home-note').textContent = `Saved ${downloadLog()} to your downloads.`; };
  addEventListener(CHANGED_EVENT, summary);
  summary();
  await gameStatus();
}

function route() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'play';
  for (const t of TABS) {
    $(`tab-${t}`).hidden = t !== tab;
    document.querySelector(`#nav a[href="#${t}"]`)?.setAttribute('aria-current', t === tab ? 'page' : 'false');
  }
  if (!drawn.has(tab)) { drawn.add(tab); draw(tab); }
  else if (tab === 'saves' || tab === 'data') draw(tab);     // refresh what is stored
}

async function draw(tab) {
  try {
    if (tab === 'settings') (await import('./settings-ui.js')).renderSettings($('settings-body'));
    if (tab === 'saves') await (await import('./saves-page.js')).renderSaves($('saves-body'));
    if (tab === 'data') await (await import('./gamedata-page.js')).renderData($('data-body'), { onChange: gameStatus });
    if (tab === 'about') await changelog();
  } catch (e) { siteLog(`${tab}: ${e.stack ?? e}`); }
}

/** A one-line summary of the settings next to Play. */
function summary() {
  const s = loadSettings();
  const bits = [];
  if (s.res_scale !== '1') bits.push(s.res_scale === 'window' ? 'window resolution' : `${s.res_scale}x resolution`);
  if (s.widescreen) bits.push('16:9');
  if (s.msaa !== '0') bits.push(`MSAA ${s.msaa}x`);
  if (s.frame_pacing !== 'vsync') bits.push('uncapped');
  if (s.fullscreen) bits.push('fullscreen');
  if (s.skip_movies) bits.push('movies skipped');
  if (s.volume !== 100) bits.push(`volume ${s.volume}`);
  $('play-summary').textContent = bits.length ? bits.join(' · ') : 'Default settings';
}

/** Are the game files here? Shows the import panel in the Play tab until they are. */
async function gameStatus() {
  const st = $('game-state');
  const play = [$('btn-play'), $('btn-freeride')];
  const ready = (text) => { st.textContent = text; st.className = 'game-state ok'; for (const b of play) b.disabled = false; };
  const dev = !SITE && await fetch('/data/manifest.json', { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok).catch(() => false);
  if (dev) { ready('Game files: served by the developer server (serve.mjs --game).'); return; }
  const m = await readyGame();
  if (m) {
    const mb = m.files.reduce((a, f) => a + f.size, 0) / 1048576;
    ready(`Game files ready: ${m.files.length} files, ${mb.toFixed(0)} MB, imported ${new Date(m.importedAt).toLocaleDateString()}` +
      `${m.skipMovies ? ' (without the movies)' : ''}${m.build ? `; game build from builder ${m.build.builder}` : ''}.`);
    $('import-slot').hidden = true;
    return;
  }
  st.textContent = SITE ? (await importedGame() ? 'Your game build needs updating: select your local game files below (the folder your builder made).'
    : 'First time here: select your local game files below (the folder your builder made). They are copied into this browser once.')
    : 'First time here: choose your game folder below. It is copied into this browser once.';
  st.className = 'game-state need';
  for (const b of play) b.disabled = true;
  const imp = $('importer');
  imp.classList.add('inline');
  $('import-slot').append(imp);
  $('import-slot').hidden = false;
  try {
    await prepareGame({ q: new URLSearchParams('dev=0'), log: (t) => siteLog(t) });
  } catch (e) { siteLog(`import: ${e.message}`); return; }
  $('import-slot').hidden = true;
  await gameStatus();
  drawn.delete('data');
}

async function changelog() {
  const box = $('changelog');
  if (box.dataset.done) return;
  const list = await (await fetch(new URL('./changelog.json', import.meta.url))).json();
  box.dataset.done = '1';
  for (const e of list) {
    box.append(h('li', {}, h('time', {}, e.date), h('strong', {}, e.title), h('ul', {}, e.items.map((i) => h('li', {}, i)))));
  }
}
