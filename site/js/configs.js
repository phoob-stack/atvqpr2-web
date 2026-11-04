// Configs page: forms for every setting, keyboard and gamepad tables, the JSON
// editor with validation, export/import of the config file, and the ways to
// hand it to the local game (launch link, settings text).
import { $, h, initChrome, download } from './common.js';
import { SETTINGS, SECTIONS, BY_KEY, LAUNCH, RESERVED_CODES, parseValue, defaults, launchDefaults, loadConfig, saveConfig,
  configJson, validateConfigText, toText, launchUrl, localCompat, keyClashes } from './config-model.js';
import { ACTIONS, PAD_CONTROLS, PAD_BUTTON_NAMES, PAD_BUTTONS } from './keymap.js';

initChrome();
let cfg = loadConfig();
let jsonDirty = false;

const say = (text, cls = '') => { const m = $('cfg-msg'); m.textContent = text; m.className = `msg ${cls}`; };

function commit(why) {
  saveConfig(cfg);
  if (!jsonDirty) { $('cfg-json').value = configJson(cfg); check(); }
  refreshOut();
  if (why) say(why, 'ok');
}

// ---- forms --------------------------------------------------------------------------

function field(s) {
  const id = `set-${s.key}`;
  const v = cfg.values[s.key];
  const help = h('div', { class: 'help', id: `${id}-help` }, s.help);
  const set = (raw) => {
    const r = parseValue(s, raw);
    if (r.error) { say(`${s.label}: expected ${r.error}.`, 'warn'); return; }
    cfg.values[s.key] = r.value;
    commit(`${s.label}: ${s.type === 'bool' ? (r.value ? 'on' : 'off') : (s.names?.[r.value] ?? r.value)}.`);
  };
  if (s.type === 'bool') {
    return h('div', { class: 'field check' },
      h('label', { for: id }, h('input', { type: 'checkbox', id, checked: v, 'aria-describedby': `${id}-help`, onchange: (e) => set(e.target.checked ? 'on' : 'off') }),
        h('span', {}, s.label), s.page ? h('span', { class: 'badge' }, 'page') : null), help);
  }
  let input;
  if (s.type === 'enum') {
    input = h('select', { id, 'aria-describedby': `${id}-help`, onchange: (e) => set(e.target.value) },
      s.values.map((x) => h('option', { value: x, selected: x === v }, s.names?.[x] ?? x)));
  } else if (s.type === 'int') {
    const out = h('output', { for: id, id: `${id}-out` }, String(v));
    input = h('span', { class: 'range' }, h('input', { type: 'range', id, min: s.min, max: s.max, value: v, 'aria-describedby': `${id}-help`,
      oninput: (e) => { out.textContent = e.target.value; }, onchange: (e) => set(e.target.value) }), out);
  } else {
    input = h('input', { type: 'text', id, value: v, placeholder: s.placeholder ?? 'NAME=value, NAME=value', spellcheck: false, autocomplete: 'off',
      maxlength: s.max ?? null,
      'aria-describedby': `${id}-help`, onchange: (e) => set(e.target.value) });
  }
  return h('div', { class: 'field' }, h('label', { for: id }, s.label, s.page ? h('span', { class: 'badge' }, 'page') : null), input, help);
}

function drawForms() {
  const root = $('cfg-forms');
  root.textContent = '';
  const plain = SETTINGS.filter((s) => s.section !== 'controls' && s.section !== 'gamepad');
  const grid = h('div', { class: 'set-grid' });
  for (const sec of [...new Set(plain.map((s) => s.section))]) {
    grid.append(h('fieldset', { class: 'sec', id: `sec-${sec}` }, h('legend', {}, SECTIONS[sec]), plain.filter((s) => s.section === sec).map(field)));
  }
  root.append(grid, h('p', { class: 'small muted' }, h('span', { class: 'badge' }, 'page'),
    ' = applied by the local game page itself (not part of the launch link; use the settings text).'));

  const launch = $('cfg-launch');
  launch.textContent = '';
  for (const [k, o] of Object.entries(LAUNCH)) {
    const id = `launch-${k}`;
    launch.append(h('div', { class: 'field' }, h('label', { for: id }, o.label),
      h('select', { id, onchange: (e) => { cfg.launch[k] = e.target.value; commit(`${o.label}: ${o.names[e.target.value]}.`); } },
        o.values.map((x) => h('option', { value: x, selected: cfg.launch[k] === x }, o.names[x])))));
  }
}

