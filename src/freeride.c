/*
 * freeride.c -- "Free Ride": RECOMP_FREERIDE=1 boots straight into Freestyle,
 * Unlimited Time, on Stadium: Main Event (FREERIDE.md in work\freeroam).
 *
 * The game already has the mode: FREESTYLE on the main menu, then the time
 * picker's "UNLIMITED TIME" entry (index 4: time limit 999999 s, no clock on
 * the HUD). Free Ride only walks the frontend to it, with the game's own logic
 * doing every step (profile load, settings, track, loading):
 *
 *   - a driver ticked at every flip (gpu_rec.c rec_flip) reads the game's
 *     state machine (root at [0x1D8608]) and presses the pad for each screen:
 *     START on the title, A on SAVED PROFILES (the highlighted -- last used --
 *     profile; with none, A creates one: rider, default name "PLAYER ONE", OK),
 *     A on the main menu, A on the time picker, rider, ATV and track preview;
 *   - before the time picker opens it writes its cursor (0x1D86B0) to 4, so A
 *     picks UNLIMITED TIME;
 *   - one hook (recomp_lookup_manual -> atv2_freeride_lookup): the main menu's
 *     event handler (0x000B62C0) sees any row's A as ID_MAINMENU_OPEN_FS
 *     (FREESTYLE), so the menu cursor's position does not matter.
 * When the race clock (0x1DA05C) starts, the driver stops for good and the
 * hook with it: the pause menu, RESTART, QUIT and the menus behave as usual.
 *
 * Off unless RECOMP_FREERIDE=1; off, nothing here runs but one flag test per
 * flip and per indirect call. Addresses are default.xbe SHA-256 1E3C2FCE...
 * (ATV Quad Power Racing 2, USA); a check of the strings and vtables used
 * turns it off on anything else.
 */
#if defined(_WIN32)
#include <windows.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#include "recomp/gen/recomp_types.h"
#include "usb_gamepad.h"

void sub_000B62C0(void);

/* ---- this exe's addresses ------------------------------------------------ */

#define FR_ROOT_SM_PTR      0x001D8608u  /* game state machine (root)              */
#define FR_SETTINGS         0x001D8620u  /* race settings ("mTrackType" etc.)       */
#define FR_TRACK            (FR_SETTINGS + 0x34)  /* 15 = Stadium1 (Main Event)     */
#define FR_TIMELIMIT        (FR_SETTINGS + 0x40)  /* f32 s; 999999 = unlimited      */
#define FR_FSMODE           (FR_SETTINGS + 0x4C)  /* freestyle time: 0..3, 4 = inf  */
#define FR_GAMEMODE         (FR_SETTINGS + 0x5C)  /* 4 = freestyle                  */
#define FR_FS_CURSOR        0x001D86B0u  /* time picker's remembered cursor         */
#define FR_RACE_TIME        0x001DA05Cu  /* f32 s, runs from the race start         */
#define FR_UNLIMITED        0x497423F0u  /* 999999.0f                               */

/* State classes (vtables). Root's current state is at +0x10; a mode state
 * (freestyle) sits at +0x18 with its own sub-state at +0x10. */
#define VT_TITLE            0x001B6B40u  /* PRESS START                             */
#define VT_PROFILES         0x001C00ACu  /* SAVED PROFILES                          */
#define VT_NEW_RIDER        0x001C0848u  /* CHOOSE A RIDER (new profile)            */
#define VT_NEW_NAME         0x001C08B4u  /* NAME YOUR RIDER (cursor starts on OK)   */
#define VT_MAIN_MENU        0x001C0230u
#define VT_FREESTYLE        0x001C04CCu  /* open freestyle mode (holds sub-states)  */
#define VT_FS_TIME          0x001C038Cu  /* FREESTYLE time picker                   */
#define VT_FS_RIDER         0x001C0420u  /* RIDER SELECT                            */
#define VT_FS_ATV           0x001C0444u  /* ATV SELECT                              */
#define VT_FS_RACE          0x001C0468u  /* track preview, loading, the event       */

#define FN_MAIN_MENU_EVENT  0x000B62C0u  /* main menu state's OnEvent(event*)        */
#define STR_OPEN_FS         0x001B5388u  /* "ID_MAINMENU_OPEN_FS"                    */

/* ---- state ---------------------------------------------------------------- */

static int      s_on;             /* RECOMP_FREERIDE=1 and the exe checked      */
static int      s_checked;
static volatile int s_active;     /* driving the menus                         */
/* Read by recomp_lookup_manual on every indirect call: 1 while the hook is
 * live (driving, exe checked). */
