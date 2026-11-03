// The settings forms (start page "Settings" tab, and the in-game menu's
// Settings). Every change is stored at once (settings.js); the ones marked
// "next start" reach the game as environment variables the next time it
// boots, the page ones (volume, fps counter, status bar, fullscreen) apply
// live through the atv2-settings event.
import { SETTINGS, SECTIONS, BY_KEY, RESERVED_CODES, CHANGED_EVENT, loadSettings, saveSettings, setSetting, resetSettings,
  parseValue, toText, fromText, describeLaunch, defaults } from './settings.js';
import { ACTIONS, PAD_CONTROLS, PAD_BUTTON_NAMES } from './keymap.js';
import { importConfigFile } from './config-import.js';

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && k !== 'list') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
};
export { h };

const keyName = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow(.*)/, '$1 arrow')
  .replace(/^Numpad(.*)/, 'Keypad $1').replace(/(Left|Right)$/, ' ($1)').replace(/^Space$/, 'Space');

let capture = null;                                // an active "press a key / button" prompt

/** Draw the settings into `root`. opts.inGame: compact, live notes. */
export function renderSettings(root, opts = {}) {
  root.textContent = '';
  root.classList.add('settings');
  const msg = h('div', { class: 'set-msg', role: 'status' });
  const say = (text, cls = '') => { msg.textContent = text; msg.className = `set-msg ${cls}`; };
  const draw = () => renderSettings(root, opts);

  // ---- the plain settings, by section --------------------------------------
  const vals = loadSettings();
  const plain = SETTINGS.filter((s) => s.section !== 'controls' && s.section !== 'gamepad');
  const sections = [...new Set(plain.map((s) => s.section))];
  const grid = h('div', { class: 'set-grid' });
  for (const sec of sections) {
    const box = h('fieldset', { class: 'set-sec' }, h('legend', {}, SECTIONS[sec]));
    for (const s of plain.filter((x) => x.section === sec)) box.append(field(s, vals[s.key], say));
    grid.append(box);
  }
  root.append(grid);

  // ---- controls -------------------------------------------------------------
  root.append(controls(vals, say, draw));

  // ---- text editor ----------------------------------------------------------
  const ta = h('textarea', { class: 'set-text', spellcheck: false, rows: 14, 'aria-label': 'Settings as text' });
  ta.value = toText(vals);
  const notes = h('ul', { class: 'set-notes' });
  const text = h('details', { class: 'set-textbox', open: !!opts.textOpen },
    h('summary', {}, 'Edit settings as text'),
    h('p', { class: 'small' }, 'The same settings as a text file: change values, paste a file from another browser, or copy it into a bug report. A key left out goes back to its default.'),
    ta,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => {
        const r = fromText(ta.value);
        saveSettings(r.values);
        notes.textContent = '';
        for (const n of r.notes) notes.append(h('li', {}, `line ${n.line}: ${n.text}`));
        opts.textOpen = true;
        say(r.notes.length ? `Applied, with ${r.notes.length} line${r.notes.length > 1 ? 's' : ''} refused (see below the box).` : 'Applied.', r.notes.length ? 'warn' : 'ok');
        const keep = [...notes.childNodes];
        renderSettings(root, opts);
        root.querySelector('.set-notes')?.append(...keep);
        root.querySelector('.set-msg').replaceWith(msg);
      } }, 'Apply text'),
      h('button', { class: 'btn ghost', onclick: () => { ta.value = toText(loadSettings()); notes.textContent = ''; } }, 'Undo edits'),
      h('button', { class: 'btn ghost', onclick: () => importConfigFile({ say, done: () => { renderSettings(root, opts); root.querySelector('.set-msg').replaceWith(msg); } }) },
        'Import config file'),
      h('button', { class: 'btn ghost', onclick: async () => {
        try { await navigator.clipboard.writeText(ta.value); say('Copied the settings text.', 'ok'); }
        catch { ta.select(); say('Select-all done: press Ctrl+C to copy.'); }
      } }, 'Copy')),
    notes);
  root.append(text);

  // ---- what the game gets, and reset -----------------------------------------
  const env = describeLaunch(vals);
  let armed = 0;
  const reset = h('button', { class: 'btn danger', onclick: () => {
    if (Date.now() - armed > 4000) { armed = Date.now(); reset.textContent = 'Click again to reset every setting'; return; }
    resetSettings(); draw(); root.querySelector('.set-msg').replaceWith(msg); say('All settings are back to their defaults.', 'ok');
  } }, 'Reset all settings');
  root.append(h('div', { class: 'set-foot' },
    h('div', { class: 'small', 'data-env': env.join(',') },
      env.length ? ['The game starts with: ', h('code', {}, env.join(' '))] : 'The game starts with its defaults.'),
    reset));
  root.append(msg);

  // Keep the text box (unless it is being edited) and the env line in step with
  // changes made elsewhere (the forms above, the in-game menu, another tab).
  let dirty = false;
  ta.addEventListener('input', () => { dirty = true; });
  if (root._onSettings) removeEventListener(CHANGED_EVENT, root._onSettings);
  root._onSettings = () => {
    if (!root.isConnected) return;
    const v = loadSettings();
    if (!dirty) ta.value = toText(v);
    const e = describeLaunch(v);
    const line = root.querySelector('[data-env]');
    if (line) {
      line.dataset.env = e.join(',');
      line.textContent = '';
      line.append(...(e.length ? ['The game starts with: ', h('code', {}, e.join(' '))] : ['The game starts with its defaults.']));
    }
  };
  addEventListener(CHANGED_EVENT, root._onSettings);
  return root;
}

