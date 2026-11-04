// Shared by every page: the theme switch, a tiny DOM helper, downloads, and the
// Play panel (select the local game files, then play in this site's game page).
import { LOCAL_PAGE } from './config-model.js';

export const $ = (id) => document.getElementById(id);

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k in e && !['list', 'form', 'for'].includes(k) && !k.includes('-')) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}

// ---- theme: auto (the system's) -> light -> dark ---------------------------------
const THEME_KEY = 'atv2.site.theme';
const THEMES = ['auto', 'light', 'dark'];
const getTheme = () => { try { return localStorage.getItem(THEME_KEY) ?? 'auto'; } catch { return 'auto'; } };
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const b = $('theme-btn');
  if (b) {
    b.textContent = `Theme: ${t}`;
    b.setAttribute('aria-label', `Colour theme: ${t}. Activate to change.`);
  }
}
export function initChrome() {
  applyTheme(getTheme());
  $('theme-btn')?.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private window: this page only */ }
    applyTheme(next);
  });
  const y = $('year');
  if (y) y.textContent = String(new Date().getFullYear());
}

export function download(name, data, type = 'application/json') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---- the Play panel -----------------------------------------------------------------
//
// The game runs in this site's own game page (play/host/, a copy of the local
// build's page made by tools/sync-play.mjs), from files on the player's own
// computer: the play folder their builder made (the game files plus the
// atv2.wasm built from them). This site never serves any of it. The panel:
//   - looks in this browser's storage (OPFS) for an earlier import;
//   - "Select local game files": the folder picker (showDirectoryPicker, or an
//     <input webkitdirectory>), then the game page's own checks and import
//     (play/host/loader.js importFolder: default.xbe, atv2.wasm, the copy);
//   - Play opens the game page; Forget game files deletes the copy (saves stay).
// The game page's modules are loaded only here (dynamic import), so the other
// pages never load them.

const PLAY_PAGE = 'play/host/';
const MBs = (n) => `${(n / 1048576).toFixed(0)} MB`;

export function playBoxMarkup() {
  return `<h2>Play</h2>
    <p class="small">Runs in this page from the play folder the builder made from your disc. Nothing is downloaded or uploaded.</p>
    <div class="play-state" role="status" aria-live="polite" data-state="checking">Looking in this browser's storage…</div>
    <div class="play-action"></div>
    <progress class="play-bar" value="0" max="1" hidden aria-label="Copying the game files"></progress>
    <div class="play-stats small muted"></div>
    <div class="play-msg small" id="play-msg" role="alert"></div>
    <div class="play-steps">
      <ol class="steps small">
        <li>Copy your USA disc's files to a folder.</li>
        <li>Run the builder on it once. It makes a play folder, <code>atv2-play</code>: your game files and <code>atv2.wasm</code>.</li>
        <li>Select local game files and choose that folder. It is copied into this browser once.</li>
      </ol>
      <p class="small"><a href="setup.html#builder">Full setup guide</a></p>
    </div>
    <p class="small muted play-pc">Running the PC launcher instead? <a class="play-local" href="${LOCAL_PAGE}" target="_blank" rel="noopener">Open http://127.0.0.1:8460</a></p>`;
}

