// The player's settings: one table, kept in localStorage, turned into the
// game's environment at boot (main.js merges settingsEnv() between its
// DEFAULT_ENV and ?env=, so a test's ?env= still wins).
//
// Pure apart from localStorage (wrapped in try/catch: private windows and
// blocked storage just give the defaults). No DOM here; settings-ui.js draws
// the forms, keymap.js reads the control bindings, shell.js/overlay.js the
// page-side ones (fullscreen, volume, fps counter, status bar).
//
// Text form (the "edit settings as text" box): one `key = value` per line,
// `#` or `;` comments, `[section]` headers ignored. A key left out is its
// default. Unknown keys and bad values are refused with a note per line, and
// the other lines still apply.
import { ACTIONS, PAD_CONTROLS, PAD_BUTTONS } from './keymap.js';

export const STORE_KEY = 'atv2.settings.v1';
export const CHANGED_EVENT = 'atv2-settings';

const bool = { parse: (s) => (/^(1|on|yes|true)$/i.test(s) ? true : /^(0|off|no|false)$/i.test(s) ? false : undefined),
  show: (v) => (v ? 'on' : 'off') };

/**
 * Every setting. env(v) gives the variables it sets for the game ({} = none;
 * a null value unsets one of main.js's defaults); `page` ones are read by the
 * page itself. `next: true` = takes effect at the next start of the game.
 */
export const SETTINGS = [
  { key: 'res_scale', section: 'display', label: 'Resolution scale', type: 'enum', values: ['1', '2', '3', '4', 'window'], def: '1',
    names: { 1: '1x (640x480, original)', 2: '2x', 3: '3x', 4: '4x', window: 'Match the window' }, next: true,
    help: 'Renders the game at a multiple of its 640x480 (RECOMP_RES_SCALE).',
    env: (v) => (v === '1' ? {} : { RECOMP_RES_SCALE: v }) },
  { key: 'widescreen', section: 'display', label: 'Widescreen (16:9)', type: 'bool', def: false, next: true,
    help: 'Tells the game the TV is 16:9 (RECOMP_WIDESCREEN).',
    env: (v) => (v ? { RECOMP_WIDESCREEN: '1' } : {}) },
  { key: 'msaa', section: 'display', label: 'Anti-aliasing (MSAA)', type: 'enum', values: ['0', '2', '4', '8'], def: '0',
    names: { 0: 'Off', 2: '2x', 4: '4x', 8: '8x' }, next: true, help: 'Multisampled rendering (RECOMP_MSAA).',
    env: (v) => (v === '0' ? {} : { RECOMP_MSAA: v }) },
  { key: 'frame_pacing', section: 'display', label: 'Frame rate', type: 'enum', values: ['vsync', 'uncapped'], def: 'vsync',
    names: { vsync: '60 fps, vsync (the console\'s pacing)', uncapped: 'Uncapped (benchmark; menus may run fast)' }, next: true,
    help: 'Uncapped turns off the flip pacing (RECOMP_FLIP_PACING).',
    env: (v) => (v === 'uncapped' ? { RECOMP_FLIP_PACING: null } : {}) },
  { key: 'fullscreen', section: 'display', label: 'Start in fullscreen', type: 'bool', def: false, page: true,
    help: 'Play and Free Ride go fullscreen. Esc then opens the menu instead of leaving fullscreen (hold Esc to leave).' },
  { key: 'fps_counter', section: 'display', label: 'FPS counter', type: 'bool', def: false, page: true,
    help: 'Game frames per second in the corner.' },
  { key: 'skip_movies', section: 'game', label: 'Skip the movies', type: 'bool', def: false, next: true,
    help: 'Straight to PRESS START; in-game movies are skipped too (RECOMP_SKIP_MOVIES). On anyway when the movies were not imported.',
    env: (v) => (v ? { RECOMP_SKIP_MOVIES: '1' } : {}) },
  { key: 'volume', section: 'audio', label: 'Volume', type: 'int', min: 0, max: 100, def: 100, page: true,
    help: 'The game\'s sound, 0-100.' },
  { key: 'show_status', section: 'page', label: 'Status bar and log under the game', type: 'bool', def: false, page: true,
    help: 'F2 toggles it while playing.' },
  { key: 'extra_env', section: 'advanced', label: 'Extra environment', type: 'env', def: '', next: true,
    help: 'Comma-separated NAME=value for the runtime (-NAME unsets one). For testing; HOME cannot be changed.' },
];

// Control bindings: key_<action> = space-separated KeyboardEvent.code values,
// pad_<control> = a standard-mapping gamepad button number (or none).
for (const a of ACTIONS) {
  SETTINGS.push({ key: `key_${a.id}`, section: 'controls', label: a.label, type: 'keys', def: a.keys.join(' '), action: a.id });
}
for (const c of PAD_CONTROLS) {
  SETTINGS.push({ key: `pad_${c.id}`, section: 'gamepad', label: c.label, type: 'pad', def: String(c.button), control: c.id });
}

export const BY_KEY = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));
export const SECTIONS = { display: 'Display', game: 'Game', audio: 'Audio', page: 'Page', advanced: 'Advanced',
  controls: 'Keyboard', gamepad: 'Gamepad' };
export const RESERVED_CODES = new Set(['F1', 'F2', 'F5', 'F11', 'F12']);
const ENV_FIXED = new Set(['HOME']);

