// Keyboard and Gamepad API -> the host block (src/web/web_host.h). The game
// side (src/web/web_input.c) resolves keys through keyboard.c's one map:
// Enter = START, Z = A, X = B, C = X, V = Y, arrows = d-pad, W/A/S/D = left
// stick, Backspace = BACK. Standard-mapping gamepads are mapped here to the
// Xbox layout, by index: navigator.getGamepads()[n] is Xbox port n + 1 (the
// emulated USB bus plugs a pad into a port while it has one). The keyboard
// is the player on the first port with no gamepad: port 1 when there is
// none (as before), else it joins its port with its first key press.
import { Host, HOST_KEYS_OFFSET, HOST_PADX_OFFSET, PadX } from './abi.js';
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
    // Ports 2-4: u32 views of pad_x[n] and its analog bytes.
    this.x32 = [0, 1, 2].map((n) => new Uint32Array(memory.buffer, hostPtr + HOST_PADX_OFFSET + n * PadX.size, PadX.words));
    this.x8 = [0, 1, 2].map((n) => new Uint8Array(memory.buffer,
      hostPtr + HOST_PADX_OFFSET + n * PadX.size + PadX.at.analog * 4, 8));
    this.down = new Set();
    this.padName = '';
    this.names = ['', '', '', ''];   // per port: gamepad id, 'keyboard' or ''
    this.kbPort = 0; this.kbLive = false;
    this.rumble = [undefined, undefined, undefined, undefined];
    const set = (e, v) => {
      const vks = keyVks(e.code) ?? vkOf(e.code);   // [site] rebinding
      if (!vks.length) return;
      for (const k of vks) this.keys[k] = v;
      if (v) { this.down.add(e.code); this.kbLive = true; } else this.down.delete(e.code);
      if (!e.ctrlKey && !e.metaKey && e.code !== 'F5' && e.code !== 'F12') e.preventDefault();
    };
    addEventListener('keydown', (e) => set(e, 1));
    addEventListener('keyup', (e) => set(e, 0));
    addEventListener('blur', () => { this.keys.fill(0); this.down.clear(); });
  }

  /** Set a key by VK code (tests / on-screen buttons). */
  key(vk, down) { this.keys[vk] = down ? 1 : 0; if (down) this.kbLive = true; }

  /** Once per animation frame: getGamepads()[n] -> Xbox port n + 1, and
   * which port the keyboard drives. */
  pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const i = this.i32, at = Host.at;
    Atomics.add(i, at.pad_seq, 1);                 // odd: writing
    let kb = -1;
    for (let port = 0; port < 4; port++) {
      const g = pads[port] && pads[port].connected ? remapPad(pads[port]) : null;   // [site] bindings, menu
      if (!g && kb < 0) kb = port;
      // Port 1 in the old pad_* fields, ports 2-4 in pad_x[].
      const x = port ? this.x32[port - 1] : null;
      const setConn = (v) => { if (x) x[PadX.at.connected] = v; else i[at.pad_connected] = v; };
      if (!g) { setConn(0); this.names[port] = ''; continue; }
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
      const th = [ax(0), ax(1, -1), ax(2), ax(3, -1)];
      if (x) {
        x[PadX.at.buttons] = w;
        this.x8[port - 1].set(an);
        for (let k = 0; k < 4; k++) x[PadX.at.thumb + k] = th[k] >>> 0;
      } else {
        i[at.pad_buttons] = w;
        this.u8.set(an);
        for (let k = 0; k < 4; k++) i[at.pad_thumb + k] = th[k];
      }
      setConn(1);
      this.names[port] = g.id;
      const rb = (x ? x[PadX.at.rumble] : i[at.pad_rumble]) >>> 0;
      if (rb !== this.rumble[port] && g.vibrationActuator) {
        this.rumble[port] = rb;
        g.vibrationActuator.playEffect('dual-rumble', { duration: rb ? 1000 : 0,
          strongMagnitude: (rb >>> 16) / 65535, weakMagnitude: (rb & 0xffff) / 65535 }).catch(() => {});
      }
    }
    // The keyboard: the first port with no gamepad. Moving to another port
    // (a gamepad arrived or left) it joins again with its next key press.
    if (kb !== this.kbPort) { this.kbPort = kb; this.kbLive = false; }
    i[at.kb_port] = kb;                            // -1 = no port left
    i[at.kb_live] = kb === 0 || this.kbLive ? 1 : 0;
    if (kb >= 0 && (kb === 0 || this.kbLive)) this.names[kb] = 'keyboard';
    this.padName = this.names[0];
    Atomics.add(i, at.pad_seq, 1);                 // even: done
  }

  /** Each player's pad, for the status line: "P1 Xbox 360 Controller, P2 keyboard". */
  status() {
    const short = (s) => s === 'keyboard' ? s : s.replace(/\s*\(.*$/, '').slice(0, 28) || 'gamepad';
    const parts = this.names.map((n, p) => n && `P${p + 1} ${short(n)}`).filter(Boolean);
    return parts.length ? parts.join(', ') : 'none';
  }
}
