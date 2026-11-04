// The config model: every setting the local build understands, the same keys
// and value forms as its settings.js (localStorage "atv2.settings.v1" =
// { version: 1, values: { key: value } }, values that differ from the
// default), so a config made here can be handed to it as-is.
//
// Three ways out to the local build (see configs.html):
//   - configFile(): JSON { format, version: 1, values, launch } -- the
//     { version, values } part is exactly what the local build stores;
//   - toText(): the local Settings page's "Edit settings as text" form;
//   - launchUrl(): http://127.0.0.1:8460/host/index.html?res=&msaa=&widescreen=&env=&saves=
//     which the local page reads at start.
// No DOM in this file.
import { ACTIONS, PAD_CONTROLS, PAD_BUTTONS } from './keymap.js';

export const STORE_KEY = 'atv2.settings.v1';
export const FORMAT = 'atv2-settings';
export const LOCAL_GAME = 'http://127.0.0.1:8460';
export const LOCAL_PAGE = `${LOCAL_GAME}/host/index.html`;

const bool = {
  parse: (s) => (/^(1|on|yes|true)$/i.test(s) ? true : /^(0|off|no|false)$/i.test(s) ? false : undefined),
  show: (v) => (v ? 'on' : 'off'),
};

/**
 * section, label, type (bool | enum | int | env | keys | pad), def, help.
 * query(v): page parameters for the launch link ({ name: value | null }).
 * env(v): environment variables for the game ({ NAME: value | null = unset }).
 * local: values the local Settings page accepts today, when fewer than here.
 */
export const SETTINGS = [
  { key: 'res_scale', section: 'display', label: 'Resolution scale', type: 'enum', values: ['1', '2', '3', '4', '5', '6', '7', '8', 'window'], def: '1',
    names: { 1: '1x (640x480, as on the console)', 2: '2x', 3: '3x', 4: '4x', 5: '5x', 6: '6x', 7: '7x', 8: '8x', window: 'Match the window size' },
    help: 'Draws the game at a multiple of its 640x480, or at the size of the window.',
    query: (v) => ({ res: v === '1' ? null : v }) },
  { key: 'msaa', section: 'display', label: 'Anti-aliasing (MSAA)', type: 'enum', values: ['0', '2', '4', '8'], def: '0',
    names: { 0: 'Off', 2: '2x', 4: '4x', 8: '8x' },
    help: 'Smooths edges. In the browser WebGPU offers 4x, so 2x and 8x are drawn as 4x; the Windows build takes all four.',
    query: (v) => ({ msaa: v === '0' ? null : v }) },
  { key: 'widescreen', section: 'display', label: 'Widescreen (16:9)', type: 'bool', def: false,
    help: 'The game is told the screen is 16:9 and is shown at 16:9.',
    query: (v) => ({ widescreen: v ? '1' : null }) },
  { key: 'frame_pacing', section: 'display', label: 'Frame rate', type: 'enum', values: ['vsync', 'uncapped'], def: 'vsync',
    names: { vsync: '60 fps with vsync (as on the console)', uncapped: 'Uncapped (for benchmarks; menus may run fast)' },
    help: 'Uncapped turns the frame pacing off.',
    env: (v) => (v === 'uncapped' ? { RECOMP_FLIP_PACING: null } : {}) },
  { key: 'fullscreen', section: 'display', label: 'Start in fullscreen', type: 'bool', def: false, page: true,
    help: 'Play goes fullscreen. Applies when the game is started with a click on its own page.' },
  { key: 'fps_counter', section: 'display', label: 'FPS counter', type: 'bool', def: false, page: true,
    help: 'Frames per second in a corner of the game.' },
  { key: 'volume', section: 'audio', label: 'Volume', type: 'int', min: 0, max: 100, def: 100, page: true,
    help: 'The game\'s sound, 0 to 100.' },
  { key: 'skip_movies', section: 'audio', label: 'Skip the movies', type: 'bool', def: false,
    help: 'Goes straight to the title screen; movies during play are skipped too.',
    env: (v) => (v ? { RECOMP_SKIP_MOVIES: '1' } : {}) },
  { key: 'freeride_pick', section: 'game', label: 'Free Ride: choose the rider and ATV', type: 'bool', def: false,
    help: 'Free Ride stops at the rider and ATV choice instead of taking the defaults.' },
  // Online free roam: the Play panel's "Free roam online" passes both in the game page's address (?roam=, ?roam_name=).
  { key: 'roam_name', section: 'online', label: 'Online name', type: 'text', def: '', max: 20, placeholder: 'PLAYER', siteOnly: true,
    check: /^[^;,"\\=\x00-\x1f\x7f-\uffff]+$/, checkText: 'letters, digits, spaces and most punctuation (not ; , " \\ =)',
    help: 'Shown over your quad to other riders in online free roam. Up to 20 characters.' },
  { key: 'roam_server', section: 'online', label: 'Free roam server', type: 'text', def: 'wss://hub.atvqpr2.com/room/freeride', max: 200, siteOnly: true,
    check: /^wss:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/, checkText: 'a wss:// address',
    help: 'The online free roam server. Leave it as it is.' },
  { key: 'show_status', section: 'page', label: 'Status bar and log under the game', type: 'bool', def: false, page: true,
    help: 'For testing. F2 toggles it while playing.' },
  { key: 'extra_env', section: 'advanced', label: 'Extra environment', type: 'env', def: '',
    help: 'Comma-separated NAME=value pairs for the runtime (-NAME removes one). For testing.' },
];
for (const a of ACTIONS) SETTINGS.push({ key: `key_${a.id}`, section: 'controls', label: a.label, type: 'keys', def: a.keys.join(' '), action: a.id });
for (const c of PAD_CONTROLS) SETTINGS.push({ key: `pad_${c.id}`, section: 'gamepad', label: c.label, type: 'pad', def: String(c.button), control: c.id });

