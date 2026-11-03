/*
 * The browser build's present path: hands each flip to the page.
 *
 *  - gp_web_consume(f): the recorder's frame (gpu_proto.h) at the flip. The
 *    GpFrame is copied into the host block's mailbox and gp_seq is bumped;
 *    the page claims it (copies the arenas out) and draws it with
 *    web/gpu/encoder.js. nfsu2-web's claim-not-completion hand-off: one
 *    mailbox, the recorder's arenas double-buffered, so the flip waits only
 *    for the previous frame's claim; no partial-frame readback.
 *  - web_fb_present(va, pitch, aa): fb_present.c's wasm branch, called by
 *    the pushbuffer executor right after the back end's flip: which guest
 *    framebuffer the title shows. With GPU frames the page shows the render
 *    target created for that VA. Without them (RECOMP_GPU=0) the guest
 *    pixels are converted here into cpu_fb and the page uploads those.
 *
 * Render targets are not written back to guest memory (D3D11 does that at
 * every flip). The title does not read them, the recorder's resync check
 * compares guest memory with itself, and the display comes from the RT.
 * ponytail: asynchronous writeback (mapAsync) if a title needs it.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "gpu_proto.h"
#include "web_host.h"

extern ptrdiff_t xbox_GetMemoryOffset(void);

static GpFrame s_frame;          /* the mailbox: GpFrame as the page reads it */
static uint32_t s_gp_ever;       /* the recorder has handed over a frame */

/* The recorder's queue carries HLSL (the D3D11 back end's language); the
 * WGSL twin of every shader is kept by id in gpu_wgsl_tap.c (on when
 * RECOMP_GPU_DUMP_WGSL is set; the page sets it to a folder that does not
 * exist, so nothing is written). Until the recorder puts WGSL in the queue
 * itself on wasm (render's TODO), the queue is rewritten here: shader
 * commands get the WGSL payload, everything else is copied as is. */
const char *gp_wgsl_source(uint32_t id, int is_ps, uint32_t *len);

static uint8_t *s_q;
static size_t s_qcap, s_qn;
static uint32_t s_wgsl_missing;

static void q_put(const void *p, size_t n)
{
    if (s_qn + n > s_qcap) {
        size_t cap = s_qcap ? s_qcap : (1u << 20);
        uint8_t *np;
        while (cap < s_qn + n) cap *= 2;
        if (!(np = (uint8_t *)realloc(s_q, cap))) return;
        s_q = np; s_qcap = cap;
    }
    if (p) memcpy(s_q + s_qn, p, n); else memset(s_q + s_qn, 0, n);
    s_qn += n;
}

static const uint8_t *queue_wgsl(const uint8_t *q, uint32_t n, uint32_t *out_n)
{
    uint32_t off = 0;
    int any = 0;
    for (off = 0; off + sizeof(GpCmd) <= n;) {
        const GpCmd *c = (const GpCmd *)(q + off);
        if (c->op == GP_SHADER_VS || c->op == GP_SHADER_PS) { any = 1; break; }
        off += (uint32_t)sizeof(GpCmd) + ((c->bytes + 15u) & ~15u);
    }
    if (!any) { *out_n = n; return q; }
    s_qn = 0;
    for (off = 0; off + sizeof(GpCmd) <= n;) {
        const GpCmd *c = (const GpCmd *)(q + off);
        uint32_t step = (uint32_t)sizeof(GpCmd) + ((c->bytes + 15u) & ~15u);
        uint32_t len = 0;
        const char *w = (c->op == GP_SHADER_VS || c->op == GP_SHADER_PS)
                      ? gp_wgsl_source(c->id, c->op == GP_SHADER_PS, &len) : NULL;
        if (w) {
            GpCmd h = *c;
            h.bytes = len + 1;
            q_put(&h, sizeof h);
            q_put(w, len + 1);
            q_put(NULL, ((h.bytes + 15u) & ~15u) - h.bytes);
        } else {
            if (c->op == GP_SHADER_VS || c->op == GP_SHADER_PS) {
                if (!s_wgsl_missing++)
                    fprintf(stderr, "[WEB] no WGSL for shader %u (is "
                            "RECOMP_GPU_DUMP_WGSL set?); passing HLSL on\n", c->id);
            }
            q_put(c, step);
        }
        off += step;
    }
    *out_n = (uint32_t)s_qn;
    return s_q;
}

static uint64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}

/* Until the page has claimed frame `seq` (copied its arenas out), at most
 * WEB_CLAIM_TIMEOUT_MS; only while a page is attached. */