function field(s, v, say) {
  const id = `set-${s.key}`;
  let input;
  const commit = (raw) => {
    const r = parseValue(s, raw);
    if (r.error) { say(`${s.label}: expected ${r.error}.`, 'warn'); return; }
    setSetting(s.key, r.value);
    say(`${s.label}: ${s.type === 'bool' ? (r.value ? 'on' : 'off') : r.value}${s.next ? ' (applies the next time the game starts)' : ''}.`, 'ok');
  };
  if (s.type === 'bool') {
    input = h('input', { type: 'checkbox', id, checked: v, onchange: (e) => commit(e.target.checked ? 'on' : 'off') });
    return h('div', { class: 'set-row check' }, h('label', { for: id }, input, h('span', {}, s.label), s.next ? h('em', {}, 'next start') : null),
      h('div', { class: 'help' }, s.help));
  }
  if (s.type === 'enum') {
    input = h('select', { id, onchange: (e) => commit(e.target.value) },
      s.values.map((x) => h('option', { value: x, selected: x === v }, s.names?.[x] ?? x)));
  } else if (s.type === 'int') {
    const out = h('output', { for: id }, String(v));
    input = h('input', { type: 'range', id, min: s.min, max: s.max, value: v,
      oninput: (e) => { out.textContent = e.target.value; if (s.key === 'volume') window.atv?.audio?.setVolume?.(e.target.value / 100); },
      onchange: (e) => commit(e.target.value) });
    input = h('span', { class: 'range' }, input, out);
  } else {
    input = h('input', { type: 'text', id, value: v, placeholder: 'NAME=value, NAME=value', spellcheck: false,
      onchange: (e) => commit(e.target.value) });
  }
  return h('div', { class: 'set-row' }, h('label', { for: id }, s.label, s.next ? h('em', {}, 'next start') : null), input,
    h('div', { class: 'help' }, s.help));
}

// ---- controls: keyboard and gamepad tables ------------------------------------

function controls(vals, say, draw) {
  const box = h('fieldset', { class: 'set-sec controls' }, h('legend', {}, 'Controls'));
  const tabs = h('div', { class: 'tabs small-tabs', role: 'tablist' });
  const kb = h('div', { class: 'ctl-pane' }), gp = h('div', { class: 'ctl-pane', hidden: true });
  const tab = (label, pane, other) => h('button', { class: 'tab', role: 'tab', onclick: (e) => {
    pane.hidden = false; other.hidden = true;
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b === e.currentTarget));
  } }, label);
  tabs.append(tab('Keyboard', kb, gp), tab('Gamepad', gp, kb));
  tabs.firstChild.setAttribute('aria-selected', 'true');

  // Keyboard
  const kt = h('table', { class: 'ctl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Control'), h('th', {}, 'Keys'), h('th', {}, ''))));
  const kbody = h('tbody');
  for (const a of ACTIONS) {
    const s = BY_KEY[`key_${a.id}`];
    const codes = String(vals[s.key]).split(' ').filter(Boolean);
    const changed = vals[s.key] !== s.def;
    kbody.append(h('tr', { class: changed ? 'changed' : '' },
      h('td', {}, a.label),
      h('td', {}, codes.length ? codes.map((c) => h('kbd', { title: c }, keyName(c))) : h('span', { class: 'muted' }, 'none')),
      h('td', { class: 'acts' },
        h('button', { class: 'btn small', onclick: (e) => pressKey(e.currentTarget, a, 'set', say, draw) }, 'Set'),
        h('button', { class: 'btn small ghost', onclick: (e) => pressKey(e.currentTarget, a, 'add', say, draw) }, 'Add'),
        h('button', { class: 'btn small ghost', title: 'No key', onclick: () => { setSetting(s.key, ''); draw(); } }, 'Clear'))));
  }
  kt.append(kbody);
  kb.append(h('p', { class: 'small' }, 'Set: press the new key. Add: a second key for the same control. A key used elsewhere moves here. F1 opens the in-game menu (Esc too, unless a control uses it).'),
    kt, h('button', { class: 'btn ghost', onclick: () => {
      const v = loadSettings(); for (const a of ACTIONS) v[`key_${a.id}`] = BY_KEY[`key_${a.id}`].def; saveSettings(v); draw();
    } }, 'Default keys'));

  // Gamepad
  const gt = h('table', { class: 'ctl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Xbox control'), h('th', {}, 'Your pad\'s button'), h('th', {}, ''))));
  const gbody = h('tbody');
  for (const c of PAD_CONTROLS) {
    const s = BY_KEY[`pad_${c.id}`];
    const v = vals[s.key];
    gbody.append(h('tr', { class: v !== s.def ? 'changed' : '' },
      h('td', {}, c.label),
      h('td', {}, v === 'none' ? h('span', { class: 'muted' }, 'none') : `${v}: ${PAD_BUTTON_NAMES[v] ?? ''}`),
      h('td', { class: 'acts' },
        h('button', { class: 'btn small', onclick: (e) => pressButton(e.currentTarget, c, say, draw) }, 'Set'),
        h('button', { class: 'btn small ghost', onclick: () => { setSetting(s.key, 'none'); draw(); } }, 'Clear'))));
  }
  gt.append(gbody);
  const padNow = h('p', { class: 'small pad-now' });
  const showPad = () => {
    const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
    padNow.textContent = pads.length ? `Connected: ${pads.map((p) => `${p.id}${p.mapping === 'standard' ? '' : ' (not a standard mapping)'}`).join('; ')}`
      : 'No gamepad seen yet: plug one in and press a button.';
  };
  showPad();
  addEventListener('gamepadconnected', showPad);
  addEventListener('gamepaddisconnected', showPad);
  gp.append(padNow, gt, h('button', { class: 'btn ghost', onclick: () => {
    const v = loadSettings(); for (const c of PAD_CONTROLS) v[`pad_${c.id}`] = BY_KEY[`pad_${c.id}`].def; saveSettings(v); draw();
  } }, 'Default gamepad buttons'));

  box.append(tabs, kb, gp);
  return box;
}

