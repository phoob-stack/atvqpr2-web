// Unit check of web/host/input.js's Gamepad API -> Xbox pad mapping, with no
// browser and no hardware: a fake standard-mapping gamepad is polled into a
// host block, and the pad_* fields are compared with the Xbox layout
// (XINPUT_GAMEPAD: wButtons, bAnalogButtons[A B X Y Black White LT RT],
// thumbs with +Y up). Gamepads map by index: getGamepads()[n] is Xbox port
// n + 1 (pad_* for port 1, pad_x[n - 1] for ports 2-4); the keyboard drives
// the first port with no gamepad.
//
//   node web/tests/input/pad-map.mjs
import { Input } from '../../host/input.js';
import { Host, HOST_PADX_OFFSET, PadX } from '../../host/abi.js';

let pad = null, pads = null;
globalThis.addEventListener = () => {};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => pads ?? [pad, null, null, null] } });

const memory = { buffer: new SharedArrayBuffer(4096) };
const input = new Input(memory, 64);
const i32 = new Int32Array(memory.buffer, 64, Host.words);
const at = Host.at;
const analog = () => [...new Uint8Array(memory.buffer, 64 + at.pad_analog * 4, 8)];

function makePad(pressed = {}, values = {}, axes = [0, 0, 0, 0]) {
  const buttons = Array.from({ length: 17 }, (_, k) => {
    const value = values[k] ?? (pressed[k] ? 1 : 0);
    return { pressed: !!pressed[k] || value > 0.5, value };
  });
  return { id: 'fake standard pad', connected: true, mapping: 'standard', buttons, axes };
}

let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
}

// Nothing connected.
pad = null; input.pollGamepad();
eq('no pad: connected', i32[at.pad_connected], 0);
eq('no pad: seq even', i32[at.pad_seq] % 2, 0);

// Face buttons, shoulders, triggers: standard indices 0-7 -> A B X Y, White (LB), Black (RB), LT, RT.
pad = makePad({ 0: 1, 3: 1, 5: 1 }, { 6: 0.5, 7: 1 }); input.pollGamepad();
eq('connected', i32[at.pad_connected], 1);
eq('A, Y, RB=Black, LT half, RT full', analog(), [255, 0, 0, 255, 255, 0, 128, 255]);
eq('no digital buttons', i32[at.pad_buttons], 0);

// D-pad 12-15 -> up/down/left/right bits 0x1/0x2/0x4/0x8; 9 START 0x10, 8 BACK 0x20, 10/11 thumbs 0x40/0x80.
pad = makePad({ 12: 1, 15: 1, 9: 1 }); input.pollGamepad();
eq('up+right+START', i32[at.pad_buttons], 0x1 | 0x8 | 0x10);
pad = makePad({ 13: 1, 14: 1, 8: 1, 10: 1, 11: 1 }); input.pollGamepad();
eq('down+left+BACK+LS+RS', i32[at.pad_buttons], 0x2 | 0x4 | 0x20 | 0x40 | 0x80);

// Sticks: Gamepad +Y is down, Xbox +Y is up; full scale 32767; 0.12 dead zone.
pad = makePad({}, {}, [1, -1, -0.5, 0.05]); input.pollGamepad();
eq('LX right, LY up, RX half left, RY in dead zone',
   [i32[at.pad_thumb], i32[at.pad_thumb + 1], i32[at.pad_thumb + 2], i32[at.pad_thumb + 3]],
   [32767, 32767, -16383, 0]);
eq('pad name', input.padName, 'fake standard pad');

// Disconnect clears it.
pad = null; input.pollGamepad();
eq('unplugged', i32[at.pad_connected], 0);

// By index: a pad at index 2 is port 3 (pad_x[1]); ports 1 and 2 have none,
// so the keyboard is port 1 (live from the start, as before).
const x32 = (port) => new Int32Array(memory.buffer, 64 + HOST_PADX_OFFSET + (port - 2) * PadX.size, PadX.words);
const x8 = (port) => [...new Uint8Array(memory.buffer, 64 + HOST_PADX_OFFSET + (port - 2) * PadX.size + PadX.at.analog * 4, 8)];
pads = [null, null, makePad({ 0: 1, 9: 1 }, {}, [0, -1, 0, 0]), null]; input.pollGamepad();
eq('index 2 -> port 3 connected', x32(3)[PadX.at.connected], 1);
eq('port 3 START', x32(3)[PadX.at.buttons], 0x10);
eq('port 3 A', x8(3)[0], 255);
eq('port 3 LY up', x32(3)[PadX.at.thumb + 1], 32767);
eq('port 1 not connected', i32[at.pad_connected], 0);
eq('port 2 not connected', x32(2)[PadX.at.connected], 0);
eq('keyboard on port 1, live', [i32[at.kb_port], i32[at.kb_live]], [0, 1]);
eq('status', input.status(), 'P1 keyboard, P3 fake standard pad');

// Pads at 0 and 1: the keyboard moves to port 3 and joins on a key press.
pads = [makePad({ 1: 1 }), makePad({ 2: 1 }), null, null]; input.pollGamepad();
eq('port 1 B', analog()[1], 255);
eq('port 2 X', x8(2)[2], 255);
eq('keyboard on port 3, not yet live', [i32[at.kb_port], i32[at.kb_live]], [2, 0]);
input.key(0x0d, 1); input.pollGamepad(); input.key(0x0d, 0);
eq('keyboard on port 3, live after a key', [i32[at.kb_port], i32[at.kb_live]], [2, 1]);
eq('status, 3 players', input.status(), 'P1 fake standard pad, P2 fake standard pad, P3 keyboard');

// Four pads: no port left for the keyboard.
pads = [makePad(), makePad(), makePad(), makePad({ 7: 1 })]; input.pollGamepad();
eq('port 4 RT', x8(4)[7], 255);
eq('keyboard: no port', i32[at.kb_port], -1);
eq('seq even', i32[at.pad_seq] % 2, 0);

console.log(fail ? `${fail} FAILED` : 'PASS');
process.exit(fail ? 1 : 0);
