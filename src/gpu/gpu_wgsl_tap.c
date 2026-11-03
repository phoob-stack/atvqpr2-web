/*
 * The WebGPU tap: WGSL for every shader the recorder creates, the back-end
 * selector at the flip, and frame captures for the browser replay page.
 *
 *   RECOMP_GPU_DUMP_WGSL=dir   write every module the run generates:
 *                              vs_<id>.wgsl (portable), vs_<id>.cd.wgsl
 *                              (clip_distances variant), ps_<id>.wgsl, the
 *                              built-ins, and the HLSL twin of each (.hlsl)
 *   RECOMP_GPU_CAPTURE=dir     keep a shadow of the live resources and write
 *   RECOMP_GPU_CAPTURE_FRAMES=n,m,a-b/step   cap_<n>.gpf / .ref / .bmp for
 *                              those frames (see GpCapHeader), or
 *   RECOMP_GPU_CAPTURE_MIN_DRAWS=k  the first 8 frames with >= k records,
 *                              at least RECOMP_GPU_CAPTURE_EVERY (60) apart
 *   RECOMP_GPU_BACKEND=wgpu    draw with gpu_wgpu.c (only when built with
 *                              -DATV2_WGPU=ON; otherwise D3D11 and a warning)
 *   RECOMP_GPU_BACKEND=ab      draw every frame with both, D3D11 first, and
 *                              diff the last target WebGPU wrote back against
 *                              D3D11's (logged every 300 frames; the window
 *                              shows WebGPU's picture)
 *
 * The recorder's queue carries HLSL for the D3D11 back end. The WGSL lives
 * here, by shader id, so the D3D11 path is untouched; the browser build's
 * recorder will put this WGSL in the queue itself (as the captures do).
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <direct.h>
#endif

#include "gpu_proto.h"
#include "gpu_shadergen.h"
#include "gpu_shadergen_wgsl.h"

extern ptrdiff_t xbox_GetMemoryOffset(void);
#ifdef ATV2_WGPU
void gp_wgpu_consume(const GpFrame *f);
int  gp_wgpu_ready(void);
#endif

static int s_init, s_on;
static const char *s_dump_dir, *s_cap_dir;
static uint32_t s_cap_frames[64];
static int s_ncap_frames, s_wgpu;
static uint32_t s_cap_min_draws, s_cap_every = 60, s_cap_last = ~0u, s_cap_auto;
static uint32_t s_n_vs, s_n_ps, s_n_fail;

/* ---- WGSL by id ---------------------------------------------------------- */

typedef struct { char *src; uint32_t len; } Src;
static Src *s_vs_src, *s_ps_src;
static uint32_t s_nvs_src, s_nps_src;

static Src *slot(Src **t, uint32_t *n, uint32_t id)
{
    if (id >= *n) {
        uint32_t m = *n ? *n : 1024;
        Src *p;
        while (m <= id) m *= 2;
        if (!(p = (Src *)realloc(*t, m * sizeof *p))) return NULL;
        memset(p + *n, 0, (m - *n) * sizeof *p);
        *t = p; *n = m;
    }
    return &(*t)[id];
}

static void keep(int is_ps, uint32_t id, const char *src, int n)
{
    Src *s = is_ps ? slot(&s_ps_src, &s_nps_src, id) : slot(&s_vs_src, &s_nvs_src, id);
    if (!s || n < 0) return;
    free(s->src);
    s->src = (char *)malloc((size_t)n + 1);
    if (!s->src) { s->len = 0; return; }
    memcpy(s->src, src, (size_t)n + 1);
    s->len = (uint32_t)n;
}

const char *gp_wgsl_source(uint32_t id, int is_ps, uint32_t *len)
{
    Src *s = is_ps ? (id < s_nps_src ? &s_ps_src[id] : NULL) : (id < s_nvs_src ? &s_vs_src[id] : NULL);
    if (!s || !s->src) return NULL;
    if (len) *len = s->len;
    return s->src;
}