// ---- controls -----------------------------------------------------------------------------

const keyName = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow(.*)/, '$1 arrow')
  .replace(/^Numpad(.*)/, 'Keypad $1').replace(/(.)(Left|Right)$/, '$1 ($2)');
let capture = null;
const stopCapture = () => { if (capture) { capture(); capture = null; } };

function drawControls() {
  const kb = $('pane-kb'), gp = $('pane-pad');
  kb.textContent = ''; gp.textContent = '';
  const kt = h('table', { class: 'list', id: 'keys-table' }, h('caption', { class: 'sr-only' }, 'Keyboard bindings'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Control'), h('th', { scope: 'col' }, 'Keys'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))));
  const kbody = h('tbody');
  for (const a of ACTIONS) {
    const s = BY_KEY[`key_${a.id}`];
    const codes = String(cfg.values[s.key]).split(' ').filter(Boolean);
    kbody.append(h('tr', { class: cfg.values[s.key] !== s.def ? 'changed' : '', 'data-action': a.id },
      h('th', { scope: 'row', style: 'font-weight:400;color:inherit' }, a.label),
      h('td', {}, codes.length ? codes.map((c) => h('kbd', { title: c }, keyName(c))) : h('span', { class: 'muted' }, 'none')),
      h('td', { class: 'acts' },
        h('button', { class: 'btn small', type: 'button', 'aria-label': `Set the key for ${a.label}`, onclick: (e) => pressKey(e.currentTarget, a, 'set') }, 'Set'),
        h('button', { class: 'btn small ghost opt', type: 'button', 'aria-label': `Add a key for ${a.label}`, onclick: (e) => pressKey(e.currentTarget, a, 'add') }, 'Add'),
        h('button', { class: 'btn small ghost', type: 'button', 'aria-label': `Clear the keys of ${a.label}`, onclick: () => { cfg.values[s.key] = ''; commit(`${a.label}: no key.`); drawControls(); } }, 'Clear'))));
  }
  kt.append(kbody);
  const clashes = keyClashes(cfg.values);
  kb.append(h('p', { class: 'small' }, 'Set, then press the new key (Esc cancels). Add gives the control a second key. A key taken from another control moves here. F1, F2, F5, F11 and F12 are kept for the game page.'),
    h('div', { class: 'table-wrap' }, kt),
    ...(clashes.length ? [h('ul', { class: 'problems' }, clashes.map((c) => h('li', { class: 'warn' }, c)))] : []),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => {
      for (const a of ACTIONS) cfg.values[`key_${a.id}`] = BY_KEY[`key_${a.id}`].def; commit('Default keys.'); drawControls();
    } }, 'Default keys')));

  const gt = h('table', { class: 'list', id: 'pad-table' }, h('caption', { class: 'sr-only' }, 'Gamepad buttons'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Xbox control'), h('th', { scope: 'col' }, 'Your pad\'s button'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))));
  const gbody = h('tbody');
  for (const c of PAD_CONTROLS) {
    const s = BY_KEY[`pad_${c.id}`];
    const id = `pad-${c.id}`;
    gbody.append(h('tr', { class: cfg.values[s.key] !== s.def ? 'changed' : '' },
      h('th', { scope: 'row', style: 'font-weight:400;color:inherit' }, h('label', { for: id }, c.label)),
      h('td', {}, h('select', { id, onchange: (e) => { cfg.values[s.key] = e.target.value; commit(`${c.label}: ${e.target.value === 'none' ? 'no button' : `button ${e.target.value}`}.`); drawControls(); } },
        h('option', { value: 'none', selected: cfg.values[s.key] === 'none' }, 'none'),
        [...Array(PAD_BUTTONS).keys()].map((i) => h('option', { value: String(i), selected: cfg.values[s.key] === String(i) }, `${i}: ${PAD_BUTTON_NAMES[i]}`)))),
      h('td', { class: 'acts' }, h('button', { class: 'btn small ghost', type: 'button', 'aria-label': `Press a gamepad button for ${c.label}`, onclick: (e) => pressButton(e.currentTarget, c) }, 'Press'))));
  }
  gt.append(gbody);
  gp.append(h('p', { class: 'small' }, 'Which button of a standard-layout pad drives each Xbox control. Choose from the list, or Press and then press the button on a connected pad.'),
    h('div', { class: 'table-wrap' }, gt),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => {
      for (const c of PAD_CONTROLS) cfg.values[`pad_${c.id}`] = BY_KEY[`pad_${c.id}`].def; commit('Default gamepad buttons.'); drawControls();
    } }, 'Default gamepad buttons')));
}