/** Parse one value; returns { value } or { error }. */
export function parseValue(s, text) {
  text = String(text ?? '').trim();
  switch (s.type) {
    case 'bool': { const v = bool.parse(text); return v === undefined ? { error: 'on or off' } : { value: v }; }
    case 'enum': return s.values.includes(text.toLowerCase()) ? { value: text.toLowerCase() } : { error: `one of ${s.values.join(', ')}` };
    case 'int': {
      if (!/^\d{1,4}$/.test(text)) return { error: `a number ${s.min}-${s.max}` };
      const n = Number(text);
      return n < s.min || n > s.max ? { error: `a number ${s.min}-${s.max}` } : { value: n };
    }
    case 'env': {
      for (const kv of text.split(',').map((x) => x.trim()).filter(Boolean)) {
        const name = kv.replace(/^-/, '').split('=')[0];
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: `"${kv}" is not NAME=value` };
        if (ENV_FIXED.has(name)) return { error: `${name} is set by the page` };
      }
      return { value: text.split(',').map((x) => x.trim()).filter(Boolean).join(',') };
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
    default: return { error: 'unknown type' };
  }
}

export function showValue(s, v) {
  return s.type === 'bool' ? bool.show(v) : String(v);
}

export function defaults() {
  return Object.fromEntries(SETTINGS.map((s) => [s.key, s.def]));
}

/** The stored settings over the defaults (bad stored values are dropped). */
export function loadSettings() {
  const out = defaults();
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'); } catch { stored = null; }
  const vals = stored?.values;
  if (vals && typeof vals === 'object') {
    for (const [k, v] of Object.entries(vals)) {
      const s = BY_KEY[k];
      if (!s) continue;
      const r = parseValue(s, s.type === 'bool' ? bool.show(v) : v);
      if (!r.error) out[k] = r.value;
    }
  }
  return out;
}

/** Store the values that differ from the defaults; tells the page. Returns false when storage is unavailable. */
export function saveSettings(values) {
  const diff = {};
  for (const s of SETTINGS) if (values[s.key] !== undefined && values[s.key] !== s.def) diff[s.key] = values[s.key];
  let ok = true;
  try {
    if (Object.keys(diff).length) localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, values: diff }));
    else localStorage.removeItem(STORE_KEY);
  } catch { ok = false; }
  try { dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { ...values } })); } catch { /* no window (node) */ }
  return ok;
}

export function resetSettings() { return saveSettings(defaults()); }

/** Change one setting (already parsed); returns the new values. */
export function setSetting(key, value) {
  const v = loadSettings();
  v[key] = value;
  saveSettings(v);
  return v;
}

/** The variables the settings give the game: { NAME: value | null (unset) }. */
export function settingsEnv(values = loadSettings()) {
  const env = {};
  for (const s of SETTINGS) if (s.env) Object.assign(env, s.env(values[s.key]));
  for (const kv of String(values.extra_env ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (kv[0] === '-') { env[kv.slice(1)] = null; continue; }
    const i = kv.indexOf('=');
    env[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? '1' : kv.slice(i + 1);
  }
  return env;
}

// ---- the text form ----------------------------------------------------------

/** The settings as an editable text file, every key listed. */
export function toText(values = loadSettings()) {
  const lines = ['# ATV 2 (browser) settings. One "key = value" per line; # starts a comment.',
    '# A key left out goes back to its default. Applies to this browser only.', ''];
  let sec = null;
  for (const s of SETTINGS) {
    if (s.section !== sec) {
      sec = s.section;
      lines.push(`[${sec}]`);
      if (sec === 'controls') lines.push('# Keyboard: space-separated key codes (KeyZ, Space, ArrowUp, ShiftLeft, Numpad8...). F1 F2 F5 F11 F12 are kept for the page.');
      if (sec === 'gamepad') lines.push('# Gamepad: the button number on a standard-mapping pad (0 = bottom face button ... 16), or none.');
    }
    const shown = showValue(s, values[s.key]);
    const hint = s.type === 'enum' ? s.values.join(' | ') : s.type === 'bool' ? 'on | off' : s.type === 'int' ? `${s.min}-${s.max}` : '';
    const isDef = values[s.key] === s.def;
    const note = s.type === 'keys' || s.type === 'pad' ? s.label : hint;
    lines.push(`${s.key} = ${shown}${note ? `    # ${note}${isDef ? '' : ` (default ${showValue(s, s.def)})`}` : ''}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Parse the text form. Returns { values, notes: [{ line, text }] }: values
 * holds every key (defaults for the ones left out or refused).
 */
export function fromText(text) {
  const values = defaults(), notes = [], seen = new Set();
  String(text).split(/\r?\n/).forEach((raw, n) => {
    let line = raw.replace(/\s+[#;].*$/, '').trim();       // trailing comment
    if (!line || line[0] === '#' || line[0] === ';' || /^\[.*\]$/.test(line)) return;
    const eq = line.indexOf('=');
    if (eq < 0) { notes.push({ line: n + 1, text: `"${line.slice(0, 40)}": no "=" (expected key = value)` }); return; }
    const key = line.slice(0, eq).trim().toLowerCase();
    let val = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(val)) val = val.slice(1, -1);
    const s = BY_KEY[key];
    if (!s) { notes.push({ line: n + 1, text: `unknown setting "${key.slice(0, 40)}" (ignored)` }); return; }
    if (seen.has(key)) notes.push({ line: n + 1, text: `${key} is set twice; the later line wins` });
    seen.add(key);
    const r = parseValue(s, val);
    if (r.error) { notes.push({ line: n + 1, text: `${key}: "${val.slice(0, 40)}" refused, expected ${r.error}; keeps the default` }); return; }
    values[key] = r.value;
  });
  return { values, notes };
}