static void write_file(const char *name, const char *src, int n)
{
    char path[512];
    FILE *f;
    if (!s_dump_dir || n < 0) return;
    snprintf(path, sizeof path, "%s/%s", s_dump_dir, name);
    if ((f = fopen(path, "wb"))) { fwrite(src, 1, (size_t)n, f); fclose(f); }
}

static char s_buf[256 * 1024];

static void init(void)
{
    const char *e;
    int n;
    if (s_init) return;
    s_init = 1;
    s_dump_dir = getenv("RECOMP_GPU_DUMP_WGSL");
    if (s_dump_dir && !*s_dump_dir) s_dump_dir = NULL;
    s_cap_dir = getenv("RECOMP_GPU_CAPTURE");
    if (s_cap_dir && !*s_cap_dir) s_cap_dir = NULL;
    /* "600,1200" or ranges "6000-20000/1500" (every 1500th frame). */
    if ((e = getenv("RECOMP_GPU_CAPTURE_FRAMES"))) {
        while (*e && s_ncap_frames < 64) {
            char *end;
            unsigned long v = strtoul(e, &end, 10), hi, step = 1;
            if (end == e) { e++; continue; }
            e = end;
            hi = v;
            if (*e == '-') { hi = strtoul(e + 1, &end, 10); e = end; }
            if (*e == '/') { step = strtoul(e + 1, &end, 10); e = end; if (!step) step = 1; }
            for (; v <= hi && s_ncap_frames < 64; v += step)
                s_cap_frames[s_ncap_frames++] = (uint32_t)v;
        }
    }
    if ((e = getenv("RECOMP_GPU_CAPTURE_MIN_DRAWS"))) s_cap_min_draws = (uint32_t)strtoul(e, NULL, 10);
    if ((e = getenv("RECOMP_GPU_CAPTURE_EVERY"))) s_cap_every = (uint32_t)strtoul(e, NULL, 10);
    e = getenv("RECOMP_GPU_BACKEND");
    s_wgpu = e && !strcmp(e, "wgpu") ? 1 : e && !strcmp(e, "ab") ? 2 : 0;
#ifndef ATV2_WGPU
    if (s_wgpu) {
        fprintf(stderr, "  [GPUWEB] RECOMP_GPU_BACKEND=wgpu but this build has no WebGPU back end"
                        " (configure with -DATV2_WGPU=ON); using D3D11\n");
        s_wgpu = 0;
    }
#endif
    s_on = s_dump_dir || s_cap_dir || s_wgpu;
    if (!s_on) return;
#ifdef _WIN32
    if (s_dump_dir) _mkdir(s_dump_dir);
    if (s_cap_dir) _mkdir(s_cap_dir);
#endif
    /* The built-ins. */
    n = gpu_gen_vs_passthrough_wgsl(0, s_buf, sizeof s_buf);
    keep(0, GP_VS_PASSTHRU, s_buf, n); write_file("vs_1_passthru.wgsl", s_buf, n);
    n = gpu_gen_vs_passthrough_wgsl(GP_WGSL_CLIPDIST, s_buf, sizeof s_buf);
    write_file("vs_1_passthru.cd.wgsl", s_buf, n);
    n = gpu_gen_vs_passthrough(s_buf, sizeof s_buf);
    write_file("vs_1_passthru.hlsl", s_buf, n);
    n = gpu_gen_vs_tvert_wgsl(s_buf, sizeof s_buf);
    keep(0, GP_VS_TVERT, s_buf, n); write_file("vs_2_tvert.wgsl", s_buf, n);
    n = gpu_gen_ps_tvert_wgsl(s_buf, sizeof s_buf);
    keep(1, GP_PS_TVERT, s_buf, n); write_file("ps_1_tvert.wgsl", s_buf, n);
    fprintf(stderr, "  [GPUWEB] tap on:%s%s%s%s\n",
            s_dump_dir ? " WGSL dump to " : "", s_dump_dir ? s_dump_dir : "",
            s_cap_dir ? ", captures to " : "", s_cap_dir ? s_cap_dir : "");
}

