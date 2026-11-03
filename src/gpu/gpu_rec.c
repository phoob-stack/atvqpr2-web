/*
 * The recorder: the pushbuffer executor's back end (nv2a_backend.h), turning
 * what it decodes into frame packets (gpu_proto.h) for a drawing back end.
 *
 * nfsu2-web's runtime/web/gpu_web.c is the model: record, never draw. Per
 * frame there is an ordered resource queue and a list of draw records into
 * arenas, handed over at the flip. Textures are snapshotted when the walk
 * reaches the draw that uses them -- the title may rewrite them as soon as
 * the walk moves on -- and new contents always get a new texture id, freed a
 * few frames later, so a frame never sees an id change under it.
 *
 * Enabled with RECOMP_GPU=1 (RECOMP_PB_EXEC must be on). RECOMP_GPU=1 runs
 * vertex programs and combiners on the GPU (draw2); RECOMP_GPU=simple keeps
 * milestone 1's path (CPU transform, stage 0 only) for A/B comparisons.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

#include "nv2a_backend.h"
#include "d3d8_swizzle.h"
#include "gpu_proto.h"
#include "gpu_shadergen.h"
#include "gpu_shadergen_wgsl.h"   /* WebGPU tap (gpu_wgsl_tap.c) */

extern ptrdiff_t xbox_GetMemoryOffset(void);

/* ---- frame timing ----------------------------------------------------------
 *
 * RECOMP_GPU_FRAMELOG=<csv>: one line per flip -- the time since the last
 * flip, and what the recorder (texture decode, shader generation) and the
 * consumer (texture creation, shader compiles, targets, draws) spent on it.
 * RECOMP_GPU_HITCH=<ms>: a log line for every flip interval over that. */
#ifdef _WIN32
__declspec(dllimport) int __stdcall QueryPerformanceCounter(int64_t *);
__declspec(dllimport) int __stdcall QueryPerformanceFrequency(int64_t *);
double gp_now_ms(void)
{
    static double inv;
    int64_t t;
    if (!inv) { int64_t f; QueryPerformanceFrequency(&f); inv = 1000.0 / (double)f; }
    QueryPerformanceCounter(&t);
    return (double)t * inv;
}
#else
#include <time.h>
double gp_now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}
#endif

static double s_tms[GP_T_COUNT];
static uint32_t s_tn[GP_T_COUNT];
static int s_timing = -1;            /* -1 not read yet, 0 off, 1 on */
static double s_hitch_ms;
static FILE *s_framelog;

void gp_time_add(int what, double ms, uint32_t n)
{
    if (what < 0 || what >= GP_T_COUNT) return;
    s_tms[what] += ms;
    s_tn[what] += n;
}

static void timing_init(void)
{
    const char *p = getenv("RECOMP_GPU_FRAMELOG"), *h = getenv("RECOMP_GPU_HITCH");
    s_timing = 0;
    if (p && *p && (s_framelog = fopen(p, "w"))) {
        setvbuf(s_framelog, NULL, _IOFBF, 1 << 16);
        fprintf(s_framelog, "frame,t_ms,interval_ms,flip_ms,rec_tex_ms,rec_tex_n,rec_sh_ms,rec_sh_n,"
                "con_tex_ms,con_tex_n,con_sh_ms,con_sh_n,con_rt_ms,con_rt_n,con_draw_ms,draws\n");
        s_timing = 1;
    }
    if (h && *h) { s_hitch_ms = atof(h); if (s_hitch_ms > 0) s_timing = 1; }
}

/* Called once per flip, after the consumer: log and reset this frame's sums. */
static void timing_frame(uint32_t frame, double t_flip0, double t_flip1, uint32_t draws)
{
    static double last;
    double iv = last ? t_flip0 - last : 0;
    last = t_flip0;
    if (s_framelog) {
        fprintf(s_framelog, "%u,%.3f,%.3f,%.3f,%.3f,%u,%.3f,%u,%.3f,%u,%.3f,%u,%.3f,%u,%.3f,%u\n",
                frame, t_flip0, iv, t_flip1 - t_flip0,
                s_tms[GP_T_REC_TEX], s_tn[GP_T_REC_TEX], s_tms[GP_T_REC_SH], s_tn[GP_T_REC_SH],
                s_tms[GP_T_CON_TEX], s_tn[GP_T_CON_TEX], s_tms[GP_T_CON_SH], s_tn[GP_T_CON_SH],
                s_tms[GP_T_CON_RT], s_tn[GP_T_CON_RT], s_tms[GP_T_CON_DRAW], draws);
        if ((frame & 63) == 0) fflush(s_framelog);
    }
    if (s_hitch_ms > 0 && iv > s_hitch_ms)
        fprintf(stderr, "  [HITCH] frame %u: %.1f ms since the last flip; flip %.1f ms; recorder: "
                "%u textures %.1f ms, %u shaders %.1f ms; consumer: %u textures %.1f ms, "
                "%u shaders %.1f ms, %u targets %.1f ms, draws %.1f ms\n",
                frame, iv, t_flip1 - t_flip0,
                s_tn[GP_T_REC_TEX], s_tms[GP_T_REC_TEX], s_tn[GP_T_REC_SH], s_tms[GP_T_REC_SH],
                s_tn[GP_T_CON_TEX], s_tms[GP_T_CON_TEX], s_tn[GP_T_CON_SH], s_tms[GP_T_CON_SH],
                s_tn[GP_T_CON_RT], s_tms[GP_T_CON_RT], s_tms[GP_T_CON_DRAW]);
    memset(s_tms, 0, sizeof s_tms);
    memset(s_tn, 0, sizeof s_tn);
}

/* ---- growable byte buffers ----------------------------------------------- */

typedef struct { uint8_t *p; uint32_t n, cap; } Buf;

static void *buf_take(Buf *b, uint32_t bytes, uint32_t align)
{
    uint32_t at = (b->n + align - 1) & ~(align - 1);
    if (at + bytes > b->cap) {
        uint32_t cap = b->cap ? b->cap : (1u << 20);
        uint8_t *np;
        while (cap < at + bytes) cap *= 2;
        if (!(np = (uint8_t *)realloc(b->p, cap))) return NULL;
        b->p = np; b->cap = cap;
    }
    b->n = at + bytes;
    return b->p + at;
}

static Buf s_queue, s_draws, s_vtx, s_idx, s_consts;
static void *vtx_take(uint32_t bytes, uint32_t align);   /* the vertex arena (below) */
#if defined(__wasm__)
/* The browser's consumer is asynchronous: the page stages frame N (copies
 * its arenas into WebGPU buffers) while the walk records frame N+1. Two sets
 * of arenas, swapped at every flip, so the flip need not wait for the page's
 * claim (web_present.c waits for frame N-1's claim before handing over N,
 * which is long done by then). Natively the consumer drains the frame inside
 * the flip, so one set is enough. */
static Buf s_spare[5];
static void bufs_swap(void)
{
    Buf *live[5] = { &s_queue, &s_draws, &s_vtx, &s_idx, &s_consts };
    int k;
    for (k = 0; k < 5; k++) {
        Buf t = *live[k];
        *live[k] = s_spare[k];
        s_spare[k] = t;
    }
}
#endif
/* One id space for every resource -- render targets, depth, textures and
 * shaders -- above the built-in shader ids, never reused. */
static uint32_t s_frame, s_next_id = 64;
/* Bumped whenever the arenas are emptied (every flip, and every sync while a
 * frame is being checked): offsets into them are only valid within one. */
static uint32_t s_epoch;
static int s_simple;

static void q_cmd(uint32_t op, uint32_t id, uint32_t a, uint32_t b, uint32_t c,
                  uint32_t d, uint32_t e, const void *payload, uint32_t bytes)
{
    GpCmd *h = (GpCmd *)buf_take(&s_queue, sizeof *h + ((bytes + 15) & ~15u), 16);
    if (!h) return;
    h->op = op; h->id = id; h->a = a; h->b = b; h->c = c; h->d = d; h->e = e;
    h->bytes = bytes;
    if (bytes) memcpy(h + 1, payload, bytes);
}

/* Reserve a payload in place (for decoding straight into the queue). */
static void *q_cmd_reserve(uint32_t op, uint32_t id, uint32_t a, uint32_t b, uint32_t c,
                           uint32_t d, uint32_t e, uint32_t bytes)
{
    GpCmd *h = (GpCmd *)buf_take(&s_queue, sizeof *h + ((bytes + 15) & ~15u), 16);
    if (!h) return NULL;
    h->op = op; h->id = id; h->a = a; h->b = b; h->c = c; h->d = d; h->e = e;
    h->bytes = bytes;
    return h + 1;
}

static uint64_t fnv(const void *p, size_t n, uint64_t h)
{
    const uint8_t *b = (const uint8_t *)p;
    size_t i;
    for (i = 0; i < n; i++) { h ^= b[i]; h *= 1099511628211ull; }
    return h;
}
#define FNV0 1469598103934665603ull

/* The same, 8 bytes a step (the tail byte-wise), with a shift so high bits
 * reach the low ones: for content and key hashes that stay in this process.
 * wasm has no fast byte loop -- byte-wise FNV over a frame's textures and
 * keys was ~4% of the walk thread in 4-player split screen. */
static uint64_t fnv_wide(const void *p, size_t n, uint64_t h)
{
    const uint8_t *b = (const uint8_t *)p;
    size_t i = 0;
    for (; i + 8 <= n; i += 8) {
        uint64_t w;
        memcpy(&w, b + i, 8);
        h = (h ^ w) * 1099511628211ull;
        h ^= h >> 29;
    }
    return fnv(b + i, n - i, h);
}

