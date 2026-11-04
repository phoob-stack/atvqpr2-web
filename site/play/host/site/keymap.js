// The control bindings input.js reads (site settings, "Controls").
//
// Keyboard: the game side (xboxrecomp keyboard.c, through web_input.c) has
// one fixed map from Windows VK codes to pad controls: Z = A, X = B, Enter =
// START, W/A/S/D = left stick... Rebinding does not touch that map. Each
// action here names the VK keyboard.c expects for it, and keyVks(code) tells
// input.js which of those VKs a physical key (KeyboardEvent.code) presses.
// With no custom bindings stored keyVks() returns null and input.js keeps its
// own code -> VK table, so the default is exactly the old behaviour.
//
// Gamepad: input.js reads a standard-mapping pad by button number (0 = A,
// 1 = B ... 9 = Start, 12-15 = d-pad). remapPad(g) gives it a view of the pad
// whose buttons are permuted by the player's table, and a released, centred
// pad while the in-game menu is open (window.atvSite.menuOpen), so menu
// navigation does not drive the quad.
//
// The bindings live in localStorage (settings.js, key_<action> / pad_<id>);
// this module re-reads them when settings change (same tab: the
// atv2-settings event; other tabs: storage).

export const ACTIONS = [
  { id: 'a', label: 'A (accelerate / select)', vk: 0x5a, keys: ['KeyZ'] },
  { id: 'b', label: 'B (brake / back)', vk: 0x58, keys: ['KeyX'] },
  { id: 'x', label: 'X', vk: 0x43, keys: ['KeyC'] },
  { id: 'y', label: 'Y', vk: 0x56, keys: ['KeyV'] },
  { id: 'white', label: 'White', vk: 0x51, keys: ['KeyQ'] },
  { id: 'black', label: 'Black', vk: 0x45, keys: ['KeyE'] },
  { id: 'lt', label: 'Left trigger', vk: 0x31, keys: ['Digit1'] },
  { id: 'rt', label: 'Right trigger', vk: 0x33, keys: ['Digit3'] },
  { id: 'start', label: 'START', vk: 0x0d, keys: ['Enter', 'NumpadEnter'] },
  { id: 'back', label: 'BACK', vk: 0x08, keys: ['Backspace'] },
  { id: 'dup', label: 'D-pad up', vk: 0x26, keys: ['ArrowUp'] },
  { id: 'ddown', label: 'D-pad down', vk: 0x28, keys: ['ArrowDown'] },
  { id: 'dleft', label: 'D-pad left', vk: 0x25, keys: ['ArrowLeft'] },
  { id: 'dright', label: 'D-pad right', vk: 0x27, keys: ['ArrowRight'] },
  { id: 'ls_up', label: 'Left stick up', vk: 0x57, keys: ['KeyW', 'Numpad8'] },
  { id: 'ls_down', label: 'Left stick down', vk: 0x53, keys: ['KeyS', 'Numpad2'] },
  { id: 'ls_left', label: 'Left stick left (steer)', vk: 0x41, keys: ['KeyA', 'Numpad4'] },
  { id: 'ls_right', label: 'Left stick right (steer)', vk: 0x44, keys: ['KeyD', 'Numpad6'] },
  { id: 'rs_up', label: 'Right stick up', vk: 0x49, keys: ['KeyI'] },
  { id: 'rs_down', label: 'Right stick down', vk: 0x4b, keys: ['KeyK'] },
  { id: 'rs_left', label: 'Right stick left', vk: 0x4a, keys: ['KeyJ'] },
  { id: 'rs_right', label: 'Right stick right', vk: 0x4c, keys: ['KeyL'] },
  { id: 'lthumb', label: 'Left stick click', vk: 0x10, keys: ['ShiftLeft', 'ShiftRight'] },
  { id: 'rthumb', label: 'Right stick click', vk: 0x11, keys: ['ControlLeft', 'ControlRight'] },
];

