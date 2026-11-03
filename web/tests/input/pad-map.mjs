// Unit check of web/host/input.js's Gamepad API -> Xbox pad mapping, with no
// browser and no hardware: a fake standard-mapping gamepad is polled into a
// host block, and the pad_* fields are compared with the Xbox layout
// (XINPUT_GAMEPAD: wButtons, bAnalogButtons[A B X Y Black White LT RT],
// thumbs with +Y up).
//
//   node web/tests/input/pad-map.mjs
import { Input } from '../../host/input.js';
import { Host } from '../../host/abi.js';

let pad = null;
globalThis.addEventListener = () => {};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [null, pad] } });

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

console.log(fail ? `${fail} FAILED` : 'PASS');
process.exit(fail ? 1 : 0);