/* memcmp(a, b, n) == 0. wasi-libc's memcmp is a byte loop, and the recorder
 * compares kilobytes per draw (the 3 KB VS constant file, programs). */
static int same_bytes(const void *a, const void *b, size_t n)
{
#if defined(__wasm_simd128__)
    const uint8_t *p = (const uint8_t *)a, *q = (const uint8_t *)b;
    for (; n >= 64; p += 64, q += 64, n -= 64) {
        v128_t d = wasm_v128_xor(wasm_v128_load(p), wasm_v128_load(q));
        d = wasm_v128_or(d, wasm_v128_xor(wasm_v128_load(p + 16), wasm_v128_load(q + 16)));
        d = wasm_v128_or(d, wasm_v128_xor(wasm_v128_load(p + 32), wasm_v128_load(q + 32)));
        d = wasm_v128_or(d, wasm_v128_xor(wasm_v128_load(p + 48), wasm_v128_load(q + 48)));
        if (wasm_v128_any_true(d)) return 0;
    }
    for (; n >= 16; p += 16, q += 16, n -= 16)
        if (wasm_v128_any_true(wasm_v128_xor(wasm_v128_load(p), wasm_v128_load(q)))) return 0;
    return !n || !memcmp(p, q, n);
#else
    return !memcmp(a, b, n);
#endif
}

/* Ids whose contents were replaced: freed three frames later. */
#define MAX_FREE 16384
static struct { uint32_t id, frame; } s_free[MAX_FREE];
static int s_nfree;

static void defer_free(uint32_t id)
{
    if (id && s_nfree < MAX_FREE) {
        s_free[s_nfree].id = id;
        s_free[s_nfree].frame = s_frame;
        s_nfree++;
    }
}

/* ---- render targets and depth -------------------------------------------- */

#define MAX_RT 64
typedef struct {
    uint32_t id, va, w, h, bpp, fmt, swz, pitch;
    uint32_t used_frame;        /* last frame a draw or clear used it */
    uint64_t guest_hash;        /* guest pixels as of our last upload/writeback */
} Rt;
static Rt s_rt[MAX_RT];
static int s_nrt;

static uint32_t argb_from_16(uint16_t p, uint32_t cf)
{
    if (cf == 3)
        return 0xFF000000u | (d3d8_expand_channel((p >> 11) & 31, 5) << 16)
             | (d3d8_expand_channel((p >> 5) & 63, 6) << 8) | d3d8_expand_channel(p & 31, 5);
    return 0xFF000000u | (d3d8_expand_channel((p >> 10) & 31, 5) << 16)
         | (d3d8_expand_channel((p >> 5) & 31, 5) << 8) | d3d8_expand_channel(p & 31, 5);
}

static int rt_syncable(const Rt *r)
{
    return !r->swz && r->pitch && (r->bpp == 4 || r->bpp == 2);
}

/* Every 4th dword of the surface: cheap enough per frame (~300 KB read for
 * 640x480x4), dense enough that a CPU copy or a drawn overlay changes it. */
static uint64_t rt_guest_hash(const Rt *r)
{
    const uint8_t *mem = (const uint8_t *)xbox_GetMemoryOffset() + r->va;
    uint32_t y, x, rowbytes = r->w * r->bpp;
    uint64_t h = FNV0;
    for (y = 0; y < r->h; y++) {
        const uint32_t *row = (const uint32_t *)(mem + (size_t)y * r->pitch);
        for (x = (y & 3); x < rowbytes / 4; x += 4) { h ^= row[x]; h *= 1099511628211ull; }
    }
    return h;
}

static uint32_t s_rt_resyncs;

/* (Re)create the target on the GPU side from the guest's pixels. */
static void rt_upload(Rt *r)
{
    const uint8_t *mem = (const uint8_t *)xbox_GetMemoryOffset();
    uint32_t bytes = rt_syncable(r) ? r->w * r->h * 4 : 0, x, y;
    uint32_t *px = (uint32_t *)q_cmd_reserve(GP_RT_CREATE, r->id, r->va, r->w, r->h,
                                              r->bpp | (r->fmt << 8) | (r->swz << 16),
                                              r->pitch, bytes);
    if (px && bytes) {
        for (y = 0; y < r->h; y++) {
            const uint8_t *row = mem + r->va + (size_t)y * r->pitch;
            if (r->bpp == 4)
                memcpy(px + (size_t)y * r->w, row, (size_t)r->w * 4);
            else
                for (x = 0; x < r->w; x++)
                    px[(size_t)y * r->w + x] = argb_from_16(((const uint16_t *)row)[x], r->fmt);
        }
    }
    if (rt_syncable(r))
        r->guest_hash = rt_guest_hash(r);
}

static const Rt *rt_get(const Nv2aSurface *s)
{
    const uint8_t *mem = (const uint8_t *)xbox_GetMemoryOffset();
    uint32_t bpp = s->bytes_per_pixel ? s->bytes_per_pixel : 4;
    uint32_t w = s->swizzled || !s->pitch ? s->width : s->pitch / bpp, h = s->height;
    Rt *r = NULL;
    int i;

    /* D3D sends the surface format before the address, so for a few commands
     * the old address carries the next surface's format -- seen as a 1x1
     * 16-bit swizzled "surface" at the framebuffer. Nothing real draws into
     * a surface that small; taking it as one replaced the framebuffer's
     * target. */
    if (w < 4 || h < 4 || w > 4096 || h > 4096) return NULL;
    for (i = 0; i < s_nrt; i++)
        if (s_rt[i].va == s->color_va) { r = &s_rt[i]; break; }
    /* Swizzling is only how the guest stores the pixels; the GPU image is
     * the same. A render-to-texture surface drawn linear in one pass and
     * swizzled in the next stays one target, and once it has been swizzled
     * it is no longer written back (that would store it in the wrong order). */
    if (r && r->w >= w && r->h >= h && r->bpp == bpp) {
        if ((uint32_t)s->swizzled != r->swz) {
            static int shown;
            if (shown++ < 20)
                fprintf(stderr, "  [GPUREC] target %u (0x%08X %ux%u) now used %s\n",
                        r->id, r->va, r->w, r->h, s->swizzled ? "swizzled" : "linear");
            r->swz = s->swizzled;          /* how this use stores it */
        }
        /* First use this frame: if the guest wrote these pixels itself since
         * we last synced (a CPU copy of the front buffer under a loading or
         * start screen, say), the GPU image is stale -- drawing over it and
         * writing it back would undo the guest's write, and the screen
         * flashes between the two. Take the guest's pixels first. */
        if (r->used_frame != s_frame) {
            r->used_frame = s_frame;
            if (rt_syncable(r) && rt_guest_hash(r) != r->guest_hash) {
                rt_upload(r);
                s_rt_resyncs++;
            }
        }
        return r;
    }
    if (!r) {
        if (s_nrt == MAX_RT) return NULL;
        r = &s_rt[s_nrt++];
    } else {
        /* Replaced (it grew): the old GPU target goes once no draw of the
         * last few frames can still name it. */
        defer_free(r->id);
    }
    r->id = s_next_id++;
    r->va = s->color_va; r->w = w; r->h = h; r->bpp = bpp;
    r->fmt = s->color_format; r->swz = s->swizzled; r->pitch = s->pitch;
    r->used_frame = s_frame;
    rt_upload(r);
    fprintf(stderr, "  [GPUREC] render target %u: 0x%08X %ux%u bpp %u fmt %u%s\n",
            r->id, r->va, w, h, bpp, r->fmt, r->swz ? " swizzled" : "");
    return r;
}

static const Rt *rt_find(uint32_t va)
{
    int i;
    for (i = 0; i < s_nrt; i++)
        if (s_rt[i].va == va) return &s_rt[i];
    return NULL;
}

/* Could this texture be what a target of `bpp` bytes drew? DXT and palette
 * formats never are. This matters once memory is reused (RECOMP_HEAP_RECLAIM:
 * D3D frees an impostor's 256 KB and a DXT texture lands at the address):
 * matched by address alone, that texture sampled the stale target instead. */
static uint32_t texel_bytes(uint32_t fmt);

static int rt_format_ok(const Nv2aTexture *t, uint32_t bpp)
{
    if (d3d8_format_dxt_block_bytes(t->color) || t->color == 0x0B) return 0;
    return texel_bytes(t->color) == bpp;
}

static const Rt *rt_find_tex(const Nv2aTexture *t)
{
    const Rt *r = rt_find(t->offset);
    return r && rt_format_ok(t, r->bpp) ? r : NULL;
}

/* A texture that lies inside a render target without starting at it: a tile
 * of an atlas the title drew (ATV 2 draws distant riders as impostors into
 * 256x256 swizzled targets and samples them as smaller swizzled textures at
 * offsets into them). The GPU target is the only up-to-date copy -- a
 * swizzled target is never written back -- so the tile is copied out of it
 * on the GPU, in draw order (GP_SUB_CREATE, then the consumer copies the
 * region before each draw that samples it). Read from guest memory instead,
 * it was whatever the memory held before: black squares. */
static uint32_t pext(uint32_t v, uint32_t mask)
{
    uint32_t r = 0, bit = 1;
    while (mask) {
        uint32_t low = mask & (~mask + 1u);
        if (v & low) r |= bit;
        bit <<= 1;
        mask &= mask - 1u;
    }
    return r;
}