function pressKey(btn, a, mode) {
  stopCapture();
  const old = btn.textContent;
  btn.textContent = 'Press a key…'; btn.classList.add('listening');
  say(`Press the key for ${a.label} (Esc cancels).`);
  const onKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.repeat) return;
    if (e.code === 'Escape') { stopCapture(); say('Cancelled.'); return; }
    if (RESERVED_CODES.has(e.code)) { say(`${e.code} is kept for the game page; choose another key.`, 'warn'); return; }
    const moved = [];
    for (const x of ACTIONS) {
      if (x.id === a.id) continue;
      const list = String(cfg.values[`key_${x.id}`]).split(' ').filter(Boolean);
      if (list.includes(e.code)) { cfg.values[`key_${x.id}`] = list.filter((c) => c !== e.code).join(' '); moved.push(x.label); }
    }
    const mine = mode === 'add' ? String(cfg.values[`key_${a.id}`]).split(' ').filter(Boolean) : [];
    cfg.values[`key_${a.id}`] = [...new Set([...mine, e.code])].join(' ');
    capture = null; cleanup();
    commit(`${a.label}: ${keyName(e.code)}${moved.length ? ` (taken from ${moved.join(', ')})` : ''}.`);
    drawControls();
  };
  const cleanup = () => removeEventListener('keydown', onKey, true);
  addEventListener('keydown', onKey, true);
  capture = () => { cleanup(); btn.textContent = old; btn.classList.remove('listening'); };
}

function pressButton(btn, c) {
  stopCapture();
  const old = btn.textContent;
  btn.textContent = 'Press a button…'; btn.classList.add('listening');
  say(`Press the pad button for ${c.label} (10 s; Esc cancels).`);
  const held = () => { const out = new Set(); for (const p of navigator.getGamepads?.() ?? []) if (p) p.buttons.forEach((b, i) => { if (b.pressed) out.add(i); }); return out; };
  const before = held(), t0 = performance.now();
  let raf = 0;
  const poll = () => {
    const now = held();
    const fresh = [...now].find((i) => !before.has(i));
    if (fresh !== undefined) {
      cfg.values[`pad_${c.id}`] = String(fresh);
      capture = null; cleanup(); commit(`${c.label}: button ${fresh}.`); drawControls(); return;
    }
    if (performance.now() - t0 > 10000) { stopCapture(); say('No button pressed; nothing changed.'); return; }
    raf = requestAnimationFrame(poll);
  };
  const onKey = (e) => { if (e.code === 'Escape') { e.preventDefault(); stopCapture(); say('Cancelled.'); } };
  const cleanup = () => { cancelAnimationFrame(raf); removeEventListener('keydown', onKey, true); };
  addEventListener('keydown', onKey, true);
  raf = requestAnimationFrame(poll);
  capture = () => { cleanup(); btn.textContent = old; btn.classList.remove('listening'); };
}

function initTabs() {
  const tabs = [$('tab-kb'), $('tab-pad')];
  const pick = (t) => {
    for (const x of tabs) {
      const on = x === t;
      x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1;
      $(x.getAttribute('aria-controls')).hidden = !on;
    }
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => pick(t));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      pick(n); n.focus();
    });
  });
}

// ---- JSON editor, file export / import ------------------------------------------------------

