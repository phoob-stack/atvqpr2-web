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
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "nv2a_backend.h"
#include "d3d8_swizzle.h"
#include "gpu_proto.h"
#include "gpu_shadergen.h"

extern ptrdiff_t xbox_GetMemoryOffset(void);

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
/* One id space for every resource -- render targets, depth, textures and
 * shaders -- above the built-in shader ids, never reused. */
static uint32_t s_frame, s_next_id = 64;
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

/* Ids whose contents were replaced: freed three frames later. */
#define MAX_FREE 4096
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
    uint32_t offset, w, h, color, pitch, cube, used;
    uint32_t id, checked_frame;
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
    if (n <= 16384) return fnv(p, n, h);
    h = fnv(p, 4096, h);
    for (i = 4096; i + 4096 < n; i += 64) { h ^= p[i] | (uint32_t)p[i + 1] << 8; h *= 1099511628211ull; }
    return fnv(p + n - 4096, 4096, h);
}

static uint32_t tex_get(const Nv2aTexture *t, int cube, int *is_bc)
{
    const uint8_t *mem = (const uint8_t *)xbox_GetMemoryOffset();
    uint32_t bb = d3d8_format_dxt_block_bytes(t->color), faces = cube ? 6 : 1, f;
    uint32_t l0 = level0_bytes(t), stride = cube ? face_stride(t) : 0;
    uint64_t key = fnv(t, sizeof *t, FNV0) ^ (uint64_t)cube, h = FNV0;
    uint32_t slot = (uint32_t)(key ^ (key >> 32)) & (TEX_HASH - 1), probe;
    Tex *e = NULL, *victim = NULL;
    int bc = bb && (t->width & 3) == 0 && (t->height & 3) == 0;

    *is_bc = bc;
    if (!t->offset || !t->width || !t->height || t->width > 4096 || t->height > 4096 || !l0)
        return 0;
    for (probe = 0; probe < 16; probe++) {
        Tex *c = &s_tex[(slot + probe) & (TEX_HASH - 1)];
        if (c->id && c->offset == t->offset && c->w == t->width && c->h == t->height
            && c->color == t->color && c->pitch == t->pitch && c->cube == (uint32_t)cube) {
            e = c; break;
        }
        if (!victim || !c->id || (victim->id && c->used < victim->used)) victim = c;
    }
    if (e && e->checked_frame == s_frame) { e->used = s_frame; return e->id; }
    for (f = 0; f < faces; f++)
        h = hash_span(mem + t->offset + f * stride, l0, h);
    if (e && e->hash == h) { e->checked_frame = e->used = s_frame; return e->id; }

    if (!e) e = victim;
    defer_free(e->id);                           /* old contents: free later */
    memset(e, 0, sizeof *e);
    e->id = s_next_id++;
    e->offset = t->offset; e->w = t->width; e->h = t->height;
    e->color = t->color; e->pitch = t->pitch; e->cube = (uint32_t)cube;
    e->hash = h; e->checked_frame = e->used = s_frame;

    if (bc) {
        uint8_t *p = (uint8_t *)q_cmd_reserve(GP_TEX_CREATE, e->id, 0, t->width, t->height,
                                              t->color == 0x0C ? GP_FMT_BC1
                                              : t->color == 0x0E ? GP_FMT_BC2 : GP_FMT_BC3,
                                              faces, l0 * faces);
        if (p)
            for (f = 0; f < faces; f++)
                memcpy(p + f * l0, mem + t->offset + f * stride, l0);
    } else {
        uint32_t px = t->width * t->height;
        uint32_t *p = (uint32_t *)q_cmd_reserve(GP_TEX_CREATE, e->id, 0, t->width, t->height,
                                                GP_FMT_BGRA8, faces, px * 4 * faces);
        for (f = 0; p && f < faces; f++) {
            Nv2aTexture face = *t;
            face.offset += f * stride;
            if (!nv2a_backend_decode_texture(&face, p + (size_t)f * px)) {
                /* Not decodable (palettised, say): as the CPU, read white. */
                static uint32_t seen[64];
                static int nseen;
                int k;
                memset(p + (size_t)f * px, 0xFF, (size_t)px * 4);
                for (k = 0; k < nseen && seen[k] != t->color; k++) ;
                if (k == nseen && nseen < 64) {
                    seen[nseen++] = t->color;
                    fprintf(stderr, "  [GPUREC] texture format 0x%02X (%ux%u at 0x%08X%s) not decodable: white\n",
                            t->color, t->width, t->height, t->offset, cube ? ", cube" : "");
                }
            }
        }
    }
    return e->id;
}

/* ---- shaders ------------------------------------------------------------- */

#define SH_HASH 2048
static struct { uint64_t key; uint32_t id; } s_vs[SH_HASH], s_ps[SH_HASH];
static char s_hlsl[256 * 1024];

static uint32_t vs_get(const uint32_t (*prog)[4], uint32_t len)
{
    uint64_t key = fnv(prog, (size_t)len * 16, FNV0) | 1;
    uint32_t slot = (uint32_t)key & (SH_HASH - 1), p;
    int n;
    for (p = 0; p < SH_HASH; p++) {
        uint32_t i = (slot + p) & (SH_HASH - 1);
        if (s_vs[i].key == key) return s_vs[i].id;
        if (!s_vs[i].key) {
            n = gpu_gen_vs_program(prog, len, s_hlsl, sizeof s_hlsl);
            if (n < 0) return 0;
            s_vs[i].key = key;
            s_vs[i].id = s_next_id++;
            q_cmd(GP_SHADER_VS, s_vs[i].id, len, 0, 0, 0, 0, s_hlsl, (uint32_t)n + 1);
            return s_vs[i].id;
        }
    }
    return 0;
}