#define MAX_SUB 256
static struct { uint32_t rt, x0, y0, w, h, id; } s_sub[MAX_SUB];
static int s_nsub, s_sub_next;

static int size_from_format(uint32_t f);   /* defined below; clang wants it declared before use */

/* GP_TEX_RT | id for a texture that is a whole target, a GP_SUB_CREATE id for
 * a tile of one, 0 for neither. *full: the whole target (coordinates are
 * then scaled to it). */
static uint32_t rt_tex(const Nv2aTexture *t, int *full)
{
    int i;
    const Rt *r = rt_find_tex(t);
    uint32_t x0, y0, d, k;
    *full = 0;
    if (r) { *full = 1; return GP_TEX_RT | r->id; }
    for (i = 0; i < s_nrt; i++) {
        r = &s_rt[i];
        if (t->offset > r->va && t->offset - r->va < r->h * (r->swz ? r->w * r->bpp : r->pitch))
            break;
    }
    if (i == s_nrt || r->bpp != 4 || !rt_format_ok(t, 4)) return 0;
    d = t->offset - r->va;
    if (size_from_format(t->color)) {
        uint32_t mx, my;
        if ((r->w & (r->w - 1)) || (r->h & (r->h - 1)) || d3d8_format_dxt_block_bytes(t->color))
            return 0;
        xbox_swizzle_masks(r->w, r->h, &mx, &my);
        x0 = pext(d / 4, mx); y0 = pext(d / 4, my);
    } else {
        if (t->pitch != r->pitch) return 0;
        x0 = (d % r->pitch) / 4; y0 = d / r->pitch;
    }
    if (x0 + t->width > r->w || y0 + t->height > r->h) return 0;
    for (k = 0; k < (uint32_t)s_nsub; k++)
        if (s_sub[k].rt == r->id && s_sub[k].x0 == x0 && s_sub[k].y0 == y0
            && s_sub[k].w == t->width && s_sub[k].h == t->height)
            return s_sub[k].id;
    k = s_nsub < MAX_SUB ? (uint32_t)s_nsub++ : (uint32_t)(s_sub_next++ % MAX_SUB);
    if (s_sub[k].id) defer_free(s_sub[k].id);
    s_sub[k].rt = r->id; s_sub[k].x0 = x0; s_sub[k].y0 = y0;
    s_sub[k].w = t->width; s_sub[k].h = t->height; s_sub[k].id = s_next_id++;
    q_cmd(GP_SUB_CREATE, s_sub[k].id, r->id, t->width, t->height, x0 | (y0 << 16), 0, NULL, 0);
    {
        static int shown;
        if (shown++ < 16)
            fprintf(stderr, "  [GPUREC] texture 0x%08X %ux%u fmt %02X is a tile of target %u"
                    " (0x%08X %ux%u%s) at %u,%u\n", t->offset, t->width, t->height, t->color,
                    r->id, r->va, r->w, r->h, r->swz ? " swizzled" : "", x0, y0);
    }
    return s_sub[k].id;
}

#define MAX_DS 16
typedef struct { uint32_t id, va, w, h; } Ds;
static Ds s_ds[MAX_DS];
static int s_nds;

static uint32_t ds_get(uint32_t va, uint32_t w, uint32_t h)
{
    Ds *d = NULL;
    int i;
    if (!va) return 0;
    for (i = 0; i < s_nds; i++)
        if (s_ds[i].va == va) { d = &s_ds[i]; break; }
    if (d && d->w >= w && d->h >= h) return d->id;
    if (!d) {
        if (s_nds == MAX_DS) return 0;
        d = &s_ds[s_nds++];
    }
    d->id = s_next_id++; d->va = va; d->w = w; d->h = h;
    q_cmd(GP_DS_CREATE, d->id, va, w, h, 0, 0, NULL, 0);
    return d->id;
}

/* ---- textures ------------------------------------------------------------ */

#define TEX_HASH 4096
typedef struct {
    uint32_t offset, w, h, color, pitch, cube, used, levels, palette;
    uint32_t id, checked_frame, ver;   /* ver: its slot in s_ver */
    uint64_t hash;
} Tex;
static Tex s_tex[TEX_HASH];


static int size_from_format(uint32_t f)
{
    return d3d8_format_is_swizzled(f) || d3d8_format_dxt_block_bytes(f);
}

static uint32_t texel_bytes(uint32_t fmt)
{
    switch (fmt) {
    case 0x00: case 0x01: case 0x0B: case 0x13: case 0x19: case 0x1B: case 0x1F:
        return 1;
    case 0x02: case 0x03: case 0x04: case 0x05: case 0x10: case 0x11: case 0x1A:
    case 0x1C: case 0x1D: case 0x20: case 0x24: case 0x25: case 0x27: case 0x28:
    case 0x29: case 0x2C:
        return 2;
    default:
        return 4;
    }
}

static uint32_t level0_bytes(const Nv2aTexture *t)
{
    uint32_t bb = d3d8_format_dxt_block_bytes(t->color);
    if (bb) return ((t->width + 3) / 4) * ((t->height + 3) / 4) * bb;
    if (!size_from_format(t->color)) return t->pitch * t->height;
    return t->width * t->height * texel_bytes(t->color);
}

/* tex_face_stride() in nv2a_pb_exec.c: one face with all its mips, 128-aligned. */
static uint32_t face_stride(const Nv2aTexture *t)
{
    uint32_t lv, total = 0, levels = t->levels ? t->levels : 1;
    uint32_t bb = d3d8_format_dxt_block_bytes(t->color);
    if (!size_from_format(t->color))
        return (t->pitch * t->height + 127u) & ~127u;
    for (lv = 0; lv < levels; lv++) {
        uint32_t lw = (t->width >> lv) ? (t->width >> lv) : 1;
        uint32_t lh = (t->height >> lv) ? (t->height >> lv) : 1;
        total += bb ? ((lw + 3) / 4) * ((lh + 3) / 4) * bb : lw * lh * texel_bytes(t->color);
    }
    return (total + 127u) & ~127u;
}

/* Sampled FNV over a face: all of small textures, the first and last 4 KB
 * and every 64th byte between for large ones. */
static uint64_t hash_span(const uint8_t *p, uint32_t n, uint64_t h)
{
    uint32_t i;
    if (n <= 16384) return fnv_wide(p, n, h);
    h = fnv_wide(p, 4096, h);
    for (i = 4096; i + 4096 < n; i += 64) { h ^= p[i] | (uint32_t)p[i + 1] << 8; h *= 1099511628211ull; }
    return fnv_wide(p + n - 4096, 4096, h);
}

/* Mip levels to upload: the format word's count for swizzled and DXT
 * textures, none below 1x1 (xemu pgraph_get_texture_shape); linear ones have
 * one. */
static uint32_t tex_levels(const Nv2aTexture *t)
{
    uint32_t l = t->levels ? t->levels : 1, full = 1, m = t->width > t->height ? t->width : t->height;
    if (!size_from_format(t->color)) return 1;
    while ((1u << (full - 1)) < m) full++;
    if (l > full) l = full;
    return l > 16 ? 16 : l;
}

/* Bytes of level `lv` (DXT levels below 4x4 still take a whole block). */
static uint32_t level_bytes(const Nv2aTexture *t, uint32_t lv)
{
    uint32_t bb = d3d8_format_dxt_block_bytes(t->color);
    uint32_t lw = (t->width >> lv) ? (t->width >> lv) : 1;
    uint32_t lh = (t->height >> lv) ? (t->height >> lv) : 1;
    if (lv == 0) return level0_bytes(t);
    return bb ? ((lw + 3) / 4) * ((lh + 3) / 4) * bb : lw * lh * texel_bytes(t->color);
}

static void tex_undecodable(const Nv2aTexture *t, int cube)
{
    static uint32_t seen[64];
    static int nseen;
    int k;
    for (k = 0; k < nseen && seen[k] != t->color; k++) ;
    if (k == nseen && nseen < 64) {
        seen[nseen++] = t->color;
        fprintf(stderr, "  [GPUREC] texture format 0x%02X (%ux%u at 0x%08X%s) not decodable: white\n",
                t->color, t->width, t->height, t->offset, cube ? ", cube" : "");
    }
}

/* ---- fast texel decode -----------------------------------------------------
 *
 * nv2a_backend_decode_texture goes through the CPU rasteriser's sampler, one
 * texel at a time, recomputing the swizzle masks and depositing both
 * coordinates bit by bit for every texel: about 40 ns a texel. A race
 * recreates three 128x128 P8 textures (8 levels, palette animated) up to a
 * dozen times a frame -- ~0.9 ms each, 9 ms of the walk's frame after GO.
 * These are the same conversions as sample_tex() in nv2a_pb_exec.c (clamped,
 * so every texel is read where it lies), with the swizzle deposit done once
 * per row and column. Anything else goes to the reference decoder.
 * RECOMP_GPU_DECODE_CHECK=1 decodes every level both ways and logs any
 * difference. */