export const BY_KEY = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));
export const SECTIONS = { display: 'Display', audio: 'Audio and movies', game: 'Game', online: 'Online free roam', page: 'Page', advanced: 'Advanced',
  controls: 'Keyboard', gamepad: 'Gamepad' };
export const RESERVED_CODES = new Set(['F1', 'F2', 'F5', 'F11', 'F12']);

// Options of the launch link only (not stored by the local build).
export const LAUNCH = {
  saves: { label: 'Saves', values: ['keep', 'off'], def: 'keep',
    names: { keep: 'Keep saves in the browser (normal)', off: 'Memory only, start empty (for testing; nothing is kept)' } },
  start: { label: 'Start', values: ['play', 'freeride', 'home'], def: 'play',
    names: { play: 'Start the game', freeride: 'Start in Free Ride', home: 'Open the local start page only' } },
};
export const launchDefaults = () => Object.fromEntries(Object.entries(LAUNCH).map(([k, o]) => [k, o.def]));

/** Parse one value: { value } or { error }. */
export function parseValue(s, text) {
  text = String(text ?? '').trim();
  switch (s.type) {
    case 'bool': { const v = bool.parse(text); return v === undefined ? { error: 'on or off (true or false)' } : { value: v }; }
    case 'enum': return s.values.includes(text.toLowerCase()) ? { value: text.toLowerCase() } : { error: `one of ${s.values.join(', ')}` };
    case 'int': {
      if (!/^\d{1,4}$/.test(text)) return { error: `a whole number ${s.min}-${s.max}` };
      const n = Number(text);
      return n < s.min || n > s.max ? { error: `a whole number ${s.min}-${s.max}` } : { value: n };
    }
    case 'env': {
      const parts = text.split(',').map((x) => x.trim()).filter(Boolean);
      for (const kv of parts) {
        const name = kv.replace(/^-/, '').split('=')[0];
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: `"${kv}" is not NAME=value` };
        if (name === 'HOME') return { error: 'HOME is set by the page' };
      }
      return { value: parts.join(',') };
    }
    case 'keys': {
      const codes = text.split(/[\s,]+/).filter(Boolean);
      for (const c of codes) {
        if (!/^[A-Za-z0-9]+$/.test(c)) return { error: `"${c}" is not a key code (like KeyZ, Space, ArrowUp)` };
        if (RESERVED_CODES.has(c)) return { error: `${c} is kept for the page` };
      }
      return { value: [...new Set(codes)].join(' ') };
    }
    case 'pad': {
      if (/^(none|-)?$/i.test(text)) return { value: 'none' };
      if (!/^\d{1,2}$/.test(text) || Number(text) >= PAD_BUTTONS) return { error: `a button number 0-${PAD_BUTTONS - 1}, or none` };
      return { value: String(Number(text)) };
    }
    case 'text': {
      const t = text.trim();
      if (t.length > s.max) return { error: `at most ${s.max} characters` };
      return s.check && t && !s.check.test(t) ? { error: s.checkText } : { value: t };
    }
    default: return { error: 'unknown type' };
  }
}
export const showValue = (s, v) => (s.type === 'bool' ? bool.show(v) : String(v));
export const defaults = () => Object.fromEntries(SETTINGS.map((s) => [s.key, s.def]));

