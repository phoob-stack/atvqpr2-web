// The test titles' runner page: our own placeholder titles (not ATV 2),
// streamed from the asset server (R2) through the shared delivery client
// (test-title/lib/, copied from the delivery repository by tools/sync-delivery.mjs).
// Which title is data: ?game=<id> (default boxquad) names a game profile,
// test-title/profiles/<id>.json (delivery's profiles/, game-profile/1): its
// bucket prefix (games/<id>/), its entry module, its required files and
// groups, and its page code (app/<app>.js). Nothing here knows a title.
//
// Start: games/<id>/latest.json -> the version's manifest -> check what OPFS holds
// (leftovers cleaned, bad files dropped) -> the required files (progress per
// file and in total, Range resume, SHA-256 as they arrive) -> compile ->
// run. On-demand groups are fetched by the title on first use. A later start
// downloads nothing; offline, this page comes from its service worker (sw.js)
// and the files from OPFS. During a title's move to its prefix, a profile's
// remote.fallbackPrefix "" reads the bucket root's latest.json while
// games/<id>/ has none.
//
// Address: ?autoplay=1 (press Play), ?concurrency=N (parallel downloads, 3),
// ?verify=full (hash every stored file again), and on a local copy of the
// site only, ?assets=<base URL> (config-model.js resolveAssetBase).
// Everything the tests read is on window.delivery.
import { Launcher, registerShell } from './lib/launcher.js';
import { loadProfile, remoteBase } from './lib/profile.js';
import { loadConfig, resolveAssetBase } from '../js/config-model.js';
import { $, initChrome } from '../js/common.js';

