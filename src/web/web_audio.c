/*
 * Audio output for the browser build: apu_xaudio2.h's xa2_* contract over a
 * float32 stereo SPSC ring in wasm memory that the page's AudioWorklet
 * (web/host/audio-worklet.js) drains -- nfsu2-web's shape.
 *
 * The APU frame thread hands one EP period (256 stereo frames, s16) at a
 * time to xa2_submit_samples and paces itself on xa2_queued_samples, as with
 * SDL's queue. The worklet counts every render quantum in ring->heartbeat.
 * Before the page has an AudioContext (autoplay wants a user gesture), in a
 * hidden tab, or with no page at all, the heartbeat stops; then this side
 * consumes the ring by wall clock, so the queue still drains at 48 kHz and
 * the DirectSound play cursor keeps moving (nfsu2-web's fallback).
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "apu_xaudio2.h"
#include "web_host.h"

#define RATE        48000
#define CAP_FRAMES  16384               /* 341 ms */
#define BUF_SAMPLES 512
#define NUM_BUFS    4
#define STALL_MS    60                  /* heartbeat silent this long: fallback */

static WebAudioRing *s_ring;
static float        *s_data;
static int           s_init;
static unsigned      s_underruns;
static int           s_dry, s_written;
static uint64_t      s_played;          /* frames consumed, 64-bit */
static uint32_t      s_read_seen;
static uint32_t      s_hb_seen;
static uint64_t      s_hb_ms, s_wall_ms;
static int           s_fallback;

static uint64_t now_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000u + (uint64_t)ts.tv_nsec / 1000u;
}

int xa2_init(void)
{
    size_t bytes = sizeof(WebAudioRing) + 16 + (size_t)CAP_FRAMES * 2 * sizeof(float);
    uint8_t *p;

    if (s_init)
        return 1;
    p = (uint8_t *)aligned_alloc(16, (bytes + 15) & ~(size_t)15);
    if (!p)
        return 0;
    memset(p, 0, bytes);
    s_ring = (WebAudioRing *)p;
    s_data = (float *)(p + ((sizeof(WebAudioRing) + 15) & ~(size_t)15));
    s_ring->rate = RATE;
    s_ring->channels = 2;
    s_ring->cap = CAP_FRAMES;
    s_ring->magic = WEB_AUDIO_MAGIC;
    s_hb_ms = s_wall_ms = now_us() / 1000;
    s_init = 1;
    __atomic_store_n(&web_host()->audio_ring, (uint32_t)(uintptr_t)s_ring, __ATOMIC_SEQ_CST);
    fprintf(stderr, "[WEBAUDIO] ring of %u frames at 0x%08X (%d Hz stereo float),"
            " %d x %d-sample pacing buffers\n", CAP_FRAMES,
            (unsigned)(uintptr_t)s_ring, RATE, NUM_BUFS, BUF_SAMPLES);
    return 1;
}

void xa2_shutdown(void)
{
    if (s_init)
        fprintf(stderr, "[WEBAUDIO] shut down (%d periods written, %u underruns)\n",
                s_written, s_underruns);
    s_init = 0;           /* the ring stays: the worklet may still hold it */
}

int xa2_is_active(void) { return s_init; }

/* Account for what the worklet (or the wall clock) consumed since the last
 * look, and stand in for a stalled worklet. */
static void pump(void)
{
    uint64_t ms = now_us() / 1000;
    uint32_t hb = __atomic_load_n(&s_ring->heartbeat, __ATOMIC_SEQ_CST);
    uint32_t r, w;

    if (hb != s_hb_seen) {
        s_hb_seen = hb;
        s_hb_ms = ms;
        if (s_fallback)
            fprintf(stderr, "[WEBAUDIO] worklet running; wall-clock drain off\n");
        s_fallback = 0;
    } else if (!s_fallback && ms - s_hb_ms >= STALL_MS) {
        s_fallback = 1;
        s_wall_ms = ms;
        fprintf(stderr, "[WEBAUDIO] no worklet heartbeat for %u ms; draining by "
                "wall clock\n", (unsigned)(ms - s_hb_ms));
    }
    if (s_fallback && ms > s_wall_ms) {
        uint32_t due = (uint32_t)((ms - s_wall_ms) * RATE / 1000);
        s_wall_ms = ms;
        r = __atomic_load_n(&s_ring->read, __ATOMIC_SEQ_CST);
        for (;;) {
            uint32_t q;
            w = __atomic_load_n(&s_ring->write, __ATOMIC_SEQ_CST);
            q = w - r;
            if (__atomic_compare_exchange_n(&s_ring->read, &r, r + (due < q ? due : q),
                                            0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST))
                break;
        }
    }
    r = __atomic_load_n(&s_ring->read, __ATOMIC_SEQ_CST);
    s_played += (uint32_t)(r - s_read_seen);
    s_read_seen = r;
}

int xa2_submit_samples(const int16_t *samples, int num_samples)
{
    uint32_t w, r, room, i, at;

    if (!s_init || num_samples <= 0)
        return 0;
    pump();
    w = s_ring->write;
    r = __atomic_load_n(&s_ring->read, __ATOMIC_SEQ_CST);
    room = CAP_FRAMES - (w - r);
    if ((uint32_t)num_samples > room)
        num_samples = (int)room;            /* paced: does not happen */
    for (i = 0; i < (uint32_t)num_samples; i++) {
        at = ((w + i) % CAP_FRAMES) * 2;
        s_data[at] = samples[i * 2] * (1.0f / 32768.0f);
        s_data[at + 1] = samples[i * 2 + 1] * (1.0f / 32768.0f);
    }
    __atomic_store_n(&s_ring->write, w + (uint32_t)num_samples, __ATOMIC_SEQ_CST);
    s_written++;
    return 1;
}

int xa2_get_buffer_size(void) { return BUF_SAMPLES; }
int xa2_get_buffer_count(void) { return NUM_BUFS; }

int xa2_queued_samples(void)
{
    uint32_t q;
    if (!s_init)
        return 0;
    pump();
    q = __atomic_load_n(&s_ring->write, __ATOMIC_SEQ_CST) - s_read_seen;
    if (q == 0 && s_written > 0) {
        if (!s_dry) {
            s_dry = 1;
            s_underruns++;
        }
    } else {
        s_dry = 0;
    }
    return (int)q;
}

void xa2_expect_drain(void) { s_dry = 1; }

unsigned xa2_underruns(void) { return s_underruns; }

uint64_t xa2_samples_played(void)
{
    if (!s_init)
        return 0;
    pump();
    return s_played;
}