// Xbox control -> the standard-mapping button input.js reads for it.
export const PAD_CONTROLS = [
  { id: 'a', label: 'A', button: 0 }, { id: 'b', label: 'B', button: 1 },
  { id: 'x', label: 'X', button: 2 }, { id: 'y', label: 'Y', button: 3 },
  { id: 'white', label: 'White', button: 4 }, { id: 'black', label: 'Black', button: 5 },
  { id: 'lt', label: 'Left trigger', button: 6 }, { id: 'rt', label: 'Right trigger', button: 7 },
  { id: 'back', label: 'BACK', button: 8 }, { id: 'start', label: 'START', button: 9 },
  { id: 'lthumb', label: 'Left stick click', button: 10 }, { id: 'rthumb', label: 'Right stick click', button: 11 },
  { id: 'dup', label: 'D-pad up', button: 12 }, { id: 'ddown', label: 'D-pad down', button: 13 },
  { id: 'dleft', label: 'D-pad left', button: 14 }, { id: 'dright', label: 'D-pad right', button: 15 },
];
export const PAD_BUTTONS = 17;                 // 16 = the guide/home button on some pads
// Names of the standard mapping's buttons (for the settings page).
export const PAD_BUTTON_NAMES = ['bottom face (A)', 'right face (B)', 'left face (X)', 'top face (Y)', 'left bumper',
  'right bumper', 'left trigger', 'right trigger', 'back / view', 'start / menu', 'left stick press', 'right stick press',
  'd-pad up', 'd-pad down', 'd-pad left', 'd-pad right', 'guide / home'];

const STORE_KEY = 'atv2.settings.v1';          // settings.js (not imported: settings.js imports this file)

let keyTable = null;                            // code -> [vk], or null = input.js's defaults
let padTable = null;                            // standard index -> player's index (or -1), or null = identity

function reload() {
  let vals = null;
  try { vals = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')?.values ?? null; } catch { vals = null; }
  keyTable = null; padTable = null;
  if (!vals) return;
  if (ACTIONS.some((a) => typeof vals[`key_${a.id}`] === 'string')) {
    keyTable = new Map();
    for (const a of ACTIONS) {
      const v = vals[`key_${a.id}`];
      const codes = typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : a.keys;
      for (const c of codes) { if (!keyTable.has(c)) keyTable.set(c, []); keyTable.get(c).push(a.vk); }
    }
  }
  if (PAD_CONTROLS.some((c) => typeof vals[`pad_${c.id}`] === 'string')) {
    padTable = Array.from({ length: PAD_BUTTONS }, (_, i) => i);
    for (const c of PAD_CONTROLS) {
      const v = vals[`pad_${c.id}`];
      if (typeof v === 'string') padTable[c.button] = v === 'none' ? -1 : Number(v);
    }
  }
}
reload();
try {
  addEventListener('atv2-settings', reload);
  addEventListener('storage', (e) => { if (e.key === STORE_KEY || e.key === null) reload(); });
} catch { /* not a window */ }

/** The VK codes a physical key presses, or null when the player kept the default keys. */
export function keyVks(code) {
  if (!keyTable) return null;
  return keyTable.get(code) ?? [];
}

const RELEASED = Object.freeze({ pressed: false, touched: false, value: 0 });
const menuOpen = () => { try { return !!globalThis.atvSite?.menuOpen; } catch { return false; } };

/** The pad input.js should read: g remapped, neutral while the menu is open, or g itself. */
export function remapPad(g) {
  if (!g) return g;
  if (menuOpen()) {
    return { id: g.id, index: g.index, connected: g.connected, mapping: g.mapping, timestamp: g.timestamp,
      axes: g.axes.map(() => 0), buttons: g.buttons.map(() => RELEASED), vibrationActuator: g.vibrationActuator };
  }
  if (!padTable) return g;
  return { id: g.id, index: g.index, connected: g.connected, mapping: g.mapping, timestamp: g.timestamp, axes: g.axes,
    buttons: padTable.map((src) => (src >= 0 ? g.buttons[src] ?? RELEASED : RELEASED)), vibrationActuator: g.vibrationActuator };
}
