// The page shell: the start page (Play, Free Ride, Settings, Saves, Game
// data, About) and the game on the same page.
//
// index.html loads this module instead of main.js. With no boot parameter
// in the address it shows the start page and loads nothing of the game.
// Play / Free Ride switch the page to the game in place (the click is the
// user gesture that allows fullscreen and sound), put ?play=1 (or
// ?play=freeride, ?play=freeride-pick) in the address so Retry and a reload start the same way,
// and import main.js, which boots as before. Any of main.js's own parameters
// (?env=, ?wasm=, ?dev=, ?forget= ...: what web/tools/*.mjs and the
// launchers use) also boots straight away, so the tools are unchanged.
//
// The settings reach the game through window.atvSite.env, which main.js
// merges between its DEFAULT_ENV and ?env= (an explicit ?env= wins).
// ?settings=off boots with the default settings.
import { loadSettings, settingsEnv, settingsQuery, CHANGED_EVENT } from './settings.js';
import { installLogCapture, downloadLog, siteLog } from './logs.js';
import { SITE } from '../deploy.js';

installLogCapture();
// [siteplay] The project site's copy: its texts (.site-only) instead of the local server's (.local-only).
if (SITE) document.documentElement.classList.add('deploy-site');
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const BOOT_PARAMS = ['play', 'env', 'wasm', 'args', 'trace', 'threads', 'dev', 'forget', 'saves'];

const site = window.atvSite = {
  mode: 'home', env: {}, menuOpen: false, kind: null,
  volume: () => loadSettings().volume / 100,
  downloadLog,
};

function setMode(mode) {
  site.mode = mode;
  document.body.classList.remove('mode-home', 'mode-game', 'boot');
  document.body.classList.add(`mode-${mode}`);
}

function applyPageSettings() {
  const s = loadSettings();
  document.body.classList.toggle('nolog', !s.show_status);
  document.body.classList.toggle('nobar', !s.show_status);
  window.atv?.audio?.setVolume?.(s.volume / 100);
}
addEventListener(CHANGED_EVENT, applyPageSettings);

// ---- the game --------------------------------------------------------------------

export async function enterFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    // Esc then reaches the page (the in-game menu) instead of leaving fullscreen; holding Esc still leaves.
    await navigator.keyboard?.lock?.(['Escape']).catch(() => {});
    return true;
  } catch (e) { siteLog(`fullscreen: ${e.message}`); return false; }
}

/** Start the game in this page. kind: 'play' | 'freeride' | 'freeride-pick'. Call from a click for fullscreen. */
async function startGame(kind, { fromClick = false } = {}) {
  if (site.kind) return;
  site.kind = kind;
  const settings = loadSettings();
  if (fromClick && settings.fullscreen) enterFullscreen();       // must run inside the click
  const useSettings = q.get('settings') !== 'off';
  const env = useSettings ? settingsEnv(settings) : {};
  // Free Ride (src/freeride.c): 1 = Freestyle, Unlimited Time, Stadium: Main Event; pick = the player picks rider and ATV.
  // Either one also skips the movies.
  if (kind === 'freeride') env.RECOMP_FREERIDE = '1';
  if (kind === 'freeride-pick') env.RECOMP_FREERIDE = 'pick';
  site.env = env;
  // The display options are page parameters main.js reads from the address when it loads. A ?play= start
  // (Play, Free Ride, Retry) takes them from the settings; a start by the tools' parameters keeps its own.
  if (fromClick || q.has('play')) {
    const u = new URL(location.href);
    if (fromClick) { u.search = ''; u.searchParams.set('play', kind === 'play' ? '1' : kind); }
    for (const [k, v] of Object.entries(useSettings ? settingsQuery(settings) : {})) {
      if (v === null) u.searchParams.delete(k); else u.searchParams.set(k, v);
    }
    if (fromClick) history.pushState(null, '', u); else history.replaceState(null, '', u);
  }
  setMode('game');
  applyPageSettings();
  // The import panel belongs to the game page again (loader.js shows it if needed).
  const imp = $('importer');
  imp.classList.remove('inline');
  document.body.appendChild(imp);
  siteLog(`starting the game (${kind}); env from settings: ${Object.entries(env).map(([k, v]) => (v === null ? `-${k}` : `${k}=${v}`)).join(' ') || '(none)'}`);
  const loading = await import('./loading.js');
  loading.watch({ kind });
  await import('../main.js');
  const overlay = await import('./overlay.js');
  overlay.install();
  try { await window.ready; } catch { /* shown by loading.js */ }
  // The click was a user gesture: sound may start without another one.
  if (navigator.userActivation?.hasBeenActive) window.atv?.startAudio?.().catch?.(() => {});
}
site.startGame = startGame;

// ---- the start page ----------------------------------------------------------------

async function showHome() {
  setMode('home');
  const home = await import('./home.js');
  await home.init({ startGame, enterFullscreen });
}

const kindFromQuery = () => (['freeride', 'freeride-pick'].includes(q.get('play')) ? q.get('play') : 'play');
if (BOOT_PARAMS.some((k) => q.has(k))) startGame(kindFromQuery());
else showHome();
// Back from the game to the start page (history): the game cannot be stopped in place, so reload.
addEventListener('popstate', () => { if (site.mode === 'game') location.reload(); });