static int fast_decode(const Nv2aTexture *t, uint32_t *out)
{
    static uint32_t xs[4096], ys[4096];
    const uint8_t *mem = (const uint8_t *)xbox_GetMemoryOffset();
    const uint8_t *p = mem + t->offset;
    uint32_t w = t->width, h = t->height, x, y, mx, my;
    int swz;

    if (!w || !h || w > 4096 || h > 4096) return 0;
    switch (t->color) {
    case 0x0B:                                   /* SZ_I8_A8R8G8B8 */
        if (!t->palette) return 0;
        swz = 1;
        break;
    case 0x06: case 0x07:                        /* SZ_A8R8G8B8, SZ_X8R8G8B8 */
        swz = 1;
        break;
    case 0x12: case 0x1E:                        /* LIN_A8R8G8B8, LIN_X8R8G8B8 */
        swz = 0;
        break;
    default:
        return 0;
    }
    if (!swz) {
        uint32_t or_ = t->color == 0x1E ? 0xFF000000u : 0;
        for (y = 0; y < h; y++) {
            const uint32_t *row = (const uint32_t *)(p + (size_t)y * t->pitch);
            uint32_t *o = out + (size_t)y * w;
            for (x = 0; x < w; x++) o[x] = row[x] | or_;
        }
        return 1;
    }
    xbox_swizzle_masks(w, h, &mx, &my);
    for (x = 0; x < w; x++) xs[x] = swizzle_deposit(x, mx);
    for (y = 0; y < h; y++) ys[y] = swizzle_deposit(y, my);
    if (t->color == 0x0B) {
        const uint32_t *pal = (const uint32_t *)(mem + t->palette);
        for (y = 0; y < h; y++) {
            uint32_t *o = out + (size_t)y * w, yo = ys[y];
            for (x = 0; x < w; x++) o[x] = pal[p[xs[x] | yo]];
        }
    } else {
        const uint32_t *s = (const uint32_t *)p;
        uint32_t or_ = t->color == 0x07 ? 0xFF000000u : 0;
        for (y = 0; y < h; y++) {
            uint32_t *o = out + (size_t)y * w, yo = ys[y];
            for (x = 0; x < w; x++) o[x] = s[xs[x] | yo] | or_;
        }
    }
    return 1;
}

static int decode_level(const Nv2aTexture *lt, uint32_t *out)
{
    static int check = -1, fast = -1;
    if (check < 0) {
        const char *e = getenv("RECOMP_GPU_FAST_DECODE");
        check = getenv("RECOMP_GPU_DECODE_CHECK") != NULL;
        fast = !(e && *e == '0');                /* =0: the reference decoder only (A/B) */
    }
    /* While the executor checks a frame, decode as its CPU pass does. */
    if (!fast || nv2a_check_active() || !fast_decode(lt, out))
        return nv2a_backend_decode_texture(lt, out);
    if (check) {
        static uint32_t *ref;
        static size_t cap;
        static unsigned checked, bad;
        size_t n = (size_t)lt->width * lt->height;
        if (n > cap) { free(ref); cap = n; ref = (uint32_t *)malloc(n * 4); }
        if (ref && nv2a_backend_decode_texture(lt, ref)) {
            int tries;
            checked++;
            /* The title can be rewriting the texels (an animated palette)
             * while they are read: a difference counts only if it stays
             * through a few reference-then-fast rounds. */
            for (tries = 0; tries < 4 && memcmp(ref, out, n * 4); tries++) {
                nv2a_backend_decode_texture(lt, ref);
                fast_decode(lt, out);
            }
            if (memcmp(ref, out, n * 4)) {
                size_t i;
                for (i = 0; i < n && ref[i] == out[i]; i++) ;
                if (bad++ < 20)
                    fprintf(stderr, "  [GPUREC] decode check: 0x%08X %ux%u fmt %02X differs at texel %u:"
                            " fast %08X reference %08X\n", lt->offset, lt->width, lt->height, lt->color,
                            (unsigned)i, out[i], ref[i]);
            }
            if ((checked & 1023) == 0)
                fprintf(stderr, "  [GPUREC] decode check: %u levels compared, %u differ\n", checked, bad);
        }
    }
    return 1;
}

/* ---- texture versions ------------------------------------------------------
 *
 * Every texture id the recorder creates is a version: one address and shape
 * with one content hash. When a texture's contents change to something seen
 * before -- the rider textures above cycle back to earlier palettes -- the
 * version that already holds them is bound again: no decode, no upload, no
 * GPU texture creation.
 *
 * A version that some texture entry (s_tex) currently shows is kept as long
 * as before (until that entry moves on or is evicted). One that none shows
 * any more is kept VER_IDLE frames for a possible return, then freed (three
 * frames later, as before); together those hold at most VER_OLD_BYTES. */
#define VER_HASH  8192
#define VER_PROBE 16
#define VER_IDLE  60
#define VER_OLD_BYTES (64ull << 20)
typedef struct { uint64_t key, full; uint32_t id, used, bytes, cur; } Ver;   /* cur: entries showing it */
static Ver s_ver[VER_HASH];
static uint64_t s_ver_old_bytes;             /* bytes of versions with cur == 0 */
static uint32_t s_ver_hits, s_ver_made, s_ver_freed;
static int s_tex_reuse = -1;

/* RECOMP_GPU_REUSE_CHECK=1: every version also gets a hash of all its bytes
 * (the content hash samples large textures), and every rebind compares it
 * with the bytes in memory now. */
static int s_reuse_check = -1;
static uint32_t s_rc_ok, s_rc_bad;

static uint64_t full_hash(const Nv2aTexture *t, uint32_t faces, uint32_t stride, uint32_t fbytes)
{
    const uint8_t *mem = (const uint8_t *)xbox_GetMemoryOffset();
    uint64_t h = FNV0;
    uint32_t f;
    for (f = 0; f < faces; f++) h = fnv(mem + t->offset + f * stride, fbytes, h);
    if (t->color == 0x0B && t->palette) h = fnv(mem + t->palette, 1024, h);
    return h;
}

static void ver_drop(Ver *v)
{
    defer_free(v->id);
    if (!v->cur) s_ver_old_bytes -= v->bytes;
    s_ver_freed++;
    memset(v, 0, sizeof *v);
}

static void ver_hold(Ver *v)
{
    if (!v->cur++) s_ver_old_bytes -= v->bytes;
}

/* An entry stops showing version slot `slot` (if it is still id's). */
static void ver_release(uint32_t slot, uint32_t id)
{
    Ver *v = &s_ver[slot & (VER_HASH - 1)];
    if (!id || v->id != id || !v->cur) return;
    if (!--v->cur) { s_ver_old_bytes += v->bytes; v->used = s_frame; }
}

static uint32_t ver_slot(uint64_t key) { return (uint32_t)(key ^ (key >> 29)) & (VER_HASH - 1); }

static Ver *ver_find(uint64_t key)
{
    uint32_t i, s = ver_slot(key);
    for (i = 0; i < VER_PROBE; i++) {
        Ver *v = &s_ver[(s + i) & (VER_HASH - 1)];
        if (v->id && v->key == key) return v;
    }
    return NULL;
}

/* A new version, shown by one entry. Its run of slots full: the least
 * recently used one that nothing shows goes, else the least recently used. */
static Ver *ver_add(uint64_t key, uint32_t id, uint32_t bytes)
{
    uint32_t i, s = ver_slot(key);
    Ver *best = NULL;
    for (i = 0; i < VER_PROBE; i++) {
        Ver *v = &s_ver[(s + i) & (VER_HASH - 1)];
        if (!v->id) { best = v; break; }
        if (!best || (!v->cur && best->cur) || (!v->cur == !best->cur && v->used < best->used)) best = v;
    }
    if (best->id) ver_drop(best);
    best->key = key; best->id = id; best->used = s_frame; best->bytes = bytes; best->cur = 1;
    s_ver_made++;
    return best;
}

/* Every 15 frames: free versions nothing has shown for VER_IDLE frames, then
 * the oldest of those while they hold more than VER_OLD_BYTES. */
static void ver_sweep(void)
{
    uint32_t i;
    for (i = 0; i < VER_HASH; i++)
        if (s_ver[i].id && !s_ver[i].cur && s_frame - s_ver[i].used > VER_IDLE) ver_drop(&s_ver[i]);
    while (s_ver_old_bytes > VER_OLD_BYTES) {
        Ver *old = NULL;
        for (i = 0; i < VER_HASH; i++)
            if (s_ver[i].id && !s_ver[i].cur && (!old || s_ver[i].used < old->used)) old = &s_ver[i];
        if (!old) break;
        ver_drop(old);
    }
}

