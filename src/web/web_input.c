/*
 * Pad input for the browser build: xinput_device.c's xbox_InputGetState
 * over what the page writes into the host block (web_host.h).
 *
 *  - A Gamepad API pad, already in the Xbox layout (web/host/input.js maps
 *    the standard mapping: A B X Y, LB/RB as Black/White, triggers, sticks,
 *    d-pad, Start/Back), under a seqlock.
 *  - The keyboard: the page stores held keys as Windows VK codes in
 *    keys[256]; they are copied into keyboard.c's key table
 *    (xbox_InputKeySet) and resolved through its one map (Enter = START,
 *    Z = A, X = B, arrows = d-pad, ...). Merged with the pad, so either works.
 *
 * Port 0 only. The emulated USB host controller (usb_gamepad.c) polls this.
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

/* The page's pad, read consistently. 0 if none connected. */
static int pad_read(const WebHost *h, XBOX_GAMEPAD *g)
{
    int tries;
    for (tries = 0; tries < 64; tries++) {
        uint32_t s0 = __atomic_load_n(&h->pad_seq, __ATOMIC_SEQ_CST), s1;
        uint32_t conn, buttons, analog[2];
        int32_t thumb[4];
        if (s0 & 1)
            continue;
        conn = h->pad_connected;
        buttons = h->pad_buttons;
        memcpy(analog, (const void *)h->pad_analog, sizeof analog);
        memcpy(thumb, (const void *)h->pad_thumb, sizeof thumb);
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
    static DWORD packet;
    const WebHost *h = web_host();
    XBOX_INPUT_STATE kb;
    XBOX_GAMEPAD pad;
    int have_pad, have_kb, i;

    if (dwPort != 0 || !pState)
        return ERROR_DEVICE_NOT_CONNECTED;

    keys_sync(h);
    memset(&pad, 0, sizeof pad);
    have_pad = pad_read(h, &pad);
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
    pState->dwPacketNumber = ++packet;
    return ERROR_SUCCESS;
}

/* Rumble from the emulated pad (ohci.c): the page plays it on the Gamepad's
 * vibrationActuator when it has one. */
DWORD xbox_InputSetState(DWORD dwPort, const XBOX_VIBRATION *pVibration)
{
    if (dwPort != 0 || !pVibration)
        return ERROR_DEVICE_NOT_CONNECTED;
    __atomic_store_n(&web_host()->pad_rumble, (uint32_t)pVibration->wLeftMotorSpeed << 16 |
                     pVibration->wRightMotorSpeed, __ATOMIC_SEQ_CST);
    return ERROR_SUCCESS;
}