// ---- storage (this site's own origin) -------------------------------------------

export function loadConfig() {
  const values = defaults(), launch = launchDefaults();
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'); } catch { stored = null; }
  for (const [k, v] of Object.entries(stored?.values ?? {})) {
    const s = BY_KEY[k];
    if (!s) continue;
    const r = parseValue(s, s.type === 'bool' ? bool.show(v) : v);
    if (!r.error) values[k] = r.value;
  }
  for (const [k, v] of Object.entries(stored?.launch ?? {})) if (LAUNCH[k]?.values.includes(v)) launch[k] = v;
  return { values, launch };
}

const diff = (values) => {
  const out = {};
  for (const s of SETTINGS) if (values[s.key] !== undefined && values[s.key] !== s.def) out[s.key] = values[s.key];
  return out;
};

export function saveConfig({ values, launch }) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, values: diff(values), launch }));
    return true;
  } catch { return false; }
}

// ---- the JSON file ------------------------------------------------------------------

/** The export file. `values` lists every setting (defaults included) so the file shows what exists. */
export function configFile({ values, launch }, { all = true } = {}) {
  return {
    format: FORMAT, version: 1,
    note: 'ATV 2 browser-build settings. "values" uses the local build\'s keys (localStorage atv2.settings.v1); "launch" is for the launch link only.',
    values: all ? Object.fromEntries(SETTINGS.map((s) => [s.key, values[s.key]])) : diff(values),
    launch: { ...launch },
  };
}
export const configJson = (cfg, opts) => JSON.stringify(configFile(cfg, opts), null, 2) + '\n';

/** Where in the text an offset is (1-based). */
function lineCol(text, at) {
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  return { line, col: at - before.lastIndexOf('\n') };
}
/** The line of a key ("key": in the text), for messages. */
function lineOfKey(text, key) {
  const i = text.indexOf(`"${key}"`);
  return i < 0 ? null : lineCol(text, i).line;
}

/**
 * Check a config file's text. Returns { ok, config: { values, launch } | null, errors: [{ line, text }], warnings }.
 * Strict: any error means nothing is applied. Keys left out keep their defaults.
 * Also takes the local build's own stored form ({ version: 1, values }).
 */
export function validateConfigText(text) {
  const errors = [], warnings = [];
  let data;
  try { data = JSON.parse(text); } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    const lc = m ? lineCol(text, Number(m[1])) : /line (\d+) column (\d+)/.exec(e.message) ? { line: Number(RegExp.$1), col: Number(RegExp.$2) } : null;
    errors.push({ line: lc?.line ?? null, text: `Not valid JSON${lc ? ` (line ${lc.line}, column ${lc.col})` : ''}: ${e.message.replace(/^JSON\.parse: /, '')}` });
    return { ok: false, config: null, errors, warnings };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push({ line: 1, text: 'The file must be a JSON object, like { "format": "atv2-settings", "version": 1, "values": { ... } }.' });
    return { ok: false, config: null, errors, warnings };
  }
  if (data.format !== undefined && data.format !== FORMAT) errors.push({ line: lineOfKey(text, 'format'), text: `"format" must be "${FORMAT}".` });
  if (data.version !== undefined && data.version !== 1) errors.push({ line: lineOfKey(text, 'version'), text: `"version" ${JSON.stringify(data.version)} is not supported (this page reads version 1).` });
  for (const k of Object.keys(data)) if (!['format', 'version', 'values', 'launch', 'note', 'exportedAt'].includes(k))
    errors.push({ line: lineOfKey(text, k), text: `Unknown top-level key "${k}".` });
  const values = defaults(), launch = launchDefaults();
  if (data.values === undefined) warnings.push('No "values": every setting keeps its default.');
  else if (!data.values || typeof data.values !== 'object' || Array.isArray(data.values)) errors.push({ line: lineOfKey(text, 'values'), text: '"values" must be an object of setting: value.' });
  else {
    for (const [k, v] of Object.entries(data.values)) {
      const s = BY_KEY[k];
      if (!s) { errors.push({ line: lineOfKey(text, k), text: `Unknown setting "${k}".` }); continue; }
      const want = s.type === 'bool' ? 'boolean' : s.type === 'int' ? 'number' : 'string';
      if (typeof v !== want) { errors.push({ line: lineOfKey(text, k), text: `${k}: expected a ${want}, got ${JSON.stringify(v)}.` }); continue; }
      const r = parseValue(s, s.type === 'bool' ? bool.show(v) : String(v));
      if (r.error) { errors.push({ line: lineOfKey(text, k), text: `${k}: ${JSON.stringify(v)} is not allowed; expected ${r.error}.` }); continue; }
      values[k] = r.value;
    }
  }
  if (data.launch !== undefined) {
    if (!data.launch || typeof data.launch !== 'object' || Array.isArray(data.launch)) errors.push({ line: lineOfKey(text, 'launch'), text: '"launch" must be an object.' });
    else for (const [k, v] of Object.entries(data.launch)) {
      const o = LAUNCH[k];
      if (!o) errors.push({ line: lineOfKey(text, k), text: `Unknown launch option "${k}".` });
      else if (!o.values.includes(v)) errors.push({ line: lineOfKey(text, k), text: `launch.${k}: ${JSON.stringify(v)} is not allowed; expected one of ${o.values.join(', ')}.` });
      else launch[k] = v;
    }
  }
  if (!errors.length) warnings.push(...keyClashes(values));
  return { ok: !errors.length, config: errors.length ? null : { values, launch }, errors, warnings };
}