static uint32_t ps_get(const GpPsKey *k)
{
    uint64_t key = fnv(k, sizeof *k, FNV0) | 1;
    uint32_t slot = (uint32_t)key & (SH_HASH - 1), p;
    int n;
    for (p = 0; p < SH_HASH; p++) {
        uint32_t i = (slot + p) & (SH_HASH - 1);
        if (s_ps[i].key == key) return s_ps[i].id;
        if (!s_ps[i].key) {
            n = gpu_gen_ps(k, s_hlsl, sizeof s_hlsl);
            if (n < 0) return 0;
            s_ps[i].key = key;
            s_ps[i].id = s_next_id++;
            q_cmd(GP_SHADER_PS, s_ps[i].id, 0, 0, 0, 0, 0, s_hlsl, (uint32_t)n + 1);
            return s_ps[i].id;
        }
    }
    return 0;
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
    *rt_out = r;
    return d;
}

static uint32_t put_consts(const void *p, uint32_t bytes)
{
    void *dst = buf_take(&s_consts, bytes, 16);
    if (!dst) return ~0u;
    memcpy(dst, p, bytes);
    return (uint32_t)((uint8_t *)dst - s_consts.p);
}

/* The VS constant file is 3 KB and usually unchanged between draws. */
static uint32_t put_vs_consts(const float (*c)[4])
{
    static uint32_t last_off = ~0u, last_frame = ~0u;
    if (last_off != ~0u && last_frame == s_frame
        && !memcmp(s_consts.p + last_off, c, sizeof(GpVsConsts)))
        return last_off;
    last_off = put_consts(c, sizeof(GpVsConsts));
    last_frame = s_frame;
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
        const Rt *src = rt_find(b->texture->offset);
        int bc;
        if (src)
            d->tex[0] = GP_TEX_RT | src->id;
        else
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
    if (!(v = buf_take(&s_vtx, b->count * sizeof(GpTVertex), 16))) return;
    memcpy(v, b->vertices, b->count * sizeof(GpTVertex));
    d->vtx_off = (uint32_t)((uint8_t *)v - s_vtx.p);
    d->vtx_count = b->count;
    d->vtx_stride = sizeof(GpTVertex);
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
        uint32_t lin, au, av;

        xc.uvscale[st][0] = xc.uvscale[st][1] = 1.0f;
        if (!wanted || !dd->tex_valid[st]) continue;
        {
            const Rt *src = cube ? NULL : rt_find(t->offset);
            if (src) {
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
        /* rc_texel(): tent when MAG is 2 or MIN is 2/4/6, else nearest. */
        {
            uint32_t mag = (t->filter >> 24) & 0xF, min = (t->filter >> 16) & 0xFF;
            lin = (mag == 2 || min == 2 || min == 4 || min == 6) ? GP_SMP_LINEAR : 0;
        }
        au = t->addr_u; av = t->addr_v;
        d->smp[st] = lin | GP_SMP_U(au) | GP_SMP_V(av)
                   | ((dd->tex_border_color[st] && (au == 4 || av == 4)) ? GP_SMP_BORDER : 0);
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
        d->vs = vs_get(dd->program, dd->program_len);
        d->vsc_off = put_vs_consts(dd->constants);
        if (!(v = buf_take(&s_vtx, dd->vertex_count * sizeof(GpProgVertex), 16))) return;
        memcpy(v, dd->inputs, dd->vertex_count * sizeof(GpProgVertex));
        d->vtx_off = (uint32_t)((uint8_t *)v - s_vtx.p);
        d->vtx_count = dd->vertex_count;
        d->vtx_stride = sizeof(GpProgVertex);
        if (!(ix = (uint32_t *)buf_take(&s_idx, dd->index_count * 4, 4))) return;
        memcpy(ix, dd->indices, dd->index_count * 4);
        d->idx_off = (uint32_t)(ix - (uint32_t *)s_idx.p);
        d->idx_count = dd->index_count;
    } else {
        d->vs = GP_VS_PASSTHRU;
        if (!(v = buf_take(&s_vtx, dd->xf_count * sizeof(GpXfVertex), 16))) return;
        memcpy(v, dd->xf, dd->xf_count * sizeof(GpXfVertex));
        d->vtx_off = (uint32_t)((uint8_t *)v - s_vtx.p);
        d->vtx_count = dd->xf_count;
        d->vtx_stride = sizeof(GpXfVertex);
    }
    if (!d->vs || !d->ps)
        d->kind = ~0u;                       /* shader failed: skip, logged below */
}

static void rec_flip(void)
{
    GpFrame f;
    int i, k;

    /* Texture ids replaced three or more frames ago can go now. */
    for (i = k = 0; i < s_nfree; i++) {
        if (s_frame - s_free[i].frame >= 3)
            q_cmd(GP_TEX_FREE, s_free[i].id, 0, 0, 0, 0, 0, NULL, 0);
        else
            s_free[k++] = s_free[i];
    }
    s_nfree = k;

    f.queue = s_queue.p; f.queue_bytes = s_queue.n;
    f.draws = (const GpDraw *)s_draws.p; f.draw_count = s_draws.n / sizeof(GpDraw);
    f.vtx = s_vtx.p; f.vtx_bytes = s_vtx.n;
    f.idx = (const uint32_t *)s_idx.p; f.idx_count = s_idx.n / 4;
    f.consts = s_consts.p; f.const_bytes = s_consts.n;
    f.frame = s_frame;
    gp_d3d11_consume(&f);
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

    s_queue.n = s_draws.n = s_vtx.n = s_idx.n = s_consts.n = 0;
    s_frame++;
}

static Nv2aBackend s_backend = { rec_clear, rec_draw, rec_flip, rec_draw2 };

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
}