volatile int    atv2_freeride_hook;
static uint32_t s_t0;             /* init, ms                                  */
static uint32_t s_screen, s_since, s_last_press;
static int      s_presses;

static uint32_t fr_ms(void)
{
#if defined(_WIN32)
    return (uint32_t)GetTickCount();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)ts.tv_sec * 1000u + (uint32_t)(ts.tv_nsec / 1000000);
#endif
}

#define RAM_OK(va) ((va) >= 0x10000u && (va) < 0x04000000u)

static uint32_t rd32(uint32_t va)
{
    uint32_t v;
    if (!RAM_OK(va) || !RAM_OK(va + 3))
        return 0;
    memcpy(&v, (const void *)XBOX_PTR(va), 4);
    return v;
}

static void wr32(uint32_t va, uint32_t v)
{
    if (RAM_OK(va))
        memcpy((void *)XBOX_PTR(va), &v, 4);
}

static int str_at(uint32_t va, const char *s)
{
    size_t n = strlen(s) + 1;
    return RAM_OK(va) && RAM_OK(va + (uint32_t)n) &&
           memcmp((const void *)XBOX_PTR(va), s, n) == 0;
}

static float f32_at(uint32_t va)
{
    uint32_t u = rd32(va);
    float f;
    memcpy(&f, &u, 4);
    return f;
}

/* ---- on/off ---------------------------------------------------------------- */

void atv2_freeride_init(void)
{
    const char *e = getenv("RECOMP_FREERIDE");
    if (!e || !*e || *e == '0')
        return;
    s_on = 1;
    s_active = 1;
    s_t0 = fr_ms();
    /* The intro movies come before the title; Free Ride skips them unless
     * RECOMP_SKIP_MOVIES says otherwise (read at the first file open). */
    if (!getenv("RECOMP_SKIP_MOVIES")) {
#if defined(_WIN32)
        _putenv("RECOMP_SKIP_MOVIES=1");
#else
        setenv("RECOMP_SKIP_MOVIES", "1", 0);
#endif
    }
    fprintf(stderr, "[FREERIDE] on: Freestyle, Unlimited Time, Stadium: Main Event\n");
    fflush(stderr);
}

static void fr_stop(const char *why)
{
    s_active = 0;
    atv2_freeride_hook = 0;
    fprintf(stderr, "[FREERIDE] %s at %.1f s after start (%d presses)\n", why,
            (fr_ms() - s_t0) / 1000.0, s_presses);
    fflush(stderr);
}

/* The strings and vtables Free Ride relies on, read from the loaded XBE. */
static int fr_exe_ok(void)
{
    return str_at(STR_OPEN_FS, "ID_MAINMENU_OPEN_FS") &&
           rd32(VT_MAIN_MENU + 0x20) == FN_MAIN_MENU_EVENT &&
           rd32(VT_FS_TIME + 0x20) == 0x000B76C0u &&
           rd32(VT_TITLE + 0x20) == 0x000B5E90u &&
           rd32(VT_PROFILES + 0x20) == 0x000BAEF0u;
}

/* ---- the main menu hook (guest thread) --------------------------------------
 *
 * thiscall OnEvent(event*): [esp+4] = event {char *name; int type}. Type 0 is a
 * row's A (ID_MAINMENU_*). While Free Ride drives, the event goes in as
 * ID_MAINMENU_OPEN_FS whatever row the cursor is on, and is put back after. */
static void fr_main_menu_event(void)
{
    uint32_t ev = rd32(g_esp + 4), name = 0;
    int swap = 0;
    if (s_active && ev) {
        name = rd32(ev);
        swap = rd32(ev + 4) == 0 && name != STR_OPEN_FS && RAM_OK(name) &&
               memcmp((const void *)XBOX_PTR(name), "ID_MAINMENU_", 12) == 0;
    }
    if (swap) {
        fprintf(stderr, "[FREERIDE] main menu: %.40s -> ID_MAINMENU_OPEN_FS\n",
                (const char *)XBOX_PTR(name));
        wr32(ev, STR_OPEN_FS);
    }
    sub_000B62C0();
    if (swap)
        wr32(ev, name);
}

typedef void (*fr_func_t)(void);

fr_func_t atv2_freeride_lookup(uint32_t va)
{
    if (va == FN_MAIN_MENU_EVENT && s_active)
        return fr_main_menu_event;
    return 0;
}

