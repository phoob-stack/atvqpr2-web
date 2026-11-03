/*
 * Pad input for the browser build: xinput_device.c's xbox_InputGetState
 * over what the page writes into the host block (web_host.h).
 *
 *  - Gamepad API pads by index: getGamepads()[n] is Xbox port n + 1, already
 *    in the Xbox layout (web/host/input.js maps the standard mapping: A B X
 *    Y, LB/RB as Black/White, triggers, sticks, d-pad, Start/Back), under a
 *    seqlock.
 *  - The keyboard: the page stores held keys as Windows VK codes in
 *    keys[256]; they are copied into keyboard.c's key table
 *    (xbox_InputKeySet) and resolved through its one map (Enter = START,
 *    Z = A, X = B, arrows = d-pad, ...). It drives kb_port, the first port
 *    with no gamepad (port 1 with none: merged with nothing, as before).
 *
 * The emulated USB host controller (usb_gamepad.c) polls ports with a pad
 * plugged in, and plugs one in where xbox_InputPortPresent says (hot-plug).
 */
#include <stdint.h>
#include <string.h>

#include "win32_compat.h"
#include "xinput_xbox.h"
#include "keyboard.h"
#include "web_host.h"

static uint8_t s_keys_seen[256];

static void keys_sync(const WebHost *h)
{
    int vk;
    for (vk = 0; vk < 256; vk++) {
        uint8_t d = h->keys[vk] ? 1 : 0;
        if (d != s_keys_seen[vk]) {
            s_keys_seen[vk] = d;
            xbox_InputKeySet(vk, d);
        }
    }
}

/* The page's pad for `port`, read consistently. 0 if none connected. */
static int pad_read(const WebHost *h, DWORD port, XBOX_GAMEPAD *g)
{
    int tries;
    for (tries = 0; tries < 64; tries++) {
        uint32_t s0 = __atomic_load_n(&h->pad_seq, __ATOMIC_SEQ_CST), s1;
        uint32_t conn, buttons, analog[2];
        int32_t thumb[4];
        if (s0 & 1)
            continue;
        if (port == 0) {
            conn = h->pad_connected;
            buttons = h->pad_buttons;
            memcpy(analog, (const void *)h->pad_analog, sizeof analog);
            memcpy(thumb, (const void *)h->pad_thumb, sizeof thumb);
        } else {
            const volatile uint32_t *x = (const volatile uint32_t *)&h->pad_x[port - 1];
            conn = x[0];
            buttons = x[1];
            analog[0] = x[2]; analog[1] = x[3];
            thumb[0] = (int32_t)x[4]; thumb[1] = (int32_t)x[5];
            thumb[2] = (int32_t)x[6]; thumb[3] = (int32_t)x[7];
        }
        s1 = __atomic_load_n(&h->pad_seq, __ATOMIC_SEQ_CST);
        if (s0 != s1)
            continue;
        if (!conn)
            return 0;
        g->wButtons = (WORD)buttons;
        memcpy(g->bAnalogButtons, analog, 8);
        g->sThumbLX = (SHORT)thumb[0];
        g->sThumbLY = (SHORT)thumb[1];
        g->sThumbRX = (SHORT)thumb[2];
        g->sThumbRY = (SHORT)thumb[3];
        return 1;
    }
    return 0;
}

static SHORT pick(SHORT a, SHORT b) { return (a < 0 ? -a : a) >= (b < 0 ? -b : b) ? a : b; }

DWORD xbox_InputGetState(DWORD dwPort, XBOX_INPUT_STATE *pState)
{
    static DWORD packet[4];
    const WebHost *h = web_host();
    XBOX_INPUT_STATE kb;
    XBOX_GAMEPAD pad;
    int have_pad, have_kb = 0, i;

    if (dwPort > 3 || !pState)
        return ERROR_DEVICE_NOT_CONNECTED;

    keys_sync(h);
    memset(&pad, 0, sizeof pad);
    have_pad = pad_read(h, dwPort, &pad);
    if (h->kb_port == dwPort)
        have_kb = xbox_InputKeyboardPoll(&kb);
    if (!have_pad && !have_kb)
        return ERROR_DEVICE_NOT_CONNECTED;

    memset(pState, 0, sizeof *pState);
    pState->Gamepad = pad;
    if (have_kb) {
        XBOX_GAMEPAD *g = &pState->Gamepad;
        g->wButtons |= kb.Gamepad.wButtons;
        for (i = 0; i < 8; i++)
            if (kb.Gamepad.bAnalogButtons[i] > g->bAnalogButtons[i])
                g->bAnalogButtons[i] = kb.Gamepad.bAnalogButtons[i];
        g->sThumbLX = pick(g->sThumbLX, kb.Gamepad.sThumbLX);
        g->sThumbLY = pick(g->sThumbLY, kb.Gamepad.sThumbLY);
        g->sThumbRX = pick(g->sThumbRX, kb.Gamepad.sThumbRX);
        g->sThumbRY = pick(g->sThumbRY, kb.Gamepad.sThumbRY);
    }
    /* The title looks for edges: move the packet number on every poll. */
    pState->dwPacketNumber = ++packet[dwPort];
    return ERROR_SUCCESS;
}

/* Hot-plug (usb_gamepad_wanted): a gamepad at this index, or the keyboard
 * once it has joined this port. */
int xbox_InputPortPresent(DWORD dwPort)
{
    const WebHost *h = web_host();
    XBOX_GAMEPAD g;
    int r = 0;
    if (dwPort > 3)
        return 0;
    if (pad_read(h, dwPort, &g))
        r |= 1;
    if (h->kb_port == dwPort && (dwPort == 0 || h->kb_live))
        r |= 2;
    return r;
}

/* Rumble from the emulated pad (ohci.c): the page plays it on the Gamepad's
 * vibrationActuator when it has one. */
DWORD xbox_InputSetState(DWORD dwPort, const XBOX_VIBRATION *pVibration)
{
    WebHost *h = web_host();
    uint32_t v;
    if (dwPort > 3 || !pVibration)
        return ERROR_DEVICE_NOT_CONNECTED;
    v = (uint32_t)pVibration->wLeftMotorSpeed << 16 | pVibration->wRightMotorSpeed;
    __atomic_store_n(dwPort ? &h->pad_x[dwPort - 1].rumble : &h->pad_rumble, v, __ATOMIC_SEQ_CST);
    return ERROR_SUCCESS;
}