void gp_wgsl_note_vs(uint32_t id, const uint32_t (*prog)[4], uint32_t len)
{
    char name[64];
    int n;
    init();
    if (!s_on) return;
    n = gpu_gen_vs_program_wgsl(prog, len, 0, s_buf, sizeof s_buf);
    if (n < 0) { s_n_fail++; return; }
    keep(0, id, s_buf, n);
    s_n_vs++;
    if (!s_dump_dir) return;
    snprintf(name, sizeof name, "vs_%u.wgsl", id); write_file(name, s_buf, n);
    n = gpu_gen_vs_program_wgsl(prog, len, GP_WGSL_CLIPDIST, s_buf, sizeof s_buf);
    snprintf(name, sizeof name, "vs_%u.cd.wgsl", id); write_file(name, s_buf, n);
    n = gpu_gen_vs_program(prog, len, s_buf, sizeof s_buf);
    snprintf(name, sizeof name, "vs_%u.hlsl", id); write_file(name, s_buf, n);
    /* The microcode, for offline regeneration and CPU reference checks. */
    snprintf(name, sizeof name, "vs_%u.vsh", id); write_file(name, (const char *)prog, (int)(len * 16));
}

void gp_wgsl_note_ps(uint32_t id, const GpPsKey *k)
{
    char name[64];
    int n;
    init();
    if (!s_on) return;
    n = gpu_gen_ps_wgsl(k, s_buf, sizeof s_buf);
    if (n < 0) { s_n_fail++; return; }
    keep(1, id, s_buf, n);
    s_n_ps++;
    if (!s_dump_dir) return;
    snprintf(name, sizeof name, "ps_%u.wgsl", id); write_file(name, s_buf, n);
    n = gpu_gen_ps(k, s_buf, sizeof s_buf);
    snprintf(name, sizeof name, "ps_%u.hlsl", id); write_file(name, s_buf, n);
    snprintf(name, sizeof name, "ps_%u.key", id); write_file(name, (const char *)k, (int)sizeof *k);
}

/* ---- capture: a shadow of every live resource ---------------------------- */

typedef struct { GpCmd c; uint8_t *payload; } Live;   /* c.op == 0: none */
static Live *s_live;
static uint32_t s_nlive;

static Live *live(uint32_t id)
{
    if (id >= s_nlive) {
        uint32_t m = s_nlive ? s_nlive : 4096;
        Live *p;
        while (m <= id) m *= 2;
        if (!(p = (Live *)realloc(s_live, m * sizeof *p))) return NULL;
        memset(p + s_nlive, 0, (m - s_nlive) * sizeof *p);
        s_live = p; s_nlive = m;
    }
    return &s_live[id];
}

static void live_drop(Live *l)
{
    free(l->payload);
    memset(l, 0, sizeof *l);
}

static void shadow_update(const GpFrame *f)
{
    uint32_t off = 0;
    while (off + sizeof(GpCmd) <= f->queue_bytes) {
        const GpCmd *c = (const GpCmd *)(f->queue + off);
        Live *l = live(c->id);
        if (l) {
            switch (c->op) {
            case GP_TEX_FREE:
                live_drop(l);
                break;
            case GP_TEX_CREATE:
                live_drop(l);
                l->c = *c;
                if (s_cap_dir && c->bytes && (l->payload = (uint8_t *)malloc(c->bytes)))
                    memcpy(l->payload, c + 1, c->bytes);
                else
                    l->c.bytes = 0;
                break;
            case GP_RT_CREATE: case GP_DS_CREATE: case GP_SUB_CREATE:
            case GP_SHADER_VS: case GP_SHADER_PS:
                live_drop(l);
                l->c = *c;
                l->c.bytes = 0;     /* RT pixels are read at capture time; shaders are WGSL */
                break;
            default:
                break;
            }
        }
        off += sizeof(GpCmd) + ((c->bytes + 15) & ~15u);
    }
}