function cancelCapture() { if (capture) { capture.cancel(); capture = null; } }

/** "Press a key" for an action: set (replace) or add. Esc cancels unless ... Esc is what they want: hold-free, so Esc = cancel. */
function pressKey(btn, a, mode, say, draw) {
  cancelCapture();
  const old = btn.textContent;
  btn.textContent = 'Press a key…';
  btn.classList.add('listening');
  say(`Press the key for ${a.label} (Esc cancels).`);
  const onKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.type !== 'keydown' || e.repeat) return;
    if (e.code === 'Escape') { cancelCapture(); say('Cancelled.'); return; }
    if (RESERVED_CODES.has(e.code)) { say(`${e.code} is kept for the page; choose another key.`, 'warn'); return; }
    const v = loadSettings();
    const moved = [];
    for (const x of ACTIONS) {
      if (x.id === a.id) continue;
      const list = String(v[`key_${x.id}`]).split(' ').filter(Boolean);
      if (list.includes(e.code)) { v[`key_${x.id}`] = list.filter((c) => c !== e.code).join(' '); moved.push(x.label); }
    }
    const mine = mode === 'add' ? String(v[`key_${a.id}`]).split(' ').filter(Boolean) : [];
    v[`key_${a.id}`] = [...new Set([...mine, e.code])].join(' ');
    saveSettings(v);
    capture = null; cleanup();
    draw();
    say(`${a.label}: ${keyName(e.code)}${moved.length ? ` (taken from ${moved.join(', ')})` : ''}.`, 'ok');
  };
  const cleanup = () => { removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKey, true); };
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKey, true);
  capture = { cancel: () => { cleanup(); btn.textContent = old; btn.classList.remove('listening'); } };
}

function pressButton(btn, c, say, draw) {
  cancelCapture();
  const old = btn.textContent;
  btn.textContent = 'Press a button…';
  btn.classList.add('listening');
  say(`Press the gamepad button for ${c.label} (10 s; Esc cancels).`);
  const held = () => {
    const out = new Set();
    for (const p of navigator.getGamepads?.() ?? []) if (p) p.buttons.forEach((b, i) => { if (b.pressed) out.add(i); });
    return out;
  };
  const before = held();
  const t0 = performance.now();
  let raf = 0;
  const poll = () => {
    const now = held();
    const fresh = [...now].find((i) => !before.has(i));
    for (const i of [...before]) if (!now.has(i)) before.delete(i);
    if (fresh !== undefined) {
      setSetting(`pad_${c.id}`, String(fresh));
      capture = null; cleanup(); draw();
      say(`${c.label}: button ${fresh} (${PAD_BUTTON_NAMES[fresh] ?? '?'}).`, 'ok');
      return;
    }
    if (performance.now() - t0 > 10000) { cancelCapture(); say('No button pressed; nothing changed.'); return; }
    raf = requestAnimationFrame(poll);
  };
  const onKey = (e) => { if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelCapture(); say('Cancelled.'); } };
  const cleanup = () => { cancelAnimationFrame(raf); removeEventListener('keydown', onKey, true); };
  addEventListener('keydown', onKey, true);
  raf = requestAnimationFrame(poll);
  capture = { cancel: () => { cleanup(); btn.textContent = old; btn.classList.remove('listening'); } };
}

export { CHANGED_EVENT, defaults };
