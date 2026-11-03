/*
 * The browser build's host block: everything the page and the wasm module
 * share, in one struct in wasm memory (shared WebAssembly.Memory, so the page
 * reads and writes it directly; no import call per frame, key or sample).
 *
 * web/host/abi.js mirrors this layout (offsets computed from the same field
 * list) and refuses a block whose magic/version/size differ. Change both
 * together; WASM-HOST.md describes the protocol.
 *
 * Only 4-byte fields up to `keys`, so the page can use one Int32Array view
 * for the atomics and plain loads.
 */
#ifndef ATV2_WEB_HOST_H
#define ATV2_WEB_HOST_H

#include <stdint.h>

#define WEB_HOST_MAGIC   0x57565441u     /* "ATVW" */
#define WEB_HOST_VERSION 1u

/* boot_stage: how far web_main got (the page shows it, a test reads it) */
enum {
    WEB_STAGE_START = 1, WEB_STAGE_XBE, WEB_STAGE_MEMORY, WEB_STAGE_APU,
    WEB_STAGE_OHCI, WEB_STAGE_KERNEL, WEB_STAGE_PATHS, WEB_STAGE_BRIDGE,
    WEB_STAGE_DISPATCH, WEB_STAGE_GPU, WEB_STAGE_ENTRY, WEB_STAGE_RETURNED,
    WEB_STAGE_FAILED = 0x100           /* | the stage that failed */
};

typedef struct WebHost {
    uint32_t magic, version, size;
    volatile uint32_t boot_stage;

    /* ---- present (game -> page) ------------------------------------------
     * gp_seq: bumped by the flip after gp_* describe this frame's GpFrame
     *   (gpu_proto.h; pointers are wasm addresses). The page waits on it
     *   with Atomics.waitAsync, copies the frame's arenas out of wasm memory,
     *   then stores gp_claimed = gp_seq and notifies it. The flip waits for
     *   the claim (not for the GPU) because the recorder reuses its arenas as
     *   soon as the flip returns -- nfsu2-web's claim-not-completion rule.
     *   It waits only while page_attached is set, and at most
     *   WEB_CLAIM_TIMEOUT_MS (then counts gp_dropped and goes on).
     * disp_seq: bumped after disp_* name the guest framebuffer the title
     *   shows (VA, pitch, AA rows). The page shows the render target the
     *   recorder created for that VA; with no GPU frames (CPU rasteriser,
     *   RECOMP_GPU=0) the flip converts the guest framebuffer into cpu_fb
     *   (BGRX8, disp_w x disp_h) first and sets disp_cpu. */
    volatile uint32_t page_attached;
    volatile uint32_t gp_seq, gp_claimed, gp_dropped;
    uint32_t gp_frame;                 /* GpFrame * */
    volatile uint32_t disp_seq;
    uint32_t disp_va, disp_pitch, disp_aa, disp_w, disp_h, disp_cpu;
    uint32_t cpu_fb;                   /* uint32_t[disp_w * disp_h] */
    uint32_t flips, last_draws;
    uint32_t mem_offset;               /* wasm address of guest VA 0 */

    /* ---- input (page -> game) --------------------------------------------
     * keys[vk] = 1 while held, Windows VK codes (keyboard.c's key table and
     * map: Enter=START, Z=A, X=B, arrows = d-pad). Byte stores, no lock.
     * pad_*: a Gamepad API pad already mapped to the Xbox layout, under a
     * seqlock: the page makes pad_seq odd, writes, makes it even. */
    volatile uint32_t pad_seq, pad_connected;
    uint32_t pad_buttons;              /* XBOX_GAMEPAD.wButtons */
    uint32_t pad_analog[2];            /* bAnalogButtons[8], bytes */
    int32_t  pad_thumb[4];             /* LX LY RX RY, -32768..32767 */

    /* ---- audio (game -> AudioWorklet) ------------------------------------
     * audio_ring: WebAudioRing * (web_audio.c), 0 until xa2_init. */
    volatile uint32_t audio_ring;

    uint32_t reserved[8];
    volatile uint8_t keys[256];
} WebHost;

/* Float32 stereo SPSC ring the AudioWorklet drains (nfsu2-web's shape).
 * write/read are frame counters that only grow (mod 2^32); the data index is
 * counter % cap. The worklet bumps `heartbeat` on every render quantum; when
 * it stops (no AudioContext yet: autoplay needs a gesture; a hidden tab),
 * the game side advances `read` by wall clock itself so the DirectSound play
 * cursor keeps moving. */
typedef struct WebAudioRing {
    uint32_t magic;                    /* "ATVA" */
    uint32_t rate, channels, cap;      /* 48000, 2, frames */
    volatile uint32_t write, read;
    volatile uint32_t heartbeat;       /* worklet: ++ per 128-frame quantum */
    volatile uint32_t underruns;       /* worklet: quanta short of data */
    /* float data[cap * channels] follows (16-byte aligned) */
} WebAudioRing;

#define WEB_AUDIO_MAGIC 0x41565441u    /* "ATVA" */

#define WEB_CLAIM_TIMEOUT_MS 1000

/* web/host/abi.js computes the same offsets from the same field order. */
_Static_assert(__builtin_offsetof(WebHost, keys) == 38 * 4, "WebHost layout");
_Static_assert(sizeof(WebHost) == 38 * 4 + 256, "WebHost layout");
_Static_assert(sizeof(WebAudioRing) == 32, "WebAudioRing layout");

WebHost *web_host(void);

#endif