typedef struct { uint8_t *p; size_t n, cap; } Out;

static void out_put(Out *o, const void *p, size_t n)
{
    if (o->n + n > o->cap) {
        size_t cap = o->cap ? o->cap : (1u << 20);
        uint8_t *np;
        while (cap < o->n + n) cap *= 2;
        if (!(np = (uint8_t *)realloc(o->p, cap))) return;
        o->p = np; o->cap = cap;
    }
    if (p) memcpy(o->p + o->n, p, n); else memset(o->p + o->n, 0, n);
    o->n += n;
}

static void out_cmd(Out *o, const GpCmd *c, const void *payload, uint32_t bytes)
{
    GpCmd h = *c;
    h.bytes = bytes;
    out_put(o, &h, sizeof h);
    if (bytes) out_put(o, payload, bytes);
    out_put(o, NULL, ((bytes + 15) & ~15u) - bytes);
}

static uint32_t argb_from_16(uint16_t p, uint32_t cf)
{
    uint32_t r, g, b;
    if (cf == 3) { r = (p >> 11) & 31; g = (p >> 5) & 63; b = p & 31;
                   g = (g << 2) | (g >> 4); }
    else         { r = (p >> 10) & 31; g = (p >> 5) & 31; b = p & 31;
                   g = (g << 3) | (g >> 2); }
    r = (r << 3) | (r >> 2); b = (b << 3) | (b >> 2);
    return 0xFF000000u | (r << 16) | (g << 8) | b;
}

/* A linear render target's guest pixels as BGRA8, or NULL. */
static uint32_t *rt_pixels(const GpCmd *c)
{
    const uint8_t *mem = (const uint8_t *)xbox_GetMemoryOffset();
    uint32_t va = c->a, w = c->b, h = c->c, bpp = c->d & 0xFF, fmt = (c->d >> 8) & 0xFF;
    uint32_t swz = (c->d >> 16) & 1, pitch = c->e, x, y;
    uint32_t *px;
    if (swz || !pitch || (bpp != 4 && bpp != 2)) return NULL;
    if (!(px = (uint32_t *)malloc((size_t)w * h * 4))) return NULL;
    for (y = 0; y < h; y++) {
        const uint8_t *row = mem + va + (size_t)y * pitch;
        if (bpp == 4) memcpy(px + (size_t)y * w, row, (size_t)w * 4);
        else for (x = 0; x < w; x++) px[(size_t)y * w + x] = argb_from_16(((const uint16_t *)row)[x], fmt);
    }
    return px;
}

static void shader_cmd(Out *o, const GpCmd *c)
{
    uint32_t len;
    const char *src = gp_wgsl_source(c->id, c->op == GP_SHADER_PS, &len);
    if (!src) { s_n_fail++; return; }
    out_cmd(o, c, src, len + 1);
}

static uint32_t s_ref_target;