static uint32_t tex_get(const Nv2aTexture *t, int cube, int *is_bc)
{
    const uint8_t *mem = (const uint8_t *)xbox_GetMemoryOffset();
    uint32_t bb = d3d8_format_dxt_block_bytes(t->color), faces = cube ? 6 : 1, f, lv;
    uint32_t levels = tex_levels(t), fbytes = 0, stride, l0 = level0_bytes(t), id, gpu_bytes;
    uint32_t kk[6] = { t->offset, t->width, t->height, t->color, t->pitch, t->palette };
    uint64_t key = fnv_wide(kk, sizeof kk, FNV0) ^ (uint64_t)cube, h = FNV0, vkey;
    uint32_t slot = (uint32_t)(key ^ (key >> 32)) & (TEX_HASH - 1), probe;
    Tex *e = NULL, *victim = NULL;
    Ver *v;
    int bc = bb && (t->width & 3) == 0 && (t->height & 3) == 0;
    double t_start = 0;
    int replaced;

    *is_bc = bc;
    if (!t->offset || !t->width || !t->height || t->width > 4096 || t->height > 4096 || !l0)
        return 0;
    for (lv = 0; lv < levels; lv++)
        fbytes += level_bytes(t, lv);
    stride = cube ? face_stride(t) : 0;
    for (probe = 0; probe < 16; probe++) {
        Tex *c = &s_tex[(slot + probe) & (TEX_HASH - 1)];
        if (c->id && c->offset == t->offset && c->w == t->width && c->h == t->height
            && c->color == t->color && c->pitch == t->pitch && c->cube == (uint32_t)cube
            && c->levels == levels && c->palette == t->palette) {
            e = c; break;
        }
        if (!victim || !c->id || (victim->id && c->used < victim->used)) victim = c;
    }
    /* Its version was swept: the id is going, look the contents up again. */
    if (e && s_ver[e->ver].id != e->id) { e->checked_frame = ~0u; e->hash = 0; }
    if (e && e->checked_frame == s_frame) { e->used = s_frame; return e->id; }
    if (s_timing > 0) t_start = gp_now_ms();
    for (f = 0; f < faces; f++)
        h = hash_span(mem + t->offset + f * stride, fbytes, h);
    if (t->color == 0x0B && t->palette)          /* P8: the palette is half the texture */
        h = fnv_wide(mem + t->palette, 1024, h);
    if (e && e->hash == h && s_ver[e->ver].id == e->id) {
        e->checked_frame = e->used = s_frame;
        s_ver[e->ver].used = s_frame;
        if (s_timing > 0) gp_time_add(GP_T_REC_TEX, gp_now_ms() - t_start, 0);
        return e->id;
    }

    replaced = e != NULL;
    if (!e) e = victim;
    ver_release(e->ver, e->id);                  /* what it showed may come back */
    memset(e, 0, sizeof *e);
    e->offset = t->offset; e->w = t->width; e->h = t->height;
    e->color = t->color; e->pitch = t->pitch; e->cube = (uint32_t)cube;
    e->levels = levels; e->palette = t->palette;
    e->hash = h; e->checked_frame = e->used = s_frame;

    /* The version key leaves the palette's address out: its contents are
     * in h, and riders share one P8 texture with a palette each. */
    kk[5] = levels;
    vkey = fnv(&h, sizeof h, fnv(kk, sizeof kk, FNV0) ^ (uint64_t)cube) | 1;
    if (s_tex_reuse < 0) {                       /* RECOMP_GPU_TEX_REUSE=0: never (A/B) */
        const char *r = getenv("RECOMP_GPU_TEX_REUSE");
        s_tex_reuse = !(r && *r == '0');
    }
    if (s_tex_reuse && (v = ver_find(vkey))) {   /* contents seen before: bind them again */
        ver_hold(v);
        v->used = s_frame;
        e->id = v->id;
        e->ver = (uint32_t)(v - s_ver);
        s_ver_hits++;
        if (s_reuse_check > 0) {
            if (full_hash(t, faces, stride, fbytes) == v->full) s_rc_ok++;
            else if (s_rc_bad++ < 20)
                fprintf(stderr, "  [GPUREC] reuse check: 0x%08X %ux%u fmt %02X rebound to id %u but its bytes"
                        " differ from that version's\n", t->offset, t->width, t->height, t->color, v->id);
            if (((s_rc_ok + s_rc_bad) & 255) == 0)
                fprintf(stderr, "  [GPUREC] reuse check: %u rebinds compared in full, %u differ\n",
                        s_rc_ok + s_rc_bad, s_rc_bad);
        }
        if (s_timing > 0) gp_time_add(GP_T_REC_TEX, gp_now_ms() - t_start, 0);
        return e->id;
    }
    id = s_next_id++;

    /* Payload: per face, level 0 then each smaller level -- the order the
     * NV2A stores them in (xemu: levels follow level 0, each swizzled or
     * block-compressed on its own), so BC is a straight copy. */
    if (bc) {
        uint8_t *p = (uint8_t *)q_cmd_reserve(GP_TEX_CREATE, id, levels, t->width, t->height,
                                              t->color == 0x0C ? GP_FMT_BC1
                                              : t->color == 0x0E ? GP_FMT_BC2 : GP_FMT_BC3,
                                              faces, fbytes * faces);
        gpu_bytes = fbytes * faces;
        if (p)
            for (f = 0; f < faces; f++)
                memcpy(p + (size_t)f * fbytes, mem + t->offset + f * stride, fbytes);
    } else {
        uint32_t total = 0, at = 0;
        uint32_t *p;
        for (lv = 0; lv < levels; lv++) {
            uint32_t lw = (t->width >> lv) ? (t->width >> lv) : 1;
            uint32_t lh = (t->height >> lv) ? (t->height >> lv) : 1;
            total += lw * lh;
        }
        p = (uint32_t *)q_cmd_reserve(GP_TEX_CREATE, id, levels, t->width, t->height,
                                      GP_FMT_BGRA8, faces, total * 4 * faces);
        gpu_bytes = total * 4 * faces;
        for (f = 0; p && f < faces; f++) {
            uint32_t src = t->offset + f * stride;
            for (lv = 0; lv < levels; lv++) {
                Nv2aTexture lt = *t;
                uint32_t px;
                lt.width = (t->width >> lv) ? (t->width >> lv) : 1;
                lt.height = (t->height >> lv) ? (t->height >> lv) : 1;
                lt.offset = src;
                lt.levels = 1;
                px = lt.width * lt.height;
                if (!decode_level(&lt, p + at)) {
                    /* Not decodable (palettised, say): as the CPU, read white. */
                    memset(p + at, 0xFF, (size_t)px * 4);
                    tex_undecodable(t, cube);
                }
                at += px;
                src += level_bytes(t, lv);
            }
        }
    }
    v = ver_add(vkey, id, gpu_bytes);
    if (s_reuse_check < 0) s_reuse_check = getenv("RECOMP_GPU_REUSE_CHECK") != NULL;
    if (s_reuse_check > 0) v->full = full_hash(t, faces, stride, fbytes);
    e->id = id;
    e->ver = (uint32_t)(v - s_ver);
    if (s_timing > 0) gp_time_add(GP_T_REC_TEX, gp_now_ms() - t_start, 1);
    {
        static int texlog = -1;
        if (texlog < 0) texlog = getenv("RECOMP_GPU_TEXLOG") != NULL;
        if (texlog)
            fprintf(stderr, "  [TEXLOG] frame %u id %u 0x%08X %ux%u fmt %02X lv %u%s pitch %u %s hash %016llX %.3f ms\n",
                    s_frame, id, t->offset, t->width, t->height, t->color, levels, cube ? " cube" : "",
                    t->pitch, replaced ? "changed" : "new", (unsigned long long)h,
                    s_timing > 0 ? gp_now_ms() - t_start : 0.0);
    }
    return id;
}

/* The sampler key for a stage: rc_texel()'s one linear switch (what the check
 * compares against), plus the filter word for drawing with mip levels. */
static uint32_t smp_key(const Nv2aTexture *t, int border)
{
    uint32_t mag = (t->filter >> 24) & 0xF, min = (t->filter >> 16) & 0xFF;
    int32_t bias = (int32_t)(t->filter & 0x1FFF);
    uint32_t k = ((mag == 2 || min == 2 || min == 4 || min == 6) ? GP_SMP_LINEAR : 0)
               | GP_SMP_U(t->addr_u) | GP_SMP_V(t->addr_v) | (border ? GP_SMP_BORDER : 0);
    if (bias & 0x1000) bias -= 0x2000;           /* signed, 1/256 of a level */
    bias /= 16;
    if (bias < -128) bias = -128;
    if (bias > 127) bias = 127;
    if (min <= 7 && mag <= 4)
        k |= GP_SMP_FILTER | GP_SMP_MIN(min) | GP_SMP_MAG(mag) | GP_SMP_BIAS(bias);
    return k;
}

/* ---- shaders ------------------------------------------------------------- */

#define SH_HASH 2048
static struct { uint64_t key; uint32_t id; } s_vs[SH_HASH], s_ps[SH_HASH];
static char s_hlsl[256 * 1024];

/* GP_SHADER_VS: a = program length, b = the input mask (the vertex layout:
 * those inputs, packed in register order, 16 bytes each). */
static uint32_t vs_lookup(const uint32_t (*prog)[4], uint32_t len, uint32_t mask)
{
    uint64_t key = fnv(prog, (size_t)len * 16, FNV0) | 1;
    uint32_t slot = (uint32_t)key & (SH_HASH - 1), p;
    int n;
    for (p = 0; p < SH_HASH; p++) {
        uint32_t i = (slot + p) & (SH_HASH - 1);
        if (s_vs[i].key == key) return s_vs[i].id;
        if (!s_vs[i].key) {
            double t0 = s_timing > 0 ? gp_now_ms() : 0;
            n = gpu_gen_vs_program(prog, len, s_hlsl, sizeof s_hlsl);
            if (n < 0) return 0;
            if (mask != gpu_vs_input_mask(prog, len))       /* the two rules must agree */
                fprintf(stderr, "  [GPUREC] VS input mask %04X from the executor, %04X here\n",
                        mask, gpu_vs_input_mask(prog, len));
            s_vs[i].key = key;
            s_vs[i].id = s_next_id++;
            q_cmd(GP_SHADER_VS, s_vs[i].id, len, mask, 0, 0, 0, s_hlsl, (uint32_t)n + 1);
#ifndef __wasm__
            gp_d3d11_prefetch_shader(0, mask, s_hlsl, (size_t)n);
#endif
            gp_wgsl_note_vs(s_vs[i].id, prog, len);
            if (s_timing > 0) gp_time_add(GP_T_REC_SH, gp_now_ms() - t0, 1);
            return s_vs[i].id;
        }
    }
    return 0;
}

