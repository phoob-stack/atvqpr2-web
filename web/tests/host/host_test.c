/*
 * Input and audio back ends of the browser build, without the game:
 *  - xbox_InputGetState (web_input.c) over the page's keys, through
 *    keyboard.c's map: prints every change of the pad state for ~6 s
 *    (web/tools/boot.mjs --keys presses Enter and Z);
 *  - xa2_* (web_audio.c): submits a 440 Hz tone at the APU's pace and
 *    reports how the ring drains -- by the AudioWorklet (heartbeat moving,
 *    boot.mjs --audio) or by the wall-clock fallback.
 *   web/tests/host/host-test.sh
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "win32_compat.h"
#include "xinput_xbox.h"
#include "apu_xaudio2.h"
#include "web_host.h"

static WebHost s_host = { .magic = WEB_HOST_MAGIC, .version = WEB_HOST_VERSION, .size = sizeof(WebHost) };
WebHost *web_host(void) { return &s_host; }

__attribute__((import_module("env"), import_name("web_host_ready")))
void web_host_ready(WebHost *h);

static uint64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}

int main(void)
{
    int16_t period[256 * 2];
    XBOX_INPUT_STATE st, last;
    uint64_t t0, t;
    uint32_t phase = 0, submitted = 0, hb0;
    int i, polls = 0, changes = 0;

    setvbuf(stdout, NULL, _IOLBF, 0);
    web_host_ready(&s_host);
    if (!xa2_init()) { printf("host_test: xa2_init failed\n"); return 1; }
    memset(&last, 0, sizeof last);
    t0 = now_ms();
    hb0 = ((WebAudioRing *)(uintptr_t)s_host.audio_ring)->heartbeat;
    while ((t = now_ms()) - t0 < 6000) {
        /* the APU's pacing: one 256-frame period while queued < high mark */
        while (xa2_queued_samples() < 2048) {
            for (i = 0; i < 256; i++, phase++) {
                int16_t v = (int16_t)(3000 * sinf(phase * 2.0f * 3.14159265f * 440.0f / 48000.0f));
                period[i * 2] = period[i * 2 + 1] = v;
            }
            xa2_submit_samples(period, 256);
            submitted += 256;
        }
        if (xbox_InputGetState(0, &st) == 0) {
            polls++;
            if (st.Gamepad.wButtons != last.Gamepad.wButtons ||
                memcmp(st.Gamepad.bAnalogButtons, last.Gamepad.bAnalogButtons, 8)) {
                changes++;
                printf("host_test: t=%4u ms pad wButtons=0x%04X A=%u B=%u\n", (unsigned)(t - t0),
                       st.Gamepad.wButtons, st.Gamepad.bAnalogButtons[0], st.Gamepad.bAnalogButtons[1]);
                last = st;
            }
        }
        { struct timespec ts = { 0, 4000000 }; nanosleep(&ts, NULL); }
    }
    {
        WebAudioRing *r = (WebAudioRing *)(uintptr_t)s_host.audio_ring;
        double secs = (now_ms() - t0) / 1000.0;
        printf("host_test: audio %u frames submitted in %.1f s (%.0f/s), played %llu, worklet heartbeat +%u, "
               "worklet underruns %u, ring underruns %u\n", submitted, secs, submitted / secs,
               (unsigned long long)xa2_samples_played(), r->heartbeat - hb0, r->underruns, xa2_underruns());
        printf("host_test: input %d polls, %d changes\n", polls, changes);
    }
    return 0;
}
