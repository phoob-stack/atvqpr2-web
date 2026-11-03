// Keyboard and Gamepad API -> the host block (src/web/web_host.h). The game
// side (src/web/web_input.c) resolves keys through keyboard.c's one map:
// Enter = START, Z = A, X = B, C = X, V = Y, arrows = d-pad, W/A/S/D = left
// stick, Backspace = BACK. A standard-mapping gamepad is mapped here to the
// Xbox layout and merged with the keys.
import { Host, HOST_KEYS_OFFSET } from './abi.js';
// [site] the player's bindings (site/keymap.js): keyVks() is null with the default keys.
import { keyVks, remapPad } from './site/keymap.js';

const VK = {
  Enter: 0x0d, NumpadEnter: 0x0d, Backspace: 0x08, Tab: 0x09, Escape: 0x1b, Space: 0x20,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24, Insert: 0x2d, Delete: 0x2e,
  ShiftLeft: [0x10, 0xa0], ShiftRight: [0x10, 0xa1], ControlLeft: [0x11, 0xa2],
  ControlRight: [0x11, 0xa3], AltLeft: [0x12, 0xa4], AltRight: [0x12, 0xa5],
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf,
  Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
};
function vkOf(code) {
  if (VK[code] !== undefined) return [].concat(VK[code]);
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return [m[1].charCodeAt(0)];
  if ((m = /^Digit(\d)$/.exec(code))) return [0x30 + Number(m[1])];
  if ((m = /^Numpad(\d)$/.exec(code))) return [0x60 + Number(m[1])];
  if ((m = /^F(\d+)$/.exec(code)) && m[1] <= 12) return [0x6f + Number(m[1])];
  return [];
}

// Xbox wButtons bits and bAnalogButtons slots.
const DPAD = [0x1, 0x2, 0x4, 0x8], START = 0x10, BACK = 0x20, LTHUMB = 0x40, RTHUMB = 0x80;
const A = 0, B = 1, X = 2, Y = 3, BLACK = 4, WHITE = 5, LT = 6, RT = 7;

export class Input {
  constructor(memory, hostPtr) {
    this.memory = memory; this.ptr = hostPtr;
    this.i32 = new Int32Array(memory.buffer, hostPtr, Host.words);
    this.keys = new Uint8Array(memory.buffer, hostPtr + HOST_KEYS_OFFSET, 256);
    this.u8 = new Uint8Array(memory.buffer, hostPtr + Host.at.pad_analog * 4, 8);
    this.down = new Set();
    this.padName = '';
    const set = (e, v) => {
      const vks = keyVks(e.code) ?? vkOf(e.code);   // [site] rebinding
      if (!vks.length) return;
      for (const k of vks) this.keys[k] = v;
      if (v) this.down.add(e.code); else this.down.delete(e.code);
      if (!e.ctrlKey && !e.metaKey && e.code !== 'F5' && e.code !== 'F12') e.preventDefault();
    };
    addEventListener('keydown', (e) => set(e, 1));
    addEventListener('keyup', (e) => set(e, 0));
    addEventListener('blur', () => { this.keys.fill(0); this.down.clear(); });
  }

  /** Set a key by VK code (tests / on-screen buttons). */
  key(vk, down) { this.keys[vk] = down ? 1 : 0; }

  /** Once per animation frame: the first connected gamepad -> pad_* fields. */
  pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const g = remapPad([...pads].find((p) => p && p.connected));   // [site] pad bindings, menu
    const i = this.i32, at = Host.at;
    Atomics.add(i, at.pad_seq, 1);                 // odd: writing
    if (!g) {
      i[at.pad_connected] = 0;
      this.padName = '';
    } else {
      const btn = (k) => g.buttons[k]?.pressed ?? false;
      const val = (k) => Math.round(255 * (g.buttons[k]?.value ?? 0));
      let w = 0;
      [12, 13, 14, 15].forEach((k, n) => { if (btn(k)) w |= DPAD[n]; });
      if (btn(9)) w |= START; if (btn(8)) w |= BACK; if (btn(10)) w |= LTHUMB; if (btn(11)) w |= RTHUMB;
      const an = new Uint8Array(8);
      an[A] = val(0); an[B] = val(1); an[X] = val(2); an[Y] = val(3);
      an[WHITE] = val(4); an[BLACK] = val(5); an[LT] = val(6); an[RT] = val(7);
      const ax = (k, s = 1) => {
        let v = (g.axes[k] ?? 0) * s;
        if (Math.abs(v) < 0.12) v = 0;
        return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      };
      i[at.pad_buttons] = w;
      this.u8.set(an);
      i[at.pad_thumb] = ax(0); i[at.pad_thumb + 1] = ax(1, -1);
      i[at.pad_thumb + 2] = ax(2); i[at.pad_thumb + 3] = ax(3, -1);
      i[at.pad_connected] = 1;
      this.padName = g.id;
      const rb = i[at.pad_rumble] >>> 0;
      if (rb !== this.rumble && g.vibrationActuator) {
        this.rumble = rb;
        g.vibrationActuator.playEffect('dual-rumble', { duration: rb ? 1000 : 0,
          strongMagnitude: (rb >>> 16) / 65535, weakMagnitude: (rb & 0xffff) / 65535 }).catch(() => {});
      }
    }
    Atomics.add(i, at.pad_seq, 1);                 // even: done
  }
}
