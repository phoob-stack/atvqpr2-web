// The control model of the local build (its site/keymap.js): the same action
// ids, default keys and gamepad buttons, so a config made here means the same
// thing there. Labels are ours.
//
// Keyboard: each action is one Xbox control; key_<action> holds the
// KeyboardEvent.code values that press it (space-separated).
// Gamepad: pad_<control> is the standard-mapping button number that drives
// that Xbox control (0-16), or none.

export const ACTIONS = [
  { id: 'a', label: 'A (accelerate / select)', keys: ['KeyZ'] },
  { id: 'b', label: 'B (brake / back)', keys: ['KeyX'] },
  { id: 'x', label: 'X', keys: ['KeyC'] },
  { id: 'y', label: 'Y', keys: ['KeyV'] },
  { id: 'white', label: 'White', keys: ['KeyQ'] },
  { id: 'black', label: 'Black', keys: ['KeyE'] },
  { id: 'lt', label: 'Left trigger', keys: ['Digit1'] },
  { id: 'rt', label: 'Right trigger', keys: ['Digit3'] },
  { id: 'start', label: 'Start', keys: ['Enter', 'NumpadEnter'] },
  { id: 'back', label: 'Back', keys: ['Backspace'] },
  { id: 'dup', label: 'D-pad up', keys: ['ArrowUp'] },
  { id: 'ddown', label: 'D-pad down', keys: ['ArrowDown'] },
  { id: 'dleft', label: 'D-pad left', keys: ['ArrowLeft'] },
  { id: 'dright', label: 'D-pad right', keys: ['ArrowRight'] },
  { id: 'ls_up', label: 'Left stick up', keys: ['KeyW', 'Numpad8'] },
  { id: 'ls_down', label: 'Left stick down', keys: ['KeyS', 'Numpad2'] },
  { id: 'ls_left', label: 'Left stick left (steer)', keys: ['KeyA', 'Numpad4'] },
  { id: 'ls_right', label: 'Left stick right (steer)', keys: ['KeyD', 'Numpad6'] },
  { id: 'rs_up', label: 'Right stick up', keys: ['KeyI'] },
  { id: 'rs_down', label: 'Right stick down', keys: ['KeyK'] },
  { id: 'rs_left', label: 'Right stick left', keys: ['KeyJ'] },
  { id: 'rs_right', label: 'Right stick right', keys: ['KeyL'] },
  { id: 'lthumb', label: 'Left stick click', keys: ['ShiftLeft', 'ShiftRight'] },
  { id: 'rthumb', label: 'Right stick click', keys: ['ControlLeft', 'ControlRight'] },
];

export const PAD_CONTROLS = [
  { id: 'a', label: 'A', button: 0 }, { id: 'b', label: 'B', button: 1 },
  { id: 'x', label: 'X', button: 2 }, { id: 'y', label: 'Y', button: 3 },
  { id: 'white', label: 'White', button: 4 }, { id: 'black', label: 'Black', button: 5 },
  { id: 'lt', label: 'Left trigger', button: 6 }, { id: 'rt', label: 'Right trigger', button: 7 },
  { id: 'back', label: 'Back', button: 8 }, { id: 'start', label: 'Start', button: 9 },
  { id: 'lthumb', label: 'Left stick click', button: 10 }, { id: 'rthumb', label: 'Right stick click', button: 11 },
  { id: 'dup', label: 'D-pad up', button: 12 }, { id: 'ddown', label: 'D-pad down', button: 13 },
  { id: 'dleft', label: 'D-pad left', button: 14 }, { id: 'dright', label: 'D-pad right', button: 15 },
];
export const PAD_BUTTONS = 17;
export const PAD_BUTTON_NAMES = ['bottom face', 'right face', 'left face', 'top face', 'left bumper',
  'right bumper', 'left trigger', 'right trigger', 'back / view', 'start / menu', 'left stick press', 'right stick press',
  'd-pad up', 'd-pad down', 'd-pad left', 'd-pad right', 'guide / home'];