/* Runs of draws share a program: compare with the last one (a memcmp)
 * before hashing it byte by byte. */
static uint32_t vs_get(const uint32_t (*prog)[4], uint32_t len, uint32_t mask)
{
    static uint32_t last[256][4], last_len, last_id;
    uint32_t id;
    if (last_id && len == last_len && same_bytes(prog, last, (size_t)len * 16))
        return last_id;
    id = vs_lookup(prog, len, mask);
    last_id = 0;
    if (id && len <= 256) {
        memcpy(last, prog, (size_t)len * 16);
        last_len = len;
        last_id = id;
    }
    return id;
}

static uint32_t ps_lookup(const GpPsKey *k)
{
    uint64_t key = fnv_wide(k, sizeof *k, FNV0) | 1;
    uint32_t slot = (uint32_t)key & (SH_HASH - 1), p;
    int n;
    for (p = 0; p < SH_HASH; p++) {
        uint32_t i = (slot + p) & (SH_HASH - 1);
        if (s_ps[i].key == key) return s_ps[i].id;
        if (!s_ps[i].key) {
            double t0 = s_timing > 0 ? gp_now_ms() : 0;
            n = gpu_gen_ps(k, s_hlsl, sizeof s_hlsl);
            if (n < 0) return 0;
            s_ps[i].key = key;
            s_ps[i].id = s_next_id++;
            q_cmd(GP_SHADER_PS, s_ps[i].id, 0, 0, 0, 0, 0, s_hlsl, (uint32_t)n + 1);
#ifndef __wasm__
            gp_d3d11_prefetch_shader(1, 0, s_hlsl, (size_t)n);
#endif
            gp_wgsl_note_ps(s_ps[i].id, k);
            if (s_timing > 0) gp_time_add(GP_T_REC_SH, gp_now_ms() - t0, 1);
            return s_ps[i].id;
        }
    }
    return 0;
}

/* Runs of draws share a combiner setup: the last key first. */
static uint32_t ps_get(const GpPsKey *k)
{
    static GpPsKey last;
    static uint32_t last_id;
    uint32_t id;
    if (last_id && same_bytes(k, &last, sizeof last))
        return last_id;
    id = ps_lookup(k);
    last_id = id;
    if (id) last = *k;
    return id;
}


/* ---- vertex-level check (RECOMP_GPU_CHECK) --------------------------------
 *
 * While the executor checks a frame, each vertex-program draw also has up to
 * GP_PROBE_MAX of its vertices run through the CPU interpreter
 * (nv2a_vsh_run, the reference gpu_shadergen mirrors) here, at record time
 * when the program and constants are the ones the draw uses, and through the
 * generated HLSL on the GPU (stream output) once the draw has been synced.
 * The CPU result goes through the same screen-to-clip mapping the HLSL's
 * finish() applies, so both sides are the vertex shader's output. */
static struct {
    uint32_t n, vs, hash, slots;
    GpXfConsts xc;
    GpVsConsts vc;
    GpProgVertex in[GP_PROBE_MAX];
    uint32_t idx[GP_PROBE_MAX];
    float cpu[GP_PROBE_MAX][GP_PROBE_FLOATS];
} s_probe;
static uint32_t s_probe_draws, s_probe_verts, s_probe_bad_draws, s_probe_bad_verts;

/* fog_factor() in nv2a_pb_exec.c, as the HLSL has it. */
static float probe_fog(const GpXfConsts *x, float d)
{
    float f;
    int m = (int)x->fog_mode;
    if (x->fog_on < 0.5f) return 1.0f;
    if (m == 0x800 || m == 0x802) f = x->fog_p0 + exp2f(d * x->fog_p1 * 16.0f) - 1.5f;
    else if (m == 0x801 || m == 0x803) f = x->fog_p0 + exp2f(-d * d * x->fog_p1 * x->fog_p1 * 32.0f) - 1.5f;
    else f = x->fog_p0 + d * x->fog_p1 - 1.0f;
    if (m == 0x802 || m == 0x803 || m == 0x804) f = fabsf(f);
    if (f != f) f = 1.0f;
    return f < 0.0f ? 0.0f : (f > 1.0f ? 1.0f : f);
}