function showProblems(r) {
  const ul = $('cfg-problems');
  ul.textContent = '';
  for (const e of r.errors) ul.append(h('li', { class: 'err' }, e.line ? `Line ${e.line}: ${e.text}` : e.text));
  for (const w of r.warnings) ul.append(h('li', { class: 'warn' }, w));
}

function check() {
  const ta = $('cfg-json');
  const r = validateConfigText(ta.value);
  ta.setAttribute('aria-invalid', String(!r.ok));
  const c = $('cfg-check');
  c.textContent = r.ok ? (jsonDirty ? 'Valid. Apply text to use it.' : 'Valid. This is the current config.') : `${r.errors.length} problem${r.errors.length > 1 ? 's' : ''}: fix ${r.errors.length > 1 ? 'them' : 'it'} to apply.`;
  c.className = `msg ${r.ok ? 'ok' : 'err'}`;
  c.dataset.valid = String(r.ok);
  $('cfg-apply').disabled = !r.ok;
  showProblems(r);
  return r;
}

function applyConfig(next, why) {
  cfg = { values: { ...defaults(), ...next.values }, launch: { ...launchDefaults(), ...next.launch } };
  jsonDirty = false;
  drawForms(); drawControls();
  commit(why);
}

function initJson() {
  const ta = $('cfg-json');
  ta.value = configJson(cfg);
  let t = 0;
  ta.addEventListener('input', () => { jsonDirty = true; clearTimeout(t); t = setTimeout(check, 250); });
  $('cfg-apply').addEventListener('click', () => {
    const r = check();
    if (!r.ok) { say('Not applied: the text has problems (listed above).', 'err'); return; }
    applyConfig(r.config, 'Applied the text.');
  });
  $('cfg-revert').addEventListener('click', () => { jsonDirty = false; ta.value = configJson(cfg); check(); say('Back to the current config.'); });
  $('cfg-export').addEventListener('click', () => {
    const name = `atv2-config-${new Date().toISOString().slice(0, 10)}.json`;
    download(name, configJson(cfg));
    say(`Saved ${name} to your downloads.`, 'ok');
  });
  $('cfg-import').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 256 * 1024) { say(`${f.name} is ${Math.round(f.size / 1024)} KB; a config file is a few KB.`, 'err'); return; }
    const text = await f.text();
    const r = validateConfigText(text);
    if (!r.ok) {
      jsonDirty = true; ta.value = text; check();
      say(`${f.name} was not imported: it has ${r.errors.length} problem${r.errors.length > 1 ? 's' : ''} (shown in the editor).`, 'err');
      return;
    }
    applyConfig(r.config, `Imported ${f.name}.`);
  });
  check();
}

// ---- to the local game -----------------------------------------------------------------------

function refreshOut() {
  const url = launchUrl(cfg.values, cfg.launch);
  $('launch-url').textContent = url;
  $('launch-open').href = url;
  const notes = $('launch-notes');
  notes.textContent = '';
  for (const n of localCompat(cfg.values)) notes.append(h('li', { class: 'warn' }, n));
  $('text-preview').textContent = toText(cfg.values);
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); say(`Copied the ${what}.`, 'ok'); }
  catch { say(`Could not reach the clipboard; select the ${what} and copy it by hand.`, 'warn'); }
}

$('launch-copy').addEventListener('click', () => copy(launchUrl(cfg.values, cfg.launch), 'launch link'));
$('text-copy').addEventListener('click', () => copy(toText(cfg.values), 'settings text'));
$('text-download').addEventListener('click', () => { download('atv2-settings.txt', toText(cfg.values), 'text/plain'); say('Saved atv2-settings.txt to your downloads.', 'ok'); });

let armed = 0;
$('cfg-reset').addEventListener('click', (e) => {
  if (Date.now() - armed > 4000) { armed = Date.now(); e.currentTarget.textContent = 'Click again to reset every setting'; return; }
  e.currentTarget.textContent = 'Reset every setting';
  applyConfig({ values: defaults(), launch: launchDefaults() }, 'Every setting is back to its default.');
});

drawForms();
drawControls();
initTabs();
initJson();
refreshOut();
window.atv2Config = { get: () => structuredClone(cfg) };     // for the site's own tests