static void capture_write(const GpFrame *f)
{
    Out q = { 0 }, file = { 0 };
    GpCapHeader h;
    GpCmd c;
    uint32_t id, off;
    char path[512];
    FILE *fp;

    /* Built-in shaders first. */
    memset(&c, 0, sizeof c);
    c.op = GP_SHADER_VS; c.id = GP_VS_PASSTHRU; shader_cmd(&q, &c);
    c.op = GP_SHADER_VS; c.id = GP_VS_TVERT;    shader_cmd(&q, &c);
    c.op = GP_SHADER_PS; c.id = GP_PS_TVERT;    shader_cmd(&q, &c);
    /* Everything live at the start of the frame. */
    for (id = 0; id < s_nlive; id++) {
        Live *l = &s_live[id];
        switch (l->c.op) {
        case GP_RT_CREATE: {
            uint32_t *px = rt_pixels(&l->c);
            out_cmd(&q, &l->c, px, px ? l->c.b * l->c.c * 4 : 0);
            free(px);
            break;
        }
        case GP_DS_CREATE: case GP_SUB_CREATE: out_cmd(&q, &l->c, NULL, 0); break;
        case GP_TEX_CREATE: out_cmd(&q, &l->c, l->payload, l->c.bytes); break;
        case GP_SHADER_VS: case GP_SHADER_PS: shader_cmd(&q, &l->c); break;
        default: break;
        }
    }
    /* Then the frame's own queue, shaders as WGSL. */
    for (off = 0; off + sizeof(GpCmd) <= f->queue_bytes; ) {
        const GpCmd *qc = (const GpCmd *)(f->queue + off);
        if (qc->op == GP_SHADER_VS || qc->op == GP_SHADER_PS) shader_cmd(&q, qc);
        else out_cmd(&q, qc, qc + 1, qc->bytes);
        off += sizeof(GpCmd) + ((qc->bytes + 15) & ~15u);
    }

    s_ref_target = f->draw_count ? f->draws[f->draw_count - 1].target : 0;
    memset(&h, 0, sizeof h);
    memcpy(h.magic, "GPF1", 4);
    h.version = GP_VERSION; h.layout = GP_WG_LAYOUT; h.frame = f->frame;
    h.queue_bytes = (uint32_t)q.n; h.draw_count = f->draw_count;
    h.vtx_bytes = f->vtx_bytes; h.idx_count = f->idx_count; h.const_bytes = f->const_bytes;
    h.ref_target = s_ref_target;
    out_put(&file, &h, sizeof h);
#define SECTION(p, n) do { out_put(&file, (p), (n)); out_put(&file, NULL, ((n) + 15 & ~(size_t)15) - (n)); } while (0)
    SECTION(q.p, q.n);
    SECTION(f->draws, (size_t)f->draw_count * sizeof(GpDraw));
    SECTION(f->vtx, f->vtx_bytes);
    SECTION(f->idx, (size_t)f->idx_count * 4);
    SECTION(f->consts, f->const_bytes);
#undef SECTION
    snprintf(path, sizeof path, "%s/cap_%u.gpf", s_cap_dir, f->frame);
    if ((fp = fopen(path, "wb"))) { fwrite(file.p, 1, file.n, fp); fclose(fp); }
    fprintf(stderr, "  [GPUWEB] captured frame %u: %u draws, %zu bytes -> %s\n",
            f->frame, f->draw_count, file.n, path);
    free(q.p); free(file.p);
}

/* After D3D11 drew the frame and wrote it back: the reference picture. */
static void capture_ref(const GpFrame *f)
{
    Live *l = s_ref_target < s_nlive ? &s_live[s_ref_target] : NULL;
    uint32_t *px, w, h, y, hdr[4];
    char path[512];
    FILE *fp;
    if (!l || l->c.op != GP_RT_CREATE || !(px = rt_pixels(&l->c))) return;
    w = l->c.b; h = l->c.c;
    memcpy(&hdr[0], "GPR1", 4); hdr[1] = s_ref_target; hdr[2] = w; hdr[3] = h;
    snprintf(path, sizeof path, "%s/cap_%u.ref", s_cap_dir, f->frame);
    if ((fp = fopen(path, "wb"))) {
        fwrite(hdr, 4, 4, fp); fwrite(px, 4, (size_t)w * h, fp); fclose(fp);
    }
    snprintf(path, sizeof path, "%s/cap_%u_d3d11.bmp", s_cap_dir, f->frame);
    if ((fp = fopen(path, "wb"))) {
        uint8_t bh[54];
        uint32_t img = w * h * 4;
        memset(bh, 0, sizeof bh);
        bh[0] = 'B'; bh[1] = 'M';
        *(uint32_t *)(bh + 2) = 54 + img; *(uint32_t *)(bh + 10) = 54;
        *(uint32_t *)(bh + 14) = 40; *(int32_t *)(bh + 18) = (int32_t)w; *(int32_t *)(bh + 22) = -(int32_t)h;
        *(uint16_t *)(bh + 26) = 1; *(uint16_t *)(bh + 28) = 32; *(uint32_t *)(bh + 34) = img;
        fwrite(bh, 1, sizeof bh, fp);
        for (y = 0; y < h; y++) fwrite(px + (size_t)y * w, 4, w, fp);
        fclose(fp);
    }
    free(px);
}