initChrome();
const qs = new URLSearchParams(location.search);
const MB = (n) => (n / 1048576).toFixed(2);
const size = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${MB(n)} MB`);
const src = resolveAssetBase(loadConfig().values, location.href);
const GAME = /^[a-z0-9][a-z0-9-]{0,31}$/.test(qs.get('game') ?? '') ? qs.get('game') : 'boxquad';
const profile = await loadProfile(`./profiles/${GAME}.json`);
const title = await import(`./app/${profile.app}.js`);
const NS = profile.id;
const delivery = (window.delivery = { phase: 'idle', events: [], errors: [], timing: {}, base: src.base, baseFrom: src.from, progress: [],
  game: profile.id, titleBase: remoteBase(profile, src.base) });
$('tt-name').textContent = profile.title.replace(/\s*\(.*\)$/, '');
document.title = `Test title: ${$('tt-name').textContent} · ATV 2 Port`;
$('tt-help').textContent = title.help ?? '';
// the other test titles (profiles/index.json, written by tools/sync-delivery.mjs)
fetch('./profiles/index.json').then((r) => r.json()).then((ix) => {
  const others = ix.titles.filter((t) => t.id !== profile.id);
  if (!others.length) return;
  const keep = new URLSearchParams(location.search); keep.delete('game'); keep.delete('autoplay');
  $('tt-others').replaceChildren('Other test titles: ', ...others.flatMap((t, i) => {
    const a = document.createElement('a');
    const q = new URLSearchParams(keep); q.set('game', t.id);
    a.href = `?${q}`; a.textContent = t.title.replace(/\s*\(.*\)$/, '');
    return i ? [', ', a] : [a];
  }));
}).catch(() => {});
let resolveReady;
window.ready = new Promise((r) => { resolveReady = r; });
$('tt-host').textContent = new URL(src.base).host;

const t0 = performance.now();
const sw = registerShell('./sw.js');
const launcher = new Launcher({ ns: NS, concurrency: Math.max(1, Math.min(8, Number(qs.get('concurrency') ?? 3) || 3)) }).useProfile(profile, src.base);
delivery.launcher = launcher;

const set = (state, text) => { $('tt-state').dataset.state = state; $('tt-state').textContent = text; };
const say = (text, err = false) => { $('tt-msg').textContent = text; $('tt-msg').className = `play-msg small${err ? ' err' : ''}`; };

launcher.addEventListener('state', ({ detail: d }) => {
  delivery.phase = d.phase;
  delivery.events.push({ t: Math.round(performance.now() - t0), phase: d.phase, message: d.message });
  if (d.phase !== 'error') set(d.phase, d.message);
});
let lastList = 0;
launcher.addEventListener('progress', ({ detail: d }) => {
  $('tt-bar').hidden = false;
  $('tt-bar').max = Math.max(1, d.total); $('tt-bar').value = d.loaded;
  $('tt-stats').textContent = `${MB(d.loaded)} of ${MB(d.total)} MB (${d.percent.toFixed(0)}%), ${d.done} of ${d.count} files${d.path ? `, now ${d.path}` : ''}`;
  if (delivery.progress.length < 400) delivery.progress.push({ t: Math.round(performance.now() - t0), loaded: d.loaded, total: d.total, done: d.done });
  const now = performance.now();
  if (now - lastList > 100 || d.done === d.count) {
    lastList = now;
    const ul = $('tt-files');
    ul.hidden = false;
    ul.replaceChildren(...Object.entries(d.files).map(([p, f]) => {
      const li = document.createElement('li');
      li.textContent = `${p}: ${f.done ? 'ready' : `${f.percent.toFixed(0)}%`} (${size(f.total)})`;
      return li;
    }));
  }
});

const hints = {
  offline: 'Connect once; after the first start the test title also starts offline.',
  hash: 'The download was retried and still failed its check. Try again later.',
  network: 'Try again: the part already downloaded is kept.',
  opfs: 'Allow site data for this page (not a private window) and free some disk space.',
  manifest: 'The asset server answered something unexpected; try again in a minute.',
};
function showError(e) {
  set('error', 'The test title could not start.');
  say(`${e.message}${hints[e.code] ? ` ${hints[e.code]}` : ''}`, true);
  delivery.errors.push({ code: e.code, message: e.message });
}

async function go() {
  $('tt-play').disabled = true;
  say('');
  const tStart = performance.now();
  try {
    const run = await launcher.prepare({ fullVerify: qs.get('verify') === 'full' });
    delivery.timing = { ...launcher.timing, toReadyMs: Math.round(performance.now() - tStart) };
    delivery.verify = run.verify; delivery.startSet = run.startSet;
    $('tt-game').hidden = false;
    $('tt-play').style.display = 'none';
    delivery.app = await launcher.play(title, { canvas: $('tt-view'), hud: $('tt-hud'), hubUrl: null, name: 'TEST' });
    delivery.timing.playMs = Math.round(performance.now() - tStart);
    set('running', run.offline ? 'Running offline from the files kept in this browser.' : 'Running.');
    $('tt-bar').hidden = true;
    // Files that are neither required nor in an on-demand group: in the background.
    const rest = [...launcher.assets.files.values()].filter((e) => !e.required && !e.group).map((e) => e.path);
    if (rest.length && !run.offline) launcher.assets.prefetch(rest).catch((e) => delivery.errors.push({ code: e.code, message: e.message }));
    launcher.assets.addEventListener('group', ({ detail }) => { delivery.groups = [...(delivery.groups ?? []), detail]; footer(); });
    footer();
  } catch (e) {
    $('tt-play').disabled = false;
    showError(e);
  }
}

async function footer() {
  const s = await launcher.status().catch(() => null);
  if (!s) return;
  delivery.status = s;
  delivery.usedFallback = launcher.assets.backend.usedFallback;
  $('tt-foot').textContent = `Version ${s.version}, from ${new URL(src.base).host}/${launcher.assets.backend.usedFallback ? '' : profile.remote.prefix}: ${s.stored} files kept in this browser (${MB(s.storedBytes)} MB)` +
    `${s.missing ? `; ${s.missing} more when first needed (${MB(s.missingBytes)} MB).` : '; everything is here, it also starts offline.'}`;
}

$('tt-play').addEventListener('click', go);
let armed = 0;
$('tt-forget').addEventListener('click', async () => {
  const b = $('tt-forget');
  if (Date.now() - armed > 4000) { armed = Date.now(); b.textContent = 'Click again to delete them'; return; }
  b.disabled = true;
  try { await launcher.forget(); say('The test title\'s files are gone from this browser.'); $('tt-foot').textContent = ''; }
  catch (e) { say(`Could not delete them: ${e.message}`, true); }
  b.disabled = false; b.textContent = 'Forget the test title\'s files';
});

$('tt-play').disabled = false;
set('idle', src.ignored ? `Ready. (?assets= is only used on a local copy of the site; streaming from ${new URL(src.base).host}.)` : 'Ready to play.');
delivery.sw = await sw.then((r) => !!r);
resolveReady(true);
delivery.go = go;
if (qs.get('autoplay') === '1') go();