/** Fill a .playbox element (playBoxMarkup). opts.launchUrl: the PC launcher link (default: its start page). */
export function initPlayBox(box, opts = {}) {
  const q = (s) => box.querySelector(s);
  const state = q('.play-state'), action = q('.play-action'), steps = q('.play-steps'), msg = q('.play-msg');
  const bar = q('.play-bar'), stats = q('.play-stats');
  const local = q('.play-local');
  if (opts.launchUrl) local.href = opts.launchUrl();
  const set = (s, text) => { state.dataset.state = s; state.textContent = text; };
  const say = (text, kind = '', link = null) => {
    msg.textContent = text; msg.dataset.kind = kind; msg.className = `play-msg small${kind ? ' err' : ''}`;
    // The game page's links are relative to play/host/; this page is at the site's top.
    if (link) msg.append(' ', h('a', { href: link.href.replace(/^(\.\.\/)+/, '') }, link.text));
  };
  let mod = null;
  const load = async () => (mod ??= {
    loader: await import(`../${PLAY_PAGE}loader.js`),
    build: await import(`../${PLAY_PAGE}gamebuild.js`),
  });

  // What this browser lacks for the game (the game page checks it all again, in detail).
  const lacks = () => {
    const l = [];
    if (!window.isSecureContext) l.push('secure (https) page');
    if (!window.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') l.push('cross-origin isolation (SharedArrayBuffer)');
    if (!navigator.gpu) l.push('WebGPU');
    if (!navigator.storage?.getDirectory) l.push("file storage for sites (OPFS)");
    return l;
  };

  async function refresh() {
    action.textContent = ''; bar.hidden = true; stats.textContent = '';
    const missing = lacks();
    if (!navigator.storage?.getDirectory) {
      set('unsupported', `This browser can't run the game here: it has no ${missing.join(', no ')}. Use a current Edge or Chrome on a desktop computer.`);
      steps.hidden = false; return;
    }
    let ready = null, imported = null, kept = null;
    try {
      const { loader, build } = await load();
      [ready, imported, kept] = await Promise.all([loader.readyGame(), loader.importedGame(), build.storedBuild()]);
    } catch (e) { say(`The game page's code could not be loaded (${e.message}).`, 'error'); }
    if (ready) {
      const bytes = ready.files.reduce((a, f) => a + f.size, 0);
      set('ready', `Your game is ready in this browser: ${ready.files.length} files, ${MBs(bytes)}${ready.skipMovies ? ' (without the movies)' : ''}, ` +
        `game build from builder ${ready.build.builder}.`);
      // Online free roam: Free Ride with the hub's address and the player's name in the game page's address.
      const roam = opts.roam?.();
      const roamHref = roam?.server ? `${PLAY_PAGE}?play=freeride&roam=${encodeURIComponent(roam.server)}` +
        (roam.name ? `&roam_name=${encodeURIComponent(roam.name)}` : '') : null;
      action.append(h('a', { class: 'play-btn', href: `${PLAY_PAGE}?play=1`, id: 'play-start' }, 'Play'),
        h('div', { class: 'row' },
          roamHref ? h('a', { class: 'btn ghost', href: roamHref, id: 'play-roam' }, 'Free roam online') : null,
          h('a', { class: 'btn ghost', href: PLAY_PAGE, id: 'play-page' }, 'Free Ride, settings, saves'),
          forgetButton()));
      steps.hidden = true;
    } else {
      const stale = imported && kept && !kept.ok;
      set(stale ? 'stale' : 'need', stale ? mod.build.STALE_TEXT()
        : imported ? 'Your game files are in this browser, but not your game build (atv2.wasm). Select your local game files again.'
          : 'Select the folder your builder made from your disc.');
      selectUI(!!(imported || kept));
      steps.hidden = false;
    }
    if (missing.length) say(`This browser has no ${missing.join(', no ')}: the game will not start here. Use a current Edge or Chrome on a desktop computer.`, 'browser');
  }

  function forgetButton() {
    let armed = 0;
    const b = h('button', { class: 'btn ghost', type: 'button', id: 'play-forget', onclick: async () => {
      if (Date.now() - armed > 4000) { armed = Date.now(); b.textContent = 'Click again to delete them from this browser'; return; }
      b.disabled = true;
      try {
        const { loader } = await load();
        await loader.forgetGame();
        say('The game files and your game build are gone from this browser. Your saves stay.');
      } catch (e) { say(`Could not delete them: ${e.message}. Close the game page if it is open, and try again.`, 'error'); }
      refresh();
    } }, 'Forget game files');
    return b;
  }

  function selectUI(hasData) {
    const input = h('input', { type: 'file', id: 'play-dir', webkitdirectory: true, multiple: true, hidden: true, 'aria-label': 'Your play folder' });
    const skip = h('input', { type: 'checkbox', id: 'play-skipmovies' });
    const pick = h('button', { class: 'play-btn', type: 'button', id: 'play-select' }, 'Select local game files');
    let busy = false;
    const run = async (scan) => {
      if (busy || !scan) return;
      busy = true; pick.disabled = true; skip.disabled = true;
      say('');
      try {
        const { loader } = await load();
        const r = await loader.importFolder(scan, { skipMovies: skip.checked,
          onPhase: (phase, text) => { set(phase, text); if (phase === 'importing') bar.hidden = false; },
          onProgress: (p) => { bar.max = p.total; bar.value = p.done;
            stats.textContent = `${p.file} / ${p.files} files · ${MBs(p.done)} / ${MBs(p.total)} · ${p.mbps.toFixed(0)} MB/s`; } });
        await refresh();
        say(`Imported ${r.files} files (${MBs(r.bytes)}; ${MBs(r.copied)} copied) in ${r.secs.toFixed(1)} s, and your game build from builder ${r.build?.builder}.`);
      } catch (e) {
        const kind = e.kind ?? 'game';               // 'missing' | 'mismatch' (gamebuild.js) | 'game' (default.xbe and the files)
        set('error', kind === 'missing' ? 'No game build in that folder.' : kind === 'mismatch' ? "That game build doesn't match this site." : 'That folder was refused.');
        say(e.message, kind, e.link ?? null);
        bar.hidden = true; stats.textContent = '';
      } finally { busy = false; pick.disabled = false; skip.disabled = false; }
    };
    pick.addEventListener('click', async () => run(await (await load()).loader.pickFolder(input)));
    input.addEventListener('change', async () => run((await load()).loader.inputScan(input)));
    action.append(pick, input,
      h('label', { class: 'small', for: 'play-skipmovies' }, skip, ' Skip the movies (about 380 MB less in the browser)'),
      ...(hasData ? [h('div', { class: 'row' }, forgetButton())] : []));
  }

  refresh();
  return { refresh };
}

/** The free roam server's status line: "Free roam server: online, N riders" or offline (grey); every 30 s.
 * server: the wss:// address from the settings; its https://<host>/status.json has counts only. */
export function initHubStatus(el, server) {
  let url = null;
  try { const u = new URL(server); if (u.protocol === 'wss:') url = `https://${u.host}/status.json`; } catch { /* no server set */ }
  if (!url) { el.hidden = true; return; }
  const show = (online, text) => { el.textContent = `Free roam server: ${text}`; el.classList.toggle('muted', !online); el.dataset.state = online ? 'online' : 'offline'; };
  const check = async () => {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      const s = await r.json();
      if (!r.ok || s.online !== true || !Number.isInteger(s.players)) throw new Error('bad status');
      show(true, `online, ${s.players} ${s.players === 1 ? 'rider' : 'riders'}`);
    } catch { show(false, 'offline'); } finally { clearTimeout(t); }
  };
  check();
  setInterval(check, 30000);
}
