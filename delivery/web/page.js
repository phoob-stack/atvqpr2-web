// page.js - the launcher page: Play button, progress, errors; mode 1 (the
// server's manifest) or mode 2 (files from a folder). Everything the tests
// read is on window.delivery.
//
// Query: ?autoplay=1 (press Play), ?source=local (mode 2 from what an earlier
// pick stored), ?background=0 (don't prefetch the rest after start), ?name=X
// (hub player name), ?hub=0 (no hub).
import { Launcher, registerShell } from './client/launcher.js';
import * as title from './app/title.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const MB = (n) => (n / 1048576).toFixed(2);
const delivery = (window.delivery = { phase: 'idle', events: [], errors: [], timing: {} });
let resolveReady;
window.ready = new Promise((r) => { resolveReady = r; });

const t0 = performance.now();
const sw = registerShell('./sw.js');
const config = await fetch('./config.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null)
  ?? { ns: 'boxquad', manifest: './assets/manifest.json', hub: null, background: true };
delivery.config = config;

const launcher = new Launcher({ ns: config.ns });
delivery.launcher = launcher;
launcher.addEventListener('state', ({ detail: d }) => {
  delivery.phase = d.phase;
  delivery.events.push({ t: Math.round(performance.now() - t0), phase: d.phase, message: d.message });
  $('status').textContent = d.message;
  if (d.phase === 'error') showError(d.error);
});
launcher.addEventListener('progress', ({ detail: d }) => {
  $('bar').hidden = false;
  $('fill').style.width = `${d.percent.toFixed(1)}%`;
  $('status').textContent = `Loading ${MB(d.loaded)} of ${MB(d.total)} MB (${d.percent.toFixed(0)}%), now ${d.path}`;
});

function showError(e) {
  const hints = {
    offline: 'Connect once; after the first visit the game also starts offline.',
    hash: 'The download was retried and still failed its check. Try again later.',
    network: 'Try again: the part already downloaded is kept.',
    opfs: 'Allow site data for this page (not a private window) and free some disk space.',
    'pick-needed': 'Choose the folder again.',
  };
  $('error').hidden = false;
  $('error').textContent = `${e.message}${hints[e.code] ? `\n${hints[e.code]}` : ''}`;
  delivery.errors.push({ code: e.code, message: e.message });
}

function hubUrl() {
  if (qs.get('hub') === '0' || !config.hub) return null;
  const u = new URL(config.hub, location.href);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  return u.href;
}

async function go() {
  $('play').disabled = true;
  $('error').hidden = true;
  const tStart = performance.now();
  try {
    const run = await launcher.prepare({ start: async (assets) => (await assets.json('config/title.json')).start });
    delivery.timing.prepareMs = Math.round(performance.now() - tStart);
    $('panel').hidden = false;
    $('game').hidden = false;
    delivery.app = await launcher.play(title, { canvas: $('view'), hud: $('hud'), hubUrl: hubUrl(), name: qs.get('name') ?? `P${Math.floor(Math.random() * 900 + 100)}` });
    delivery.timing.playMs = Math.round(performance.now() - tStart);
    $('status').textContent = run.offline ? 'Running offline from stored files' : 'Running';
    $('bar').hidden = true;
    if (config.background && qs.get('background') !== '0') {
      setTimeout(() => launcher.prefetchRest().then((r) => { delivery.background = r; footer(); }).catch((e) => delivery.errors.push({ code: e.code, message: e.message })), 1500);
    }
    footer();
  } catch (e) {
    $('play').disabled = false;
    if (!delivery.errors.length) showError(e);
  }
}

async function footer() {
  const s = await launcher.status();
  if (s) $('foot').textContent = `Content ${s.version} (${s.source === 'http' ? 'server' : 'your folder'}): ${s.stored} files stored (${MB(s.storedBytes)} MB)` +
    `${s.missing ? `, ${s.missing} fetched on first use (${MB(s.missingBytes)} MB)` : ', all stored: works offline'}.`;
}

// Mode 2 can work on stored files with ?source=local; otherwise the request picks.
if (qs.get('source') === 'local') launcher.useLocalFiles(null, { title: 'boxquad', entry: 'title.wasm' });
else launcher.useServer(config.manifest);

$('play').addEventListener('click', go);
$('pick').addEventListener('change', (ev) => {
  const files = ev.target.files;
  if (!files?.length) return;
  launcher.useLocalFiles(files, { title: 'boxquad', entry: 'title.wasm' });
  delivery.source = 'local';
  go();
});
$('forget').addEventListener('click', async () => { await launcher.forget(); $('status').textContent = 'Stored files deleted.'; footer(); });

$('play').disabled = false;
$('status').textContent = 'Ready to play.';
delivery.sw = await sw.then((r) => !!r);
resolveReady(true);
delivery.go = go;
if (qs.get('autoplay') === '1') go();