static int capture_this(const GpFrame *f)
{
    int i;
    for (i = 0; i < s_ncap_frames; i++)
        if (s_cap_frames[i] == f->frame) return 1;
    if (s_cap_min_draws && f->draw_count >= s_cap_min_draws && s_cap_auto < 8
        && (s_cap_last == ~0u || f->frame - s_cap_last >= s_cap_every)) {
        s_cap_last = f->frame;
        s_cap_auto++;
        return 1;
    }
    return 0;
}

/* RECOMP_GPU_BACKEND=ab: per-frame diff of the last target. */
static struct { uint64_t frames, px, sum, over16, maxd; } s_ab;

static void ab_compare(const GpFrame *f, const uint32_t *ref, const Live *l)
{
    uint32_t *got = rt_pixels(&l->c), i, n = l->c.b * l->c.c;
    if (!got) return;
    for (i = 0; i < n; i++) {
        uint32_t a = ref[i], b = got[i], m = 0, c;
        for (c = 0; c < 24; c += 8) {
            int d = (int)((a >> c) & 0xFF) - (int)((b >> c) & 0xFF);
            if (d < 0) d = -d;
            s_ab.sum += (uint32_t)d;
            if ((uint32_t)d > m) m = (uint32_t)d;
        }
        if (m > 16) s_ab.over16++;
        if (m > s_ab.maxd) s_ab.maxd = m;
    }
    s_ab.px += n; s_ab.frames++;
    free(got);
    if (f->frame % 300 == 299 && s_ab.px) {
        fprintf(stderr, "  [GPUWEB] A/B frames %u: %llu compared, mean |diff| %.4f per channel, %.4f%% px > 16,"
                " max %llu\n", f->frame + 1, (unsigned long long)s_ab.frames,
                (double)s_ab.sum / (3.0 * (double)s_ab.px), 100.0 * (double)s_ab.over16 / (double)s_ab.px,
                (unsigned long long)s_ab.maxd);
        memset(&s_ab, 0, sizeof s_ab);
    }
}

void gp_backend_flip(const GpFrame *f)
{
    int cap;
    init();
    cap = s_cap_dir && capture_this(f);
    if (cap) capture_write(f);
    if (s_cap_dir || s_wgpu == 2) shadow_update(f);
#ifdef ATV2_WGPU
    if (s_wgpu == 2) {
        uint32_t t = f->draw_count ? f->draws[f->draw_count - 1].target : 0;
        Live *l = t < s_nlive && s_live[t].c.op == GP_RT_CREATE ? &s_live[t] : NULL;
        uint32_t *ref;
        gp_d3d11_consume(f);
        ref = l ? rt_pixels(&l->c) : NULL;
        gp_wgpu_consume(f);
        if (ref) { ab_compare(f, ref, l); free(ref); }
    } else if (s_wgpu) gp_wgpu_consume(f);
    else
#endif
    gp_d3d11_consume(f);
    if (cap) capture_ref(f);
    if (s_on && f->frame % 600 == 599)
        fprintf(stderr, "  [GPUWEB] WGSL: %u vertex programs, %u combiner shaders, %u failures\n",
                s_n_vs, s_n_ps, s_n_fail);
}