static float sat(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

static void probe_prepare(const Nv2aDraw *dd, const GpXfConsts *xc, uint32_t vs)
{
    uint32_t i, n = dd->vertex_count < GP_PROBE_MAX ? dd->vertex_count : GP_PROBE_MAX;
    s_probe.n = 0;
    s_probe.vs = vs;
    s_probe.slots = dd->program_len;
    s_probe.hash = (uint32_t)fnv(dd->program, (size_t)dd->program_len * 16, FNV0);
    s_probe.xc = *xc;
    memcpy(&s_probe.vc, dd->constants, sizeof s_probe.vc);
    for (i = 0; i < n; i++) {
        uint32_t v = (uint32_t)(((uint64_t)i * dd->vertex_count) / n), k, st, a;
        Nv2aVshOutput o;
        float *c = s_probe.cpu[i], x, y, w;
        s_probe.idx[i] = v;
        /* The packed inputs back in their registers; the program reads no
         * others, so those stay 0. */
        memset(s_probe.in[i].v, 0, sizeof s_probe.in[i].v);
        for (a = k = 0; a < 16; a++)
            if (dd->input_mask & (1u << a))
                memcpy(s_probe.in[i].v[a], dd->inputs[(size_t)v * dd->input_count + k++], 16);
        if (!nv2a_vsh_run((const float (*)[4])s_probe.in[i].v, &o))
            return;
        /* transform_vertex(): +0 w draws at w = 1; oPos is in logical pixels. */
        if (o.pos[3] == 0.0f && !signbit(o.pos[3])) o.pos[3] = 1.0f;
        x = o.pos[0] * xc->aa[0]; y = o.pos[1] * xc->aa[1]; w = o.pos[3];
        c[0] = (x / xc->surf[0] * 2.0f - 1.0f) * w;
        c[1] = (1.0f - y / xc->surf[1] * 2.0f) * w;
        c[2] = sat(o.pos[2] * xc->zscale) * w;
        c[3] = w;
        for (k = 0; k < 4; k++) { c[4 + k] = o.d0[k]; c[8 + k] = o.d1[k]; }
        for (st = 0; st < 4; st++) {
            c[12 + st * 4 + 0] = o.tex[st][0] * xc->uvscale[st][0];
            c[12 + st * 4 + 1] = o.tex[st][1] * xc->uvscale[st][1];
            c[12 + st * 4 + 2] = o.tex[st][2];
            c[12 + st * 4 + 3] = o.tex[st][3];
        }
        c[28] = probe_fog(xc, o.fog[0]);
    }
    s_probe.n = n;
}

static const char *probe_name(int k)
{
    static const char *n[] = { "pos", "d0", "d1", "t0", "t1", "t2", "t3", "fog" };
    return n[k / 4 > 7 ? 7 : k / 4];
}

static void probe_compare(void)
{
    static float gpu[GP_PROBE_MAX * GP_PROBE_FLOATS];
    uint32_t n = gp_d3d11_vs_probe(s_probe.vs, &s_probe.xc, &s_probe.vc, s_probe.in,
                                   s_probe.n, gpu), i, k, bad = 0;
    float worst = 0.0f;
    int wi = -1, wk = 0;

    s_probe_draws++;
    if (n != s_probe.n) {
        nv2a_check_note("  vtx: program %08X: stream output failed (%u of %u)\n",
                        s_probe.hash, n, s_probe.n);
        return;
    }
    for (i = 0; i < n; i++) {
        int vbad = 0;
        for (k = 0; k < GP_PROBE_FLOATS; k++) {
            float a = s_probe.cpu[i][k], b = gpu[i * GP_PROBE_FLOATS + k], d, m;
            if (a != a && b != b) continue;            /* both NaN */
            d = fabsf(a - b);
            m = fmaxf(fabsf(a), fabsf(b));
            if (!(d <= 1e-3f + 2e-4f * m)) {           /* NaN on one side fails too */
                float r = d / (1e-3f + 2e-4f * m);
                vbad = 1;
                if (!(r <= worst)) { worst = r; wi = (int)i; wk = (int)k; }
            }
        }
        bad += (uint32_t)vbad;
    }
    s_probe_verts += n;
    if (bad) {
        s_probe_bad_draws++;
        s_probe_bad_verts += bad;
        nv2a_check_note("  vtx: program %08X (%u slots): %u of %u vertices differ; worst v%u %s.%c"
                        " cpu %g gpu %g\n", s_probe.hash, s_probe.slots, bad, n,
                        s_probe.idx[wi], probe_name(wk), "xyzw"[wk & 3],
                        s_probe.cpu[wi][wk], gpu[wi * GP_PROBE_FLOATS + wk]);
    }
}

/* ---- records ------------------------------------------------------------- */

static float zscale_of(uint32_t zf) { return zf == 1 ? 1.0f / 65535.0f : 1.0f / 16777215.0f; }

static void state_of(const Nv2aRenderState *rs, GpState *s)
{
    s->blend_en = rs->blend_enable; s->blend_src = rs->blend_src; s->blend_dst = rs->blend_dst;
    s->blend_eq = rs->blend_eq; s->blend_color = rs->blend_color;
    s->color_mask = rs->color_mask;
    s->depth_test = rs->depth_test_enable; s->depth_func = rs->depth_func;
    s->depth_write = rs->depth_write;
    s->stencil_en = rs->stencil_enable; s->stencil_func = rs->stencil_func;
    s->stencil_ref = rs->stencil_ref; s->stencil_fmask = rs->stencil_func_mask;
    s->stencil_wmask = rs->stencil_write_mask; s->stencil_fail = rs->stencil_fail;
    s->stencil_zfail = rs->stencil_zfail; s->stencil_zpass = rs->stencil_zpass;
}

static GpDraw *new_draw(uint32_t kind, const Nv2aSurface *s, const Nv2aRenderState *rs,
                        const Rt **rt_out)
{
    const Rt *r = rt_get(s);
    GpDraw *d;
    if (!r) return NULL;
    if (!(d = (GpDraw *)buf_take(&s_draws, sizeof *d, 4))) return NULL;
    memset(d, 0, sizeof *d);
    d->kind = kind;
    d->target = r->id;
    d->target_swz = r->swz;
    d->zeta = rs->zeta_va ? ds_get(rs->zeta_va, r->w, r->h) : 0;
    d->zeta_format = s->zeta_format;
    state_of(rs, &d->st);
    d->vsc_off = d->xfc_off = d->psc_off = ~0u;
    {
        const uint32_t *q = kind == GP_CLEAR ? rs->clear_rect : rs->scissor;
        uint32_t x0 = q[0], y0 = q[1], x1 = q[2], y1 = q[3];
        if (x1 > r->w) x1 = r->w;
        if (y1 > r->h) y1 = r->h;
        if (x0 > x1) x0 = x1;
        if (y0 > y1) y0 = y1;
        d->rect[0] = x0 | y0 << 16;
        d->rect[1] = x1 | y1 << 16;
    }
    *rt_out = r;
    return d;
}

/* Consecutive draws mostly carry the same blocks (one surface, one combiner
 * setup): a block equal to the last one of its size is shared, so the
 * back end sees the same offset and skips the upload. */
static uint32_t put_consts(const void *p, uint32_t bytes)
{
    static struct { uint32_t bytes, off, epoch; } last[4];
    uint32_t k;
    void *dst;
    for (k = 0; k < 4 && last[k].bytes && last[k].bytes != bytes; k++) ;
    if (k < 4 && last[k].bytes == bytes && last[k].epoch == s_epoch
        && same_bytes(s_consts.p + last[k].off, p, bytes))
        return last[k].off;
    if (!(dst = buf_take(&s_consts, bytes, 16))) return ~0u;
    memcpy(dst, p, bytes);
    if (k < 4) {
        last[k].bytes = bytes;
        last[k].off = (uint32_t)((uint8_t *)dst - s_consts.p);
        last[k].epoch = s_epoch;
    }
    return (uint32_t)((uint8_t *)dst - s_consts.p);
}

/* The VS constant file is 3 KB and usually unchanged between draws. */
static uint32_t put_vs_consts(const float (*c)[4])
{
    static uint32_t last_off = ~0u, last_epoch = ~0u;
    if (last_off != ~0u && last_epoch == s_epoch
        && same_bytes(s_consts.p + last_off, c, sizeof(GpVsConsts)))
        return last_off;
    last_off = put_consts(c, sizeof(GpVsConsts));
    last_epoch = s_epoch;
    return last_off;
}

static void unpack(uint32_t c, float o[4])
{
    o[0] = ((c >> 16) & 0xFF) / 255.0f; o[1] = ((c >> 8) & 0xFF) / 255.0f;
    o[2] = (c & 0xFF) / 255.0f;         o[3] = (c >> 24) / 255.0f;
}

static void rec_clear(const Nv2aSurface *s, const Nv2aRenderState *rs,
                      uint32_t flags, uint32_t argb, uint32_t zstencil)
{
    const Rt *r;
    GpDraw *d = new_draw(GP_CLEAR, s, rs, &r);
    if (!d) return;
    d->clr_flags = flags; d->clr_argb = argb; d->clr_zs = zstencil;
}

/* Screen-space batches (menus, HUD): as milestone 1, stage 0 only. */
static void rec_draw(const Nv2aSurface *s, const Nv2aBatch *b)
{
    const Rt *r;
    GpDraw *d;
    GpTvConsts tc;
    void *v;

    if (!b->count || !(d = new_draw(GP_DRAW, s, b->state, &r))) return;
    d->vs = GP_VS_TVERT;
    d->ps = GP_PS_TVERT;
    memset(&tc, 0, sizeof tc);
    tc.surf[0] = (float)r->w; tc.surf[1] = (float)r->h;
    tc.zscale = zscale_of(s->zeta_format);
    tc.texsize[0] = tc.texsize[1] = 1.0f;
    if (b->texture) {
        const Rt *src = rt_find_tex(b->texture);
        int bc, full;
        d->tex[0] = rt_tex(b->texture, &full);
        if (!d->tex[0])
            d->tex[0] = tex_get(b->texture, 0, &bc);
        if (d->tex[0]) {
            tc.textured = 1.0f;
            /* Coordinates arrive in texels; a render target (possibly wider
             * than the texture rect: pitch-wide) normalises by its own size. */
            tc.texsize[0] = src ? (float)src->w : (float)b->texture->width;
            tc.texsize[1] = src ? (float)src->h : (float)b->texture->height;
            d->smp[0] = ((((b->texture->filter >> 24) & 0xF) == 1) ? 0 : GP_SMP_LINEAR)
                      | GP_SMP_U(b->texture->addr_u) | GP_SMP_V(b->texture->addr_v);
        }
    }
    if (b->state->alpha_test_enable) {
        tc.alpha_func = (float)((b->state->alpha_func & 0xF) + 1);
        tc.alpha_ref = (float)(b->state->alpha_ref & 0xFF);
    }
    d->xfc_off = put_consts(&tc, sizeof tc);
    if (!(v = vtx_take(b->count * sizeof(GpTVertex), 16))) return;
    memcpy(v, b->vertices, b->count * sizeof(GpTVertex));
    d->vtx_off = (uint32_t)((uint8_t *)v - s_vtx.p);
    d->vtx_count = b->count;
    d->vtx_stride = sizeof(GpTVertex);
}

/* The vertex arena: when growing it moves it, inputs the executor was
 * given room for earlier may not be passed again (its input reuse). */
static void *vtx_take(uint32_t bytes, uint32_t align)
{
    uint8_t *was = s_vtx.p;
    void *v = buf_take(&s_vtx, bytes, align);
    if (s_vtx.p != was)
        nv2a_backend_storage_reset();
    return v;
}

/* Nv2aBackend.draw2_input_space: the executor fetches the next draw2's
 * program inputs straight into the vertex arena, and rec_draw2 keeps them
 * where they are instead of copying them (10-16 MB a frame in 4-player split
 * screen). Room a batch does not submit stays unused until the flip. */
static void *s_vtx_room;
static uint32_t s_vtx_room_bytes;

static void *rec_input_space(uint32_t bytes)
{
    s_vtx_room = vtx_take(bytes, 16);
    s_vtx_room_bytes = bytes;
    return s_vtx_room;
}

static void rec_draw2(const Nv2aSurface *s, const Nv2aRenderState *rs, const Nv2aDraw *dd)
{
    const Rt *r;
    GpDraw *d;
    GpXfConsts xc;
    GpPsConsts pc;
    GpPsKey key;
    int st, i;
    void *v;

    if (!(d = new_draw(GP_DRAW, s, rs, &r))) return;
    memset(&xc, 0, sizeof xc);
    memset(&pc, 0, sizeof pc);
    memset(&key, 0, sizeof key);

    xc.surf[0] = (float)r->w; xc.surf[1] = (float)r->h;
    xc.zscale = zscale_of(s->zeta_format);
    xc.near_z = dd->near_z;
    xc.aa[0] = dd->aa_sx; xc.aa[1] = dd->aa_sy;
    xc.fog_on = (float)(dd->fog_enable != 0);
    xc.fog_mode = (float)dd->fog_mode;
    xc.fog_p0 = dd->fog_param[0]; xc.fog_p1 = dd->fog_param[1];

    for (st = 0; st < 4; st++) {
        const Nv2aTexture *t = &dd->tex[st];
        uint32_t mode = (dd->rc.stage_program >> (st * 5)) & 0x1F;
        int wanted = dd->rc_seen ? (mode >= 1 && mode <= 3) : (st == 0 && dd->textured);
        int cube = dd->rc_seen && mode == 3 && dd->tex_cube[st];
        int bc;
        uint32_t au, av;

        xc.uvscale[st][0] = xc.uvscale[st][1] = 1.0f;
        if (!wanted || !dd->tex_valid[st]) continue;
        {
            const Rt *src = cube ? NULL : rt_find_tex(t);
            int full = 0;
            uint32_t sub = cube ? 0 : rt_tex(t, &full);
            if (sub && !full) {
                d->tex[st] = sub;                  /* a tile: sized like the texture */
                if (!size_from_format(t->color)) {
                    xc.uvscale[st][0] = 1.0f / (float)t->width;
                    xc.uvscale[st][1] = 1.0f / (float)t->height;
                }
            } else if (src) {
                d->tex[st] = GP_TEX_RT | src->id;
                xc.uvscale[st][0] = (size_from_format(t->color) ? (float)t->width : 1.0f) / (float)src->w;
                xc.uvscale[st][1] = (size_from_format(t->color) ? (float)t->height : 1.0f) / (float)src->h;
            } else {
                d->tex[st] = tex_get(t, cube, &bc);
                if (!size_from_format(t->color) && !cube) {
                    xc.uvscale[st][0] = 1.0f / (float)t->width;
                    xc.uvscale[st][1] = 1.0f / (float)t->height;
                }
            }
        }
        if (!d->tex[st]) continue;
        key.valid |= 1u << st;
        if (cube) key.cube |= 1u << st;
        au = t->addr_u; av = t->addr_v;
        d->smp[st] = smp_key(t, dd->tex_border_color[st] && (au == 4 || av == 4));
        d->border[st] = dd->tex_border[st];
    }

    key.rc_seen = dd->rc_seen;
    key.textured = dd->textured;
    if (dd->rc_seen) {
        uint32_t n = dd->rc.control & 0xFF;
        if (n > 8) n = 8;
        for (i = 0; i < (int)n; i++) {
            key.color_icw[i] = dd->rc.color_icw[i]; key.alpha_icw[i] = dd->rc.alpha_icw[i];
            key.color_ocw[i] = dd->rc.color_ocw[i]; key.alpha_ocw[i] = dd->rc.alpha_ocw[i];
        }
        key.final0 = dd->rc.final0; key.final1 = dd->rc.final1;
        key.control = dd->rc.control; key.stage_program = dd->rc.stage_program;
        key.clip_plane_mode = dd->clip_plane_mode;
        for (i = 0; i < 8; i++) {
            unpack(dd->rc.factor0[i], pc.f0[i]);
            unpack(dd->rc.factor1[i], pc.f1[i]);
        }
        unpack(dd->rc.final_c0, pc.fc0);
        unpack(dd->rc.final_c1, pc.fc1);
        /* FOG_COLOR is R in bits 0-7, the reverse of a D3DCOLOR. */
        unpack(dd->fog_color, pc.fogc);
        { float t = pc.fogc[0]; pc.fogc[0] = pc.fogc[2]; pc.fogc[2] = t; }
    }
    pc.alpha_on = (float)(rs->alpha_test_enable != 0);
    pc.alpha_func = (float)rs->alpha_func;
    pc.alpha_ref = (float)(rs->alpha_ref & 0xFF);
    pc.clip_mode = (float)dd->clip_plane_mode;
    d->ps = ps_get(&key);
    d->psc_off = put_consts(&pc, sizeof pc);
    d->xfc_off = put_consts(&xc, sizeof xc);

    if (dd->program_len) {
        uint32_t *ix;
        d->vs = vs_get(dd->program, dd->program_len, dd->input_mask);
        d->vsc_off = put_vs_consts(dd->constants);
        if (d->vs && nv2a_check_active())
            probe_prepare(dd, &xc, d->vs);
        /* Only the inputs the program reads, packed in register order, as
         * the executor fetched them (the VS declares just those: HLSL
         * gpu_gen_vs_program, WGSL gpu_vs_input_mask). A race reads 3-6 of
         * the 16, so the arena, the upload and the GPU's read shrink 3-5x. */
        {
            uint32_t bytes = dd->vertex_count * dd->input_count * 16;
            const uint8_t *in = (const uint8_t *)dd->inputs;
            if (s_vtx_room && (const void *)in == s_vtx_room
                && s_vtx_room_bytes == bytes) {
                v = s_vtx_room;                /* fetched in place (rec_input_space) */
            } else if (in >= s_vtx.p && in + bytes <= s_vtx.p + s_vtx.n) {
                v = (void *)in;                /* an earlier draw's, reused (executor d2_key) */
            } else {
                if (!(v = vtx_take(bytes, 16))) return;
                memcpy(v, dd->inputs, bytes);
            }
            s_vtx_room = NULL;
            d->vtx_stride = dd->input_count * 16;
        }
        d->vtx_off = (uint32_t)((uint8_t *)v - s_vtx.p);
        d->vtx_count = dd->vertex_count;
        if (!(ix = (uint32_t *)buf_take(&s_idx, dd->index_count * 4, 4))) return;
        memcpy(ix, dd->indices, dd->index_count * 4);
        d->idx_off = (uint32_t)(ix - (uint32_t *)s_idx.p);
        d->idx_count = dd->index_count;
    } else {
        d->vs = GP_VS_PASSTHRU;
        if (!(v = vtx_take(dd->xf_count * sizeof(GpXfVertex), 16))) return;
        memcpy(v, dd->xf, dd->xf_count * sizeof(GpXfVertex));
        d->vtx_off = (uint32_t)((uint8_t *)v - s_vtx.p);
        d->vtx_count = dd->xf_count;
        d->vtx_stride = sizeof(GpXfVertex);
    }
    if (!d->vs || !d->ps)
        d->kind = ~0u;                       /* shader failed: skip, logged below */
}

static void frame_of(GpFrame *f)
{
    f->queue = s_queue.p; f->queue_bytes = s_queue.n;
    f->draws = (const GpDraw *)s_draws.p; f->draw_count = s_draws.n / sizeof(GpDraw);
    f->vtx = s_vtx.p; f->vtx_bytes = s_vtx.n;
    f->idx = (const uint32_t *)s_idx.p; f->idx_count = s_idx.n / 4;
    f->consts = s_consts.p; f->const_bytes = s_consts.n;
    f->frame = s_frame;
}

/* The executor's GPU-vs-CPU check: everything recorded so far, drawn now. */
static void rec_sync(void)
{
    static uint32_t last_frame = ~0u;
    GpFrame f;
    if (last_frame != s_frame) {             /* first sync of a checked frame */
        last_frame = s_frame;
        gp_d3d11_writeback_swizzled();
    }
    frame_of(&f);
    gp_d3d11_sync(&f);
    if (s_probe.n) {
        probe_compare();
        s_probe.n = 0;
    }
    s_queue.n = s_draws.n = s_vtx.n = s_idx.n = s_consts.n = 0;
    s_vtx_room = NULL;
    s_epoch++;
}

static void rec_flip(void)
{
    GpFrame f;
    int i, k;

    if (s_frame % 15 == 14) ver_sweep();
    if (s_frame % 600 == 599 && s_ver_made) {
        fprintf(stderr, "  [GPUREC] textures in 600 frames: %u created, %u rebound from earlier contents,"
                " %u freed; %u KB of earlier contents held\n", s_ver_made, s_ver_hits, s_ver_freed,
                (unsigned)(s_ver_old_bytes >> 10));
        s_ver_made = s_ver_hits = s_ver_freed = 0;
    }
    /* Texture ids replaced three or more frames ago can go now. */
    for (i = k = 0; i < s_nfree; i++) {
        if (s_frame - s_free[i].frame >= 3)
            q_cmd(GP_TEX_FREE, s_free[i].id, 0, 0, 0, 0, 0, NULL, 0);
        else
            s_free[k++] = s_free[i];
    }
    s_nfree = k;

    frame_of(&f);
    if (s_timing < 0) timing_init();
    {
        double t0 = s_timing ? gp_now_ms() : 0;
        gp_backend_flip(&f);      /* D3D11, or wgpu; captures (gpu_wgsl_tap.c) */
        if (s_timing) timing_frame(s_frame, t0, gp_now_ms(), f.draw_count);
    }
    /* The consumer wrote this frame's targets back: remember what the guest
     * now holds, so a later CPU write to them can be told apart. */
    for (i = 0; i < s_nrt; i++)
        if (s_rt[i].used_frame == s_frame && rt_syncable(&s_rt[i]))
            s_rt[i].guest_hash = rt_guest_hash(&s_rt[i]);
    if (s_frame % 600 == 599 && s_rt_resyncs) {
        fprintf(stderr, "  [GPUREC] %u render target resyncs from guest memory in 600 frames\n",
                s_rt_resyncs);
        s_rt_resyncs = 0;
    }

    if (s_probe_draws) {
        fprintf(stderr, "  [GPUREC] vertex check: %u draws, %u vertices; %u draws and %u vertices"
                " differ\n", s_probe_draws, s_probe_verts, s_probe_bad_draws, s_probe_bad_verts);
        s_probe_draws = s_probe_verts = s_probe_bad_draws = s_probe_bad_verts = 0;
    }
    s_queue.n = s_draws.n = s_vtx.n = s_idx.n = s_consts.n = 0;
    s_vtx_room = NULL;
#if defined(__wasm__)
    bufs_swap();                  /* the page may still be reading this set */
    s_queue.n = s_draws.n = s_vtx.n = s_idx.n = s_consts.n = 0;
#endif
    s_epoch++;
    s_frame++;
    { extern void atv2_freeride_frame(void); atv2_freeride_frame(); }
    { extern void atv2_control_frame(unsigned); atv2_control_frame((unsigned)f.draw_count); }
}

static Nv2aBackend s_backend = { rec_clear, rec_draw, rec_flip, rec_draw2, rec_sync, rec_input_space };

void atv2_gpu_backend_install(void)
{
    const char *e = getenv("RECOMP_GPU");
    if (!e || !*e || *e == '0')
        return;
    s_simple = !strcmp(e, "simple");
    if (s_simple)
        s_backend.draw2 = NULL;
    nv2a_backend_register(&s_backend);
    fprintf(stderr, "[BOOT] GPU recorder registered (RECOMP_GPU=%s): %s\n", e,
            s_simple ? "CPU transform, stage 0 only"
                     : "vertex programs and combiners on the GPU");
#ifndef __wasm__
    {   /* RECOMP_RES_SCALE / RECOMP_MSAA / RECOMP_WIDESCREEN (gpu_display.h) */
        extern void gp_display_install(void);
        gp_display_install();
    }
#endif
}
