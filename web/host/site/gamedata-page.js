// The start page's "Game data" tab (gamedata.js does the work).
import { importedGame, forgetGame, storageReport, requestPersist, checkGame, GAME_DIR, CACHE_DIR, MB } from './gamedata.js';
import { h } from './settings-ui.js';
import { siteLog } from './logs.js';
import { SITE } from '../deploy.js';
import { storedBuild, BUILD_DIR } from '../gamebuild.js';

const NAMES = { delivery: 'Your game import and build (and the test title, on the site)', [GAME_DIR]: 'Game files (an earlier version of this page)', [CACHE_DIR]: 'Developer server cache', [BUILD_DIR]: 'Your game build (atv2.wasm)',
  'atv2-saves': 'Saves', 'atv2-saves-backups': 'Save backups', 'atv2-saves-incoming': 'Save import in progress' };

export async function renderData(root, { onChange = () => {} } = {}) {
  root.textContent = '';
  const msg = h('div', { class: 'set-msg', role: 'status' });
  const say = (t, cls = '') => { msg.textContent = t; msg.className = `set-msg ${cls}`; };
  const m = await importedGame();
  const rep = await storageReport();

  // The import.
  const game = h('div', { class: 'card wide' }, h('h3', {}, 'Your game files'));
  if (m) {
    const bytes = m.files.reduce((a, f) => a + f.size, 0);
    game.append(h('dl', { class: 'facts' },
      h('dt', {}, 'Game'), h('dd', {}, m.game ?? 'ATV Quad Power Racing 2 (USA)'),
      h('dt', {}, 'Files'), h('dd', {}, `${m.files.length} files, ${MB(bytes)}${m.skipMovies ? ', without the movies' : ''}`),
      h('dt', {}, 'Imported'), h('dd', {}, new Date(m.importedAt).toLocaleString()),
      h('dt', {}, 'default.xbe'), h('dd', {}, h('code', {}, `SHA-256 ${String(m.xbeSha256).slice(0, 16)}…`), ' (the retail USA release)')));
  } else {
    const dev = !SITE && await fetch('/data/manifest.json', { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok).catch(() => false);
    game.append(h('p', {}, dev ? 'The developer server (serve.mjs --game) serves the game files: nothing is imported into this browser.'
      : SITE ? 'No game files in this browser yet. Select your local game files on the Play tab.'
        : 'No game files in this browser yet. Choose your game folder on the Play tab.'));
  }
  if (SITE) {
    const b = await storedBuild();
    game.append(h('dl', { class: 'facts' }, h('dt', {}, 'Game build'), h('dd', {}, !b ? 'none yet' :
      [`atv2.wasm from builder ${b.builder}, ${MB(b.size)}, `, h('code', {}, `SHA-256 ${String(b.sha256).slice(0, 16)}…`),
        b.ok ? ' (matches this page)' : ' (made for another version of this site: rebuild and select the folder again)'])));
  }
  const bar = h('progress', { value: 0, max: 1, hidden: true });
  const check = h('button', { class: 'btn', disabled: !m, onclick: async () => {
    check.disabled = true; bar.hidden = false;
    try {
      const r = await checkGame((p) => { bar.max = p.total; bar.value = p.done; say(`Reading ${p.path}… ${MB(p.done)} / ${MB(p.total)}`); });
      say(r.ok ? `All ${r.files} files are there and complete (${MB(r.bytes)} read and checked by SHA-256 in ${r.secs.toFixed(1)} s).`
        : `Problems: ${r.problems.join('; ')}. Forget the game files and import the folder again.`, r.ok ? 'ok' : 'warn');
      siteLog(`game files check: ${r.ok ? 'ok' : r.problems.join('; ')}`);
    } catch (e) { say(e.message, 'warn'); }
    check.disabled = false; bar.hidden = true;
  } }, 'Check and preload');
  let armed = 0;
  const forget = h('button', { class: 'btn danger', disabled: !m && !rep.dirs.delivery && !rep.dirs[GAME_DIR] && !rep.dirs[CACHE_DIR], onclick: async () => {
    if (Date.now() - armed > 4000) { armed = Date.now(); forget.textContent = 'Click again to delete the game files from this browser'; return; }
    forget.disabled = true;
    try {
      await forgetGame((t) => siteLog(t));
      say('The game files are gone from this browser. Your saves stay.', 'ok');
      await renderData(root, { onChange }); root.querySelector('.set-msg').replaceWith(msg);
      onChange();
    } catch (e) { say(e.message, 'warn'); forget.disabled = false; }
  } }, 'Forget game files');
  game.append(h('p', { class: 'small' }, 'Check and preload reads every file once: it finds missing or damaged files and warms the disk cache for a quicker start.'),
    h('div', { class: 'row' }, check, forget), bar);
  root.append(game);

  // Storage.
  const est = rep.estimate;
  const used = Object.values(rep.dirs).reduce((a, d) => a + (d?.bytes ?? 0), 0);
  const rows = Object.entries(rep.dirs).sort((a, b) => (b[1]?.bytes ?? 0) - (a[1]?.bytes ?? 0))
    .map(([n, d]) => h('tr', {}, h('td', {}, NAMES[n] ?? n), h('td', {}, h('code', {}, n)), h('td', { class: 'num' }, MB(d?.bytes ?? 0)), h('td', { class: 'num' }, String(d?.files ?? 0))));
  const persist = h('button', { class: 'btn ghost', hidden: rep.persisted !== false, onclick: async () => {
    const ok = await requestPersist();
    say(ok ? 'The browser will keep this site\'s storage.' : 'The browser said no (it decides by how much the site is used; bookmarking or installing it helps).', ok ? 'ok' : 'warn');
    if (ok) { persist.hidden = true; pst.textContent = 'kept (persistent)'; }
  } }, 'Ask the browser to keep it');
  const pst = h('strong', {}, rep.persisted === true ? 'kept (persistent)' : rep.persisted === false ? 'best effort: the browser may clear it when the disk is full' : 'unknown');
  root.append(h('div', { class: 'card wide' }, h('h3', {}, 'Storage'),
    h('dl', { class: 'facts' },
      h('dt', {}, 'This site uses'), h('dd', {}, `${MB(used)}${est?.usage ? ` (the browser counts ${MB(est.usage)})` : ''}`),
      h('dt', {}, 'Available'), h('dd', {}, est?.quota ? `${MB(Math.max(0, est.quota - (est.usage ?? 0)))} of a ${MB(est.quota)} quota` : 'unknown'),
      h('dt', {}, 'Storage is'), h('dd', {}, pst, ' ', persist)),
    rows.length ? h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'What'), h('th', {}, 'Folder'), h('th', { class: 'num' }, 'Size'), h('th', { class: 'num' }, 'Files'))), h('tbody', {}, rows))
      : h('p', { class: 'small muted' }, 'Nothing stored yet.'),
    h('p', { class: 'small' }, 'All of it is this browser\'s private storage for this page (OPFS) on this computer. Nothing is uploaded.')));
  root.append(msg);
}