/** Keys bound to more than one control (allowed, but usually a mistake). */
export function keyClashes(values) {
  const by = new Map();
  for (const a of ACTIONS) for (const c of String(values[`key_${a.id}`]).split(' ').filter(Boolean)) by.set(c, [...(by.get(c) ?? []), a.label]);
  return [...by].filter(([, l]) => l.length > 1).map(([c, l]) => `${c} drives ${l.join(' and ')}.`);
}

/** Values the local Settings page (as it is today) would refuse; the launch link still passes them. */
export function localCompat(values) {
  return SETTINGS.filter((s) => s.local && !s.local.includes(values[s.key]))
    .map((s) => `${s.label} ${s.names?.[values[s.key]] ?? values[s.key]}: the local Settings page currently offers ${s.local.join(', ')}; the launch link passes it directly.`);
}

// ---- the local build's text form ---------------------------------------------------

/** The local Settings page's "Edit settings as text" form (key = value lines). */
export function toText(values) {
  const lines = ['# ATV 2 (browser) settings, made on the project site.',
    '# Paste into the local game page: Settings > Edit settings as text > Apply text.', ''];
  let sec = null;
  for (const s of SETTINGS) {
    if (s.siteOnly) continue;            // used by this site's Play panel, not by the local page's settings text
    if (s.section !== sec) { sec = s.section; lines.push(`[${sec}]`); }
    lines.push(`${s.key} = ${showValue(s, values[s.key])}`);
  }
  return lines.join('\n') + '\n';
}

// ---- the launch link -------------------------------------------------------------------

/** The game's environment from the settings, explicit both ways so the local page's stored settings cannot override it. */
export function launchEnv(values, launch = launchDefaults()) {
  const env = {};
  env.RECOMP_SKIP_MOVIES = values.skip_movies ? '1' : null;
  env.RECOMP_FLIP_PACING = values.frame_pacing === 'uncapped' ? null : 'edge';
  if (launch.start === 'freeride') env.RECOMP_FREERIDE = values.freeride_pick ? 'pick' : '1';
  for (const kv of String(values.extra_env ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (kv[0] === '-') { env[kv.slice(1)] = null; continue; }
    const i = kv.indexOf('=');
    env[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? '1' : kv.slice(i + 1);
  }
  return env;
}

/**
 * http://127.0.0.1:8460/host/index.html?... An ?env= parameter makes the
 * local page start the game at once and keep the address's res/msaa/widescreen.
 */
export function launchUrl(values, launch = launchDefaults()) {
  if (launch.start === 'home') return LOCAL_PAGE;
  const q = [];
  q.push(`res=${encodeURIComponent(values.res_scale)}`);
  q.push(`msaa=${encodeURIComponent(values.msaa)}`);
  q.push(`widescreen=${values.widescreen ? '1' : '0'}`);
  if (launch.saves === 'off') q.push('saves=off');
  const env = Object.entries(launchEnv(values, launch)).map(([k, v]) => (v === null ? `-${k}` : `${k}=${v}`)).join(',');
  q.push(`env=${encodeURIComponent(env).replace(/%2C/g, ',').replace(/%3D/g, '=')}`);
  return `${LOCAL_PAGE}?${q.join('&')}`;
}

/** What the link carries, and what it cannot (page-side settings and controls). */
export function launchCoverage() {
  const carried = ['res_scale', 'msaa', 'widescreen', 'frame_pacing', 'skip_movies', 'freeride_pick', 'extra_env'];
  return { carried, notCarried: SETTINGS.filter((s) => !carried.includes(s.key)).map((s) => s.key) };
}