static void wait_claim(WebHost *h, uint32_t seq, uint32_t frame)
{
    uint64_t t0;

    if (!__atomic_load_n(&h->page_attached, __ATOMIC_SEQ_CST)
        || __atomic_load_n(&h->gp_claimed, __ATOMIC_SEQ_CST) == seq)
        return;
    t0 = now_ms();
    for (;;) {
        uint32_t c = __atomic_load_n(&h->gp_claimed, __ATOMIC_SEQ_CST);
        uint64_t waited;
        if (c == seq)
            return;
        waited = now_ms() - t0;
        if (waited >= WEB_CLAIM_TIMEOUT_MS) {
            __atomic_add_fetch(&h->gp_dropped, 1, __ATOMIC_SEQ_CST);
            if ((h->gp_dropped & (h->gp_dropped - 1)) == 0)
                fprintf(stderr, "[WEB] page did not claim frame %u in %u ms "
                        "(%u dropped)\n", frame, WEB_CLAIM_TIMEOUT_MS,
                        h->gp_dropped);
            return;
        }
        /* Wait on the value just loaded, or a claim between the load and
         * the wait would be slept through (nfsu2-web's lost-notify rule). */
        __builtin_wasm_memory_atomic_wait32((int *)&h->gp_claimed, (int)c,
            (int64_t)(WEB_CLAIM_TIMEOUT_MS - waited) * 1000000);
    }
}

/* The recorder double-buffers its arenas on wasm (gpu_rec.c bufs_swap): the
 * frame handed over here stays untouched until the flip after next. So the
 * flip waits only for the PREVIOUS frame's claim, because the mailbox
 * (s_frame, and s_q for a rewritten queue) is about to be overwritten, and
 * the page stages frame N while the walk records N+1 -- the walk used to
 * stand still for the whole stage (2-3 ms a frame in 4-player split screen).
 * RECOMP_WEB_SYNC_CLAIM=1 waits for this frame's claim as well (the old
 * hand-off, for A/B). */
void gp_web_consume(const GpFrame *f)
{
    WebHost *h = web_host();
    static int sync_claim = -1;
    static uint32_t prev_frame;
    uint32_t seq;

    if (sync_claim < 0) {
        const char *e = getenv("RECOMP_WEB_SYNC_CLAIM");
        sync_claim = e && *e == '1';
    }
    if (s_gp_ever)
        wait_claim(h, __atomic_load_n(&h->gp_seq, __ATOMIC_SEQ_CST), prev_frame);
    s_frame = *f;
    s_frame.queue = queue_wgsl(f->queue, f->queue_bytes, &s_frame.queue_bytes);
    h->gp_frame = (uint32_t)(uintptr_t)&s_frame;
    h->last_draws = f->draw_count;
    seq = __atomic_add_fetch(&h->gp_seq, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int *)&h->gp_seq, ~0u);
    s_gp_ever = 1;
    prev_frame = f->frame;
    if (sync_claim)
        wait_claim(h, seq, f->frame);
}

/* gpu_wgsl_tap.c's gp_backend_flip calls gp_web_consume directly on wasm. */

/* ---- display ------------------------------------------------------------ */

static uint32_t *s_cpu_fb[2];
static int s_cpu_idx;

static void convert(uint32_t *dst, const uint8_t *src, uint32_t w, uint32_t h,
                    uint32_t pitch, uint32_t aa)
{
    uint32_t bpp = pitch / w, x, y;
    for (y = 0; y < h; y++) {
        const uint8_t *row = src + (size_t)y * pitch * (bpp == 8 ? aa : 1);
        uint32_t *d = dst + (size_t)y * w;
        if (bpp == 4) {
            memcpy(d, row, (size_t)w * 4);
        } else if (bpp == 8) {
            const uint32_t *p = (const uint32_t *)row;
            for (x = 0; x < w; x++) d[x] = p[x * 2];
        } else if (bpp == 2) {
            const uint16_t *p = (const uint16_t *)row;
            for (x = 0; x < w; x++) {
                uint16_t v = p[x];
                uint32_t r = (uint32_t)((v >> 11) & 0x1F) * 255u / 31u;
                uint32_t g = (uint32_t)((v >> 5) & 0x3F) * 255u / 63u;
                uint32_t b = (uint32_t)(v & 0x1F) * 255u / 31u;
                d[x] = (r << 16) | (g << 8) | b;
            }
        } else {
            memset(d, 0, (size_t)w * 4);
        }
    }
}

void web_fb_present(uint32_t fb_va, uint32_t pitch, uint32_t aa)
{
    WebHost *h = web_host();
    const uint32_t w = 640, hgt = 480;

    if (!fb_va || !pitch)
        return;
    h->disp_cpu = 0;
    if (!s_gp_ever) {
        /* No recorder frames: the guest framebuffer holds the picture. */
        int next = s_cpu_idx ^ 1;
        if (!s_cpu_fb[next])
            s_cpu_fb[next] = (uint32_t *)calloc((size_t)w * hgt, 4);
        if (s_cpu_fb[next]) {
            convert(s_cpu_fb[next], (const uint8_t *)((uintptr_t)fb_va +
                    xbox_GetMemoryOffset()), w, hgt, pitch, aa ? aa : 1);
            s_cpu_idx = next;
            h->cpu_fb = (uint32_t)(uintptr_t)s_cpu_fb[next];
            h->disp_cpu = 1;
        }
    }
    h->disp_va = fb_va;
    h->disp_pitch = pitch;
    h->disp_aa = aa;
    h->disp_w = w;
    h->disp_h = hgt;
    h->flips++;
    __atomic_add_fetch(&h->disp_seq, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int *)&h->disp_seq, ~0u);
}