/* ---- the driver (every flip) ------------------------------------------------ */

static void press(const char *spec)
{
    UsbPadInput in;
    usb_gamepad_parse_input(spec, &in);
    usb_gamepad_queue(0, &in, 120, 180, 0);
    s_last_press = fr_ms();
    s_presses++;
}

/* Which screen: the vtable of the innermost current state. */
static uint32_t fr_screen(void)
{
    uint32_t root = rd32(FR_ROOT_SM_PTR), mode, sub;
    if (!root)
        return 0;
    mode = rd32(root + 0x18);
    if (mode && rd32(mode) == VT_FREESTYLE) {
        sub = rd32(mode + 0x10);
        return sub && rd32(sub + 4) == mode ? rd32(sub) : VT_FREESTYLE;
    }
    if (mode)
        return rd32(mode);        /* an overlay between screens: wait it out */
    sub = rd32(root + 0x10);
    return sub ? rd32(sub) : 0;
}

static const char *fr_name(uint32_t vt)
{
    switch (vt) {
    case VT_TITLE: return "title";
    case VT_PROFILES: return "saved profiles";
    case VT_NEW_RIDER: return "new profile: rider";
    case VT_NEW_NAME: return "new profile: name";
    case VT_MAIN_MENU: return "main menu";
    case VT_FREESTYLE: return "freestyle";
    case VT_FS_TIME: return "freestyle time";
    case VT_FS_RIDER: return "rider select";
    case VT_FS_ATV: return "atv select";
    case VT_FS_RACE: return "preview/loading";
    default: return "other";
    }
}

void atv2_freeride_frame(void)
{
    uint32_t now, scr, settle;
    const char *btn = NULL;

    if (!s_on || !s_active)
        return;
    if (!s_checked) {
        if (!rd32(FR_ROOT_SM_PTR))
            return;                       /* not booted far enough */
        s_checked = fr_exe_ok() ? 1 : -1;
        if (s_checked < 0) {
            fr_stop("not this game's default.xbe (1E3C2FCE...): off");
            return;
        }
        atv2_freeride_hook = 1;
    }
    now = fr_ms();
    if (now - s_t0 > 180000u) {
        fr_stop("gave up (no race after 180 s)");
        return;
    }
    scr = fr_screen();
    if (scr != s_screen) {
        fprintf(stderr, "[FREERIDE] %.2f s: %s (%06X)\n", (now - s_t0) / 1000.0,
                fr_name(scr), scr);
        fflush(stderr);
        s_screen = scr;
        s_since = now;
    }
    switch (scr) {
    case VT_TITLE:
        btn = "start";
        break;
    case VT_PROFILES:
    case VT_NEW_RIDER:
    case VT_NEW_NAME:
        btn = "a";
        break;
    case VT_MAIN_MENU:
        /* The time picker starts on the cursor it remembers: 4 = UNLIMITED. */
        wr32(FR_FS_CURSOR, 4);
        btn = "a";
        break;
    case VT_FS_TIME:
        wr32(FR_FS_CURSOR, 4);
        btn = "a";
        break;
    case VT_FS_RIDER:
    case VT_FS_ATV:
        /* Belt and braces: the picker sets these (SetFreeStyleMode, 0xA1940). */
        if (rd32(FR_FSMODE) != 4 || rd32(FR_TIMELIMIT) != FR_UNLIMITED) {
            fprintf(stderr, "[FREERIDE] time was mode %u / %g s: set unlimited\n",
                    rd32(FR_FSMODE), f32_at(FR_TIMELIMIT));
            wr32(FR_FSMODE, 4);
            wr32(FR_TIMELIMIT, FR_UNLIMITED);
        }
        btn = "a";
        break;
    case VT_FS_RACE:
        if (f32_at(FR_RACE_TIME) > 0.0f) {
            char msg[160];
            snprintf(msg, sizeof msg, "riding (track %u, time limit %g s, mode %u): done",
                     rd32(FR_TRACK), f32_at(FR_TIMELIMIT), rd32(FR_FSMODE));
            fr_stop(msg);
            return;
        }
        btn = "a";                        /* preview: A CONTINUE */
        break;
    default:
        return;                           /* boot, overlays, loading */
    }
    /* Let a screen settle before the first press, then repeat until it moves on
     * (a press during its fade-in is ignored). */
    settle = scr == VT_TITLE ? 100u : 250u;
    if (now - s_since < settle || usb_gamepad_queue_pending(0) ||
        now - s_last_press < 600u)
        return;
    press(btn);
}
