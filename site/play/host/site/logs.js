// The "Download log" file: what the page and the game printed, for a bug
// report. Collected here, saved by the player as a .txt; nothing is sent
// anywhere (the dev server's /log copy is main.js's, localhost only).
//
// Sources: the page console (console.* is wrapped once, the lines are kept
// and still printed), uncaught errors and rejections, and the game log
// main.js keeps in atv.log (the guest's stdout/stderr from every worker, the
// loader, audio, WebGPU messages). The file starts with a header: time,
// address, browser, isolation, WebGPU adapter, settings, the status line and
// the loader/boot state.
import { toText, loadSettings, describeLaunch } from './settings.js';

const MAX_LINES = 20000;
const lines = [];
let dropped = 0;
const t0 = performance.now();

function keep(kind, args) {
  const text = args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ?? String(a);
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  lines.push(`${((performance.now() - t0) / 1000).toFixed(3).padStart(9)} ${kind.padEnd(5)} ${text}`);
  if (lines.length > MAX_LINES) { dropped += lines.length - MAX_LINES; lines.splice(0, lines.length - MAX_LINES); }
}

let installed = false;
export function installLogCapture() {
  if (installed) return;
  installed = true;
  for (const kind of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[kind].bind(console);
    console[kind] = (...args) => { keep(kind, args); orig(...args); };
  }
  addEventListener('error', (e) => keep('ERROR', [`${e.message} at ${e.filename}:${e.lineno}:${e.colno}`]));
  addEventListener('unhandledrejection', (e) => keep('ERROR', [`unhandled rejection: ${e.reason?.stack ?? e.reason}`]));
}

/** A line from the site itself (also in the page console). */
export function siteLog(text) { console.info(`[site] ${text}`); }

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** The whole log as text. */
export function logText() {
  const atv = window.atv;
  const out = [];
  const gpu = atv?.log?.find?.((l) => l.startsWith('[page] WebGPU:'));
  const ua = navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(', ');
  let env = '';
  try { env = describeLaunch().join(' '); } catch { /* */ }
  out.push('ATV 2 (browser) log', `saved      ${new Date().toString()}`, `address    ${location.href}`,
    `browser    ${navigator.userAgent}${ua ? ` (${ua})` : ''}`,
    `isolated   ${self.crossOriginIsolated}  threads ${navigator.hardwareConcurrency}  memory ${navigator.deviceMemory ?? '?'} GB`,
    `webgpu     ${gpu ? gpu.slice(15) : navigator.gpu ? 'available (not started)' : 'not available'}`,
    `status     ${document.getElementById('status')?.textContent ?? ''}`,
    `boot       ${atv ? `stage ${atv.stage?.()}, exit ${atv.state?.exit}, error ${atv.state?.error ?? 'none'}` : 'the game was not started'}`,
    `loader     ${atv?.loader ? JSON.stringify({ phase: atv.loader.phase, error: atv.loader.error }) : 'n/a'}`,
    `settings   start options from settings: ${env || '(none)'}`, '');
  out.push('--- settings', toText(loadSettings()).trim(), '');
  if (atv?.log?.length) out.push(`--- game and page log (${atv.log.length} lines)`, ...atv.log, '');
  out.push(`--- page console (${lines.length} lines${dropped ? `; ${dropped} older lines dropped` : ''})`, ...lines, '');
  return out.join('\n');
}

/** Save the log as a .txt download. Returns the file name. */
export function downloadLog() {
  const name = `atv2-log-${stamp()}.txt`;
  downloadBlob(new Blob([logText()], { type: 'text/plain' }), name);
  return name;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
