// The in-game menu: F1 (or Esc, or the small corner button, or the guide
// button of a pad that has one) opens it over the game.
//
// The game uses neither F1 nor Esc (keyboard.c's map: Enter = START,
// Backspace = BACK, Z/X/C/V = A/B/X/Y...), so they are free for the page. If
// the player binds Esc to a control (Settings > Controls) only F1 and the
// button open the menu. While the menu is open no key reaches the game
// (stopped here, in the capture phase, before input.js) and keymap.js hands
// input.js a released, centred pad; the keys held when it opened are let go.
// The game is not paused: in a race, pause it with START first.
//
// Items: Back to the game, FPS counter, Fullscreen, Screenshot (the WebGPU
// canvas's last frame as a PNG download), Settings (the same forms as the
// start page; volume and the counter apply at once, the rest at the next
// start), Download log, Quit to the start page.
import { loadSettings, setSetting, CHANGED_EVENT } from './settings.js';
import { downloadLog, downloadBlob, stamp, siteLog } from './logs.js';
import { enterFullscreen } from './shell.js';

const $ = (id) => document.getElementById(id);
let installed = false;
let flipsAt = -1;

function escFree() {
  const v = loadSettings();
  return !Object.entries(v).some(([k, val]) => k.startsWith('key_') && String(val).split(' ').includes('Escape'));
}

export function isOpen() { return !!window.atvSite?.menuOpen; }

export function open() {
  const d = $('menu');
  if (d.open) return;
  window.atvSite.menuOpen = true;
  // Let go of whatever the game had held (input.js clears its keys on blur).
  dispatchEvent(new Event('blur'));
  syncItems();
  d.showModal();
  $('mn-back').focus();
}

export function close() {
  const d = $('menu');
  if (d.open) d.close();
  window.atvSite.menuOpen = false;      // at once: the close event comes a task later
}

function onClosed() {
  window.atvSite.menuOpen = false;
  $('mn-settings-pane').hidden = true;
  $('screen').focus({ preventScroll: true });
}

function toggle() { if (isOpen()) close(); else open(); }

function syncItems() {
  const s = loadSettings();
  $('mn-fps').setAttribute('aria-pressed', String(s.fps_counter));
  $('mn-fps').querySelector('.state').textContent = s.fps_counter ? 'on' : 'off';
  $('mn-full').querySelector('.state').textContent = document.fullscreenElement ? 'on' : 'off';
  $('mn-full').hidden = !document.fullscreenEnabled;
  $('mn-note').textContent = '';
  armQuit(false);
}

let quitArmed = 0;
function armQuit(on) {
  quitArmed = on ? Date.now() : 0;
  $('mn-quit').querySelector('.label').textContent = on ? 'Click again to quit (unsaved progress is lost)' : 'Quit to the start page';
}

export async function screenshot() {
  const url = await window.atv?.snapshot?.();
  if (!url) { note('No frame to save yet.'); return null; }
  const blob = await (await fetch(url)).blob();
  const name = `atv2-${stamp()}.png`;
  downloadBlob(blob, name);
  siteLog(`screenshot ${name}, ${blob.size} bytes`);
  note(`Saved ${name} to your downloads.`);
  return name;
}

function note(text) { $('mn-note').textContent = text; }

// ---- the fps counter ------------------------------------------------------------

let fpsTimer = 0;
function fpsCounter() {
  const on = loadSettings().fps_counter;
  const el = $('fps');
  el.hidden = !on;
  clearInterval(fpsTimer);
  if (!on) return;
  let last = performance.now(), lastFlips = -1, lastFrames = -1;
  const flipsIndex = () => (flipsAt >= 0 ? flipsAt : -1);
  fpsTimer = setInterval(() => {
    const p = window.atv?.presenter;
    const now = performance.now();
    if (!p?.i32 || flipsIndex() < 0) { el.textContent = '-- fps'; return; }
    const flips = p.i32[flipsIndex()], frames = p.stats.frames + p.stats.cpuFrames;
    if (lastFlips >= 0) {
      const dt = (now - last) / 1000;
      const game = (flips - lastFlips) / dt, shown = (frames - lastFrames) / dt;
      el.textContent = `${game.toFixed(0)} fps`;
      el.title = `game ${game.toFixed(1)} flips/s, page ${shown.toFixed(1)} frames/s`;
      el.dataset.fps = game.toFixed(1);
      el.classList.toggle('low', game < 55);
    }
    last = now; lastFlips = flips; lastFrames = frames;
  }, 500);
}

// ---- wiring -------------------------------------------------------------------------

export async function install() {
  if (installed) return;
  installed = true;
  try { flipsAt = (await import('../abi.js')).Host.at.flips; } catch { flipsAt = -1; }
  const d = $('menu');
  d.addEventListener('close', onClosed);
  // Clicking the backdrop (outside the menu box) closes it.
  d.addEventListener('click', (e) => { if (e.target === d) close(); });

  // Keys: capture phase on window runs before input.js's listeners.
  const onKey = (e) => {
    const isToggle = e.code === 'F1' || (e.code === 'Escape' && escFree());
    if (isToggle) {
      e.preventDefault(); e.stopPropagation();
      if (e.type === 'keydown' && !e.repeat) {
        // Esc inside the open menu: the dialog's own cancel closes it.
        if (isOpen() && e.code === 'Escape') close(); else toggle();
      }
      return;
    }
    if (isOpen()) e.stopPropagation();       // the menu's own keys (Tab, Enter, arrows) work; the game gets none
  };
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKey, true);
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

  // A pad's guide/home button (16), when the browser reports it.
  let guide = false;
  const padPoll = () => {
    const g = [...(navigator.getGamepads?.() ?? [])].find((p) => p?.connected);
    const now = !!g?.buttons[16]?.pressed;
    if (now && !guide) toggle();
    guide = now;
    setTimeout(padPoll, 100);
  };
  padPoll();

  $('menu-btn').onclick = () => open();
  $('mn-back').onclick = () => close();
  $('mn-fps').onclick = () => { setSetting('fps_counter', !loadSettings().fps_counter); syncItems(); };
  $('mn-full').onclick = async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    else await enterFullscreen();
    syncItems();
  };
  $('mn-shot').onclick = async () => {
    // Close first so the menu is not in the way of the next frame (the snapshot is the game's own frame anyway).
    await screenshot();
  };
  $('mn-settings').onclick = async () => {
    const pane = $('mn-settings-pane');
    pane.hidden = !pane.hidden;
    if (!pane.hidden) {
      const ui = await import('./settings-ui.js');
      ui.renderSettings($('mn-settings-body'), { inGame: true });
    }
  };
  $('mn-log').onclick = () => note(`Saved ${downloadLog()} to your downloads.`);
  $('mn-quit').onclick = () => {
    if (!quitArmed || Date.now() - quitArmed > 4000) { armQuit(true); return; }
    try { document.exitFullscreen?.(); } catch { /* */ }
    location.href = location.pathname;
  };
  document.addEventListener('fullscreenchange', () => { if (isOpen()) syncItems(); });
  addEventListener(CHANGED_EVENT, fpsCounter);
  fpsCounter();
  // F2 shows/hides the status bar and log (also a setting).
  addEventListener('keydown', (e) => {
    if (e.code !== 'F2') return;
    e.preventDefault(); e.stopPropagation();          // not index.html's own F2 toggle, not the game
    if (!e.repeat) setSetting('show_status', !loadSettings().show_status);
  }, true);
  window.atvSite.menu = { open, close, toggle, isOpen, screenshot };
}
