/*
 * The native WebGPU drawing side (RECOMP_GPU_BACKEND=wgpu): consumes frame
 * packets (gpu_proto.h) exactly like gpu_d3d11.c, through the standard
 * webgpu.h API (wgpu-native v29; Dawn has the same entry points). It is the C
 * twin of web/gpu/encoder.js, which the browser build uses; keep them in step.
 *
 * Built with -DATV2_WGPU=ON -DWGPU_NATIVE_DIR=<wgpu-native release>; the exe
 * then needs wgpu_native.dll next to it (CMake copies it).
 *
 *   drain the resource queue in order -- render targets, depth, textures by
 *   id; shaders by id, the WGSL coming from the tap (gp_wgsl_source) since
 *   the queue's payload is HLSL;
 *   draw the records in order -- a target/depth change or a clear starts a
 *   render pass; constants repacked into one 256-aligned uniform arena bound
 *   with dynamic offsets; pipelines and texture bind groups cached by key;
 *   write the linear render targets drawn this frame back into guest memory,
 *   so the framebuffer window, dumps and screenshots work unchanged.
 *
 * Display options (gpu_display.h) as gpu_d3d11.c: scaled and/or
 * multisampled targets, box-filtered writeback, and a window surface that
 * shows the full-size image (gp_wgpu_present_*). Off: none of it runs.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>                /* Sleep */

#include <webgpu/webgpu.h>
#include <webgpu/wgpu.h>            /* wgpuDevicePoll */

#include "gpu_proto.h"
#include "gpu_display.h"
#include "gpu_shadergen_wgsl.h"

extern ptrdiff_t xbox_GetMemoryOffset(void);

#define SV(s) ((WGPUStringView){ (s), WGPU_STRLEN })

static WGPUInstance s_inst;
static WGPUAdapter s_adapter;
static WGPUDevice s_dev;
static WGPUQueue s_queue;
static int s_failed, s_bc, s_d32s8;
static WGPUTextureFormat s_ds_fmt;

static uint64_t fnv(const void *p, size_t n)
{
    const uint8_t *b = (const uint8_t *)p;
    uint64_t h = 1469598103934665603ull;
    size_t i;
    for (i = 0; i < n; i++) { h ^= b[i]; h *= 1099511628211ull; }
    return h | 1;
}

/* ---- id table (as gpu_d3d11.c) ------------------------------------------- */

typedef enum { R_NONE, R_RT, R_DS, R_TEX, R_VS, R_PS, R_SUB } RKind;
typedef struct {
    RKind kind;
    WGPUTexture tex;
    WGPUTextureView view;
    WGPUShaderModule mod;
    WGPUBuffer rb;                  /* writeback staging */
    uint32_t va, w, h, bpp, fmt, swz, pitch, dirty, cube;   /* cube: faces==6 (tex) or PS mask;
                                                               R_SUB: va = source target, pitch = x0 | y0 << 16 */
    /* Display options only (s_active): */
    uint32_t sw, sh;                /* scaled size (R_RT, R_DS, R_SUB) */
    uint32_t bx, by;                /* R_SUB: scaled top-left in the source */
    WGPUTexture ms;                 /* MSAA colour (R_RT), drawn into */
    WGPUTextureView msview;
    uint32_t msdirty;               /* drawn since the last resolve into tex */
    WGPUTexture down;               /* scaled: guest-size copy for writeback */
    WGPUTextureView downview;
} Res;
static Res *s_res;
static uint32_t s_nres;
static uint32_t *s_rt_ids;
static int s_nrt_ids, s_cap_rt_ids;
static int s_bg_flush;              /* a view went away: drop cached bind groups */

static Res *res(uint32_t id)
{
    if (id >= s_nres) {
        uint32_t n = s_nres ? s_nres : 4096;
        Res *p;
        while (n <= id) n *= 2;
        if (!(p = (Res *)realloc(s_res, n * sizeof *p))) return NULL;
        memset(p + s_nres, 0, (n - s_nres) * sizeof *p);
        s_res = p; s_nres = n;
    }
    return &s_res[id];
}

static void rt_list_add(uint32_t id)
{
    int i;
    for (i = 0; i < s_nrt_ids; i++)
        if (s_rt_ids[i] == id) return;
    if (s_nrt_ids == s_cap_rt_ids) {
        int cap = s_cap_rt_ids ? s_cap_rt_ids * 2 : 64;
        uint32_t *p = (uint32_t *)realloc(s_rt_ids, cap * sizeof *p);
        if (!p) return;
        s_rt_ids = p; s_cap_rt_ids = cap;
    }
    s_rt_ids[s_nrt_ids++] = id;
}

static void res_release(Res *r)
{
    if (r->view) { wgpuTextureViewRelease(r->view); s_bg_flush = 1; }
    if (r->tex) { wgpuTextureDestroy(r->tex); wgpuTextureRelease(r->tex); }
    if (r->msview) wgpuTextureViewRelease(r->msview);
    if (r->ms) { wgpuTextureDestroy(r->ms); wgpuTextureRelease(r->ms); }
    if (r->downview) wgpuTextureViewRelease(r->downview);
    if (r->down) { wgpuTextureDestroy(r->down); wgpuTextureRelease(r->down); }
    if (r->mod) wgpuShaderModuleRelease(r->mod);
    if (r->rb) { wgpuBufferDestroy(r->rb); wgpuBufferRelease(r->rb); }
    memset(r, 0, sizeof *r);
}

/* Display options (gpu_display.h): current scale per axis, MSAA samples,
 * whether any of it is on. */
static float s_sx = 1.0f, s_sy = 1.0f;
static int s_msaa = 1, s_active;
static int display_init(void);
static void rt_make(Res *r);
static void resolve(Res *r);
static WGPUTextureView draw_view(Res *r);
static WGPUTexture make_tex_n(uint32_t w, uint32_t h, WGPUTextureFormat f, WGPUTextureUsage u, uint32_t samples);
static void blit(WGPUTextureView src, uint32_t srcw, uint32_t srch, WGPUTextureView dst,
                 WGPUTextureFormat fmt, uint32_t samples, int clear,
                 float x, float y, float w, float h);
static WGPUCommandEncoder s_enc;

/* Built-in shaders live outside the id table (VS 1/2 and PS 1 share ids). */
static WGPUShaderModule s_vs_pass, s_vs_tv, s_ps_tv;

/* ---- device -------------------------------------------------------------- */

static void on_adapter(WGPURequestAdapterStatus st, WGPUAdapter a, WGPUStringView msg, void *u1, void *u2)
{
    if (st == WGPURequestAdapterStatus_Success) *(WGPUAdapter *)u1 = a;
    else fprintf(stderr, "  [WGPU] no adapter: %.*s\n", (int)msg.length, msg.data);
    *((int *)u2) = 1;
}

static void on_device(WGPURequestDeviceStatus st, WGPUDevice d, WGPUStringView msg, void *u1, void *u2)
{
    if (st == WGPURequestDeviceStatus_Success) *(WGPUDevice *)u1 = d;
    else fprintf(stderr, "  [WGPU] no device: %.*s\n", (int)msg.length, msg.data);
    *((int *)u2) = 1;
}

static uint32_t s_errors;
static void on_error(WGPUDevice const *d, WGPUErrorType t, WGPUStringView msg, void *u1, void *u2)
{
    (void)d; (void)u1; (void)u2;
    if (s_errors++ < 20)
        fprintf(stderr, "  [WGPU] error %d: %.*s\n", (int)t, (int)(msg.length > 1500 ? 1500 : msg.length), msg.data);
}

static WGPUShaderModule wgsl_module(const char *src, uint32_t len, const char *label)
{
    WGPUShaderSourceWGSL w = { .chain = { .sType = WGPUSType_ShaderSourceWGSL },
                               .code = { src, len } };
    WGPUShaderModuleDescriptor d = { .nextInChain = &w.chain, .label = SV(label) };
    return wgpuDeviceCreateShaderModule(s_dev, &d);
}

static WGPUBindGroupLayout s_bgl0, s_bgl1[16];
static WGPUPipelineLayout s_pl[16];
static WGPUTextureView s_dummy2d, s_dummy_cube;
static WGPUSampler s_default_smp;

static void make_layouts(void)
{
    WGPUBindGroupLayoutEntry e[8];
    int i, cube;
    memset(e, 0, sizeof e);
    for (i = 0; i < 4; i++) {
        e[i].binding = (uint32_t)i;
        e[i].visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        e[i].buffer.type = WGPUBufferBindingType_Uniform;
        e[i].buffer.hasDynamicOffset = 1;
    }
    s_bgl0 = wgpuDeviceCreateBindGroupLayout(s_dev, &(WGPUBindGroupLayoutDescriptor){ .entryCount = 4, .entries = e });
    for (cube = 0; cube < 16; cube++) {
        WGPUBindGroupLayout both[2];
        memset(e, 0, sizeof e);
        for (i = 0; i < 4; i++) {
            e[i].binding = (uint32_t)i;
            e[i].visibility = WGPUShaderStage_Fragment;
            e[i].texture.sampleType = WGPUTextureSampleType_Float;
            e[i].texture.viewDimension = (cube >> i) & 1 ? WGPUTextureViewDimension_Cube : WGPUTextureViewDimension_2D;
            e[4 + i].binding = (uint32_t)(4 + i);
            e[4 + i].visibility = WGPUShaderStage_Fragment;
            e[4 + i].sampler.type = WGPUSamplerBindingType_Filtering;
        }
        s_bgl1[cube] = wgpuDeviceCreateBindGroupLayout(s_dev, &(WGPUBindGroupLayoutDescriptor){ .entryCount = 8, .entries = e });
        both[0] = s_bgl0; both[1] = s_bgl1[cube];
        s_pl[cube] = wgpuDeviceCreatePipelineLayout(s_dev, &(WGPUPipelineLayoutDescriptor){ .bindGroupLayoutCount = 2, .bindGroupLayouts = both });
    }
    {   /* Zero 1x1 textures: an unbound stage reads 0, as a NULL SRV. */
        WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
        WGPUTextureViewDescriptor vd = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        WGPUTexture t;
        td.usage = WGPUTextureUsage_TextureBinding; td.size = (WGPUExtent3D){ 1, 1, 1 };
        td.format = WGPUTextureFormat_BGRA8Unorm;
        t = wgpuDeviceCreateTexture(s_dev, &td);
        s_dummy2d = wgpuTextureCreateView(t, NULL);
        td.size.depthOrArrayLayers = 6;
        t = wgpuDeviceCreateTexture(s_dev, &td);
        vd.dimension = WGPUTextureViewDimension_Cube; vd.arrayLayerCount = 6;
        s_dummy_cube = wgpuTextureCreateView(t, &vd);
    }
    {
        WGPUSamplerDescriptor sd = WGPU_SAMPLER_DESCRIPTOR_INIT;
        s_default_smp = wgpuDeviceCreateSampler(s_dev, &sd);
    }
}

/* Pump until *done, bounded (~10 s): wgpu-native fires callbacks in poll. */
static int wait_flag(volatile int *done)
{
    int i;
    for (i = 0; i < 100000 && !*done; i++) {
        if (s_dev) wgpuDevicePoll(s_dev, 1, NULL);
        wgpuInstanceProcessEvents(s_inst);
        if (!*done && i > 1000) Sleep(0);
    }
    return *done;
}

static int ensure_device(void)
{
    WGPUFeatureName feat[3];
    size_t nf = 0;
    uint32_t n;
    volatile int got = 0;
    const char *src;
    WGPURequestAdapterOptions ao = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    WGPUDeviceDescriptor dd = WGPU_DEVICE_DESCRIPTOR_INIT;
    WGPUAdapterInfo info = WGPU_ADAPTER_INFO_INIT;

    if (s_failed) return 0;
    if (s_dev) return 1;
    s_failed = 1;
    if (!(s_inst = wgpuCreateInstance(NULL))) return 0;
    ao.powerPreference = WGPUPowerPreference_HighPerformance;
    wgpuInstanceRequestAdapter(s_inst, &ao, (WGPURequestAdapterCallbackInfo){
        .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_adapter,
        .userdata1 = &s_adapter, .userdata2 = (void *)&got });
    if (!wait_flag(&got) || !s_adapter) return 0;
    if (wgpuAdapterGetInfo(s_adapter, &info) == WGPUStatus_Success)
        fprintf(stderr, "  [WGPU] adapter: %.*s (backend %d)\n", (int)info.device.length, info.device.data,
                (int)info.backendType);
    s_bc = wgpuAdapterHasFeature(s_adapter, WGPUFeatureName_TextureCompressionBC);
    s_d32s8 = wgpuAdapterHasFeature(s_adapter, WGPUFeatureName_Depth32FloatStencil8);
    if (s_bc) feat[nf++] = WGPUFeatureName_TextureCompressionBC;
    if (s_d32s8) feat[nf++] = WGPUFeatureName_Depth32FloatStencil8;
    s_ds_fmt = s_d32s8 ? WGPUTextureFormat_Depth32FloatStencil8 : WGPUTextureFormat_Depth24PlusStencil8;
    dd.requiredFeatureCount = nf; dd.requiredFeatures = feat;
    dd.uncapturedErrorCallbackInfo.callback = on_error;
    got = 0;
    wgpuAdapterRequestDevice(s_adapter, &dd, (WGPURequestDeviceCallbackInfo){
        .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_device,
        .userdata1 = &s_dev, .userdata2 = (void *)&got });
    if (!wait_flag(&got) || !s_dev) return 0;
    s_queue = wgpuDeviceGetQueue(s_dev);
    make_layouts();
    if ((src = gp_wgsl_source(GP_VS_PASSTHRU, 0, &n))) s_vs_pass = wgsl_module(src, n, "vs_passthru");
    if ((src = gp_wgsl_source(GP_VS_TVERT, 0, &n)))    s_vs_tv = wgsl_module(src, n, "vs_tvert");
    if ((src = gp_wgsl_source(GP_PS_TVERT, 1, &n)))    s_ps_tv = wgsl_module(src, n, "ps_tvert");
    if (!s_vs_pass || !s_vs_tv || !s_ps_tv) return 0;
    if (!display_init()) return 0;
    s_failed = 0;
    fprintf(stderr, "  [WGPU] packet consumer ready (BC %d, D32S8 %d)\n", s_bc, s_d32s8);
    return 1;
}

int gp_wgpu_ready(void) { return s_dev != NULL && !s_failed; }

/* ---- resource queue ------------------------------------------------------ */

static WGPUTexture make_tex(uint32_t w, uint32_t h, uint32_t layers, WGPUTextureFormat f, WGPUTextureUsage u)
{
    WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
    td.usage = u; td.size = (WGPUExtent3D){ w, h, layers }; td.format = f;
    return wgpuDeviceCreateTexture(s_dev, &td);
}

static void write_tex(WGPUTexture t, uint32_t layer, const void *p, size_t n,
                      uint32_t bpr, uint32_t rows, uint32_t w, uint32_t h)
{
    WGPUTexelCopyTextureInfo dst = { .texture = t, .origin = { 0, 0, layer }, .aspect = WGPUTextureAspect_All };
    WGPUTexelCopyBufferLayout lay = { .bytesPerRow = bpr, .rowsPerImage = rows };
    wgpuQueueWriteTexture(s_queue, &dst, p, n, &lay, &(WGPUExtent3D){ w, h, 1 });
}

static void q_rt_create(const GpCmd *c, const void *payload)
{
    Res *r = res(c->id);
    if (!r) return;
    res_release(r);
    if (s_active) {
        /* Scaled and/or multisampled: the guest pixels (if any) go in
         * through a guest-size texture, scaled up into the draw target. */
        r->w = c->b; r->h = c->c;
        rt_make(r);
        if (c->bytes) {
            WGPUTexture t = make_tex(c->b, c->c, 1, WGPUTextureFormat_BGRA8Unorm,
                                     WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
            WGPUTextureView v;
            write_tex(t, 0, payload, c->bytes, c->b * 4, c->c, c->b, c->c);
            v = wgpuTextureCreateView(t, NULL);
            blit(v, c->b, c->c, draw_view(r), WGPUTextureFormat_BGRA8Unorm, r->ms ? (uint32_t)s_msaa : 1, 0,
                 0, 0, (float)r->sw, (float)r->sh);
            wgpuTextureViewRelease(v);
            wgpuTextureRelease(t);                  /* the encoder keeps it until it runs */
            if (r->ms) r->msdirty = 1;
        }
        r->kind = R_RT; r->va = c->a;
        r->bpp = c->d & 0xFF; r->fmt = (c->d >> 8) & 0xFF; r->swz = (c->d >> 16) & 1; r->pitch = c->e;
        rt_list_add(c->id);
        return;
    }
    r->tex = make_tex(c->b, c->c, 1, WGPUTextureFormat_BGRA8Unorm,
                      WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding
                      | WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst);
    if (c->bytes) write_tex(r->tex, 0, payload, c->bytes, c->b * 4, c->c, c->b, c->c);
    r->view = wgpuTextureCreateView(r->tex, NULL);
    r->kind = R_RT; r->va = c->a; r->w = c->b; r->h = c->c;
    r->bpp = c->d & 0xFF; r->fmt = (c->d >> 8) & 0xFF; r->swz = (c->d >> 16) & 1; r->pitch = c->e;
    rt_list_add(c->id);
}

static void q_ds_create(const GpCmd *c)
{
    Res *r = res(c->id);
    if (!r) return;
    res_release(r);
    if (s_active) {
        r->sw = gp_scaled(c->b, s_sx); r->sh = gp_scaled(c->c, s_sy);
        r->tex = make_tex_n(r->sw, r->sh, s_ds_fmt, WGPUTextureUsage_RenderAttachment, (uint32_t)s_msaa);
    } else
    r->tex = make_tex(c->b, c->c, 1, s_ds_fmt, WGPUTextureUsage_RenderAttachment);
    r->view = wgpuTextureCreateView(r->tex, NULL);
    r->kind = R_DS; r->w = c->b; r->h = c->c;
}

static uint32_t s_stat_tex, s_stat_shaders, s_stat_nobc;

/* GP_TEX_CREATE: a = mip levels; payload per face its levels in order, each
 * tightly packed (BC levels below 4x4 still take a whole block) -- the
 * subresource order of q_tex_create() in gpu_d3d11.c. */
static void q_tex_create(const GpCmd *c, const uint8_t *payload)
{
    Res *r = res(c->id);
    uint32_t faces = c->e ? c->e : 1, levels = c->a ? c->a : 1, f, l, bb = 0, maxl = 1, m;
    WGPUTextureFormat fmt = WGPUTextureFormat_BGRA8Unorm;
    WGPUTextureViewDescriptor vd = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
    const uint8_t *p = payload, *end = payload + c->bytes;
    if (!r) return;
    res_release(r);
    if (c->d != GP_FMT_BGRA8) {
        if (!s_bc) { s_stat_nobc++; return; }   /* ponytail: CPU BC decode without the feature */
        fmt = c->d == GP_FMT_BC1 ? WGPUTextureFormat_BC1RGBAUnorm
            : c->d == GP_FMT_BC2 ? WGPUTextureFormat_BC2RGBAUnorm : WGPUTextureFormat_BC3RGBAUnorm;
        bb = c->d == GP_FMT_BC1 ? 8 : 16;
    }
    for (m = c->b > c->c ? c->b : c->c; m > 1; m >>= 1) maxl++;
    if (levels > maxl) levels = maxl;
    td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    td.size = (WGPUExtent3D){ c->b, c->c, faces };
    td.format = fmt; td.mipLevelCount = levels;
    r->tex = wgpuDeviceCreateTexture(s_dev, &td);
    for (f = 0; f < faces; f++)
        for (l = 0; l < levels; l++) {
            uint32_t lw = c->b >> l ? c->b >> l : 1, lh = c->c >> l ? c->c >> l : 1;
            uint32_t bpr = bb ? ((lw + 3) / 4) * bb : lw * 4, rows = bb ? (lh + 3) / 4 : lh;
            size_t n = (size_t)bpr * rows;
            WGPUTexelCopyTextureInfo dst = { .texture = r->tex, .mipLevel = l, .origin = { 0, 0, f },
                                             .aspect = WGPUTextureAspect_All };
            WGPUTexelCopyBufferLayout lay = { .bytesPerRow = bpr, .rowsPerImage = rows };
            if (p + n > end) break;                  /* malformed: what fits */
            /* BC copies cover the physical (block-rounded) size. */
            wgpuQueueWriteTexture(s_queue, &dst, p, n, &lay, &(WGPUExtent3D){
                bb ? (lw + 3) & ~3u : lw, bb ? (lh + 3) & ~3u : lh, 1 });
            p += n;
        }
    vd.dimension = faces == 6 ? WGPUTextureViewDimension_Cube : WGPUTextureViewDimension_2D;
    vd.arrayLayerCount = faces;
    vd.mipLevelCount = levels;
    r->view = wgpuTextureCreateView(r->tex, &vd);
    r->kind = R_TEX; r->w = c->b; r->h = c->c; r->cube = faces == 6;
    s_stat_tex++;
}

/* GP_SUB_CREATE: a tile of a render target, copied out of it before every
 * draw that samples it (do_draw). */
static void q_sub_create(const GpCmd *c)
{
    Res *r = res(c->id);
    if (!r) return;
    res_release(r);
    if (s_active) {
        /* The tile's box in the scaled source (gpu_d3d11.c q_sub_create). */
        uint32_t x0 = c->d & 0xFFFF, y0 = c->d >> 16;
        r->bx = gp_scaled(x0, s_sx); r->by = gp_scaled(y0, s_sy);
        r->sw = gp_scaled(x0 + c->b, s_sx) - r->bx; r->sh = gp_scaled(y0 + c->c, s_sy) - r->by;
        r->tex = make_tex(r->sw, r->sh, 1, WGPUTextureFormat_BGRA8Unorm,
                          WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
    } else
    r->tex = make_tex(c->b, c->c, 1, WGPUTextureFormat_BGRA8Unorm,
                      WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
    r->view = wgpuTextureCreateView(r->tex, NULL);
    r->kind = R_SUB; r->w = c->b; r->h = c->c; r->va = c->a; r->pitch = c->d;
}

static uint32_t cube_mask_of(const char *wgsl)
{
    uint32_t m = 0;
    int st;
    char pat[64];
    for (st = 0; st < 4; st++) {
        snprintf(pat, sizeof pat, "var tx%d: texture_cube", st);
        if (strstr(wgsl, pat)) m |= 1u << st;
    }
    return m;
}

static void q_shader(const GpCmd *c)
{
    Res *r = res(c->id);
    uint32_t n;
    int is_ps = c->op == GP_SHADER_PS;
    const char *src = gp_wgsl_source(c->id, is_ps, &n);
    char label[32];
    if (!r) return;
    res_release(r);
    if (!src) return;
    snprintf(label, sizeof label, "%s_%u", is_ps ? "ps" : "vs", c->id);
    r->mod = wgsl_module(src, n, label);
    r->kind = is_ps ? R_PS : R_VS;
    r->cube = is_ps ? cube_mask_of(src) : 0;
    s_stat_shaders++;
}

static void drain_queue(const GpFrame *f)
{
    uint32_t off = 0;
    while (off + sizeof(GpCmd) <= f->queue_bytes) {
        const GpCmd *c = (const GpCmd *)(f->queue + off);
        const uint8_t *payload = (const uint8_t *)(c + 1);
        switch (c->op) {
        case GP_RT_CREATE:  q_rt_create(c, payload); break;
        case GP_DS_CREATE:  q_ds_create(c); break;
        case GP_SUB_CREATE: q_sub_create(c); break;
        case GP_TEX_CREATE: q_tex_create(c, payload); break;
        case GP_TEX_FREE:   { Res *r = res(c->id); if (r) res_release(r); } break;
        case GP_SHADER_VS: case GP_SHADER_PS: q_shader(c); break;
        default: break;
        }
        off += sizeof(GpCmd) + ((c->bytes + 15) & ~15u);
    }
}

/* ---- per-frame buffers and the uniform arena ----------------------------- */

typedef struct { WGPUBuffer b; uint64_t size; } GBuf;
static GBuf s_vb, s_ib, s_ub;
static WGPUBindGroup s_group0;

static int gbuf(GBuf *g, uint64_t bytes, WGPUBufferUsage usage)
{
    WGPUBufferDescriptor bd = WGPU_BUFFER_DESCRIPTOR_INIT;
    if (g->b && g->size >= bytes) return 0;
    if (g->b) { wgpuBufferDestroy(g->b); wgpuBufferRelease(g->b); }
    g->size = (bytes + bytes / 2 + 0xFFFF) & ~(uint64_t)0xFFFF;
    bd.usage = usage | WGPUBufferUsage_CopyDst; bd.size = g->size;
    g->b = wgpuDeviceCreateBuffer(s_dev, &bd);
    return 1;
}

/* Slot offsets per draw, in draw order (GP_DRAW records only). */
typedef struct { uint32_t xf, vsc, ps, smp; } Slots;
static Slots *s_slots;
static uint32_t s_nslots;
static uint8_t *s_arena;
static size_t s_arena_cap;

static void pack_uniforms(const GpFrame *f)
{
    size_t size = 3072, i;     /* offset 0: zeros, the "no block" slot for every binding */
    uint32_t last_vsc = ~0u, last_vsc_slot = 0;
    if (s_nslots < f->draw_count) {
        s_nslots = f->draw_count + 1024;
        s_slots = (Slots *)realloc(s_slots, s_nslots * sizeof *s_slots);
    }
    for (i = 0; i < f->draw_count; i++) {
        const GpDraw *d = &f->draws[i];
        Slots *s = &s_slots[i];
        memset(s, 0, sizeof *s);
        if (d->kind != GP_DRAW) continue;
        if (d->xfc_off != ~0u) { s->xf = (uint32_t)size; size += 256; }
        if (d->vsc_off != ~0u) {        /* the recorder dedupes consecutive blocks */
            if (d->vsc_off != last_vsc) { last_vsc = d->vsc_off; last_vsc_slot = (uint32_t)size; size += 3072; }
            s->vsc = last_vsc_slot;
        }
        if (d->psc_off != ~0u) { s->ps = (uint32_t)size; size += 512; }
        s->smp = (uint32_t)size; size += 256;
    }
    if (size > s_arena_cap) {
        s_arena_cap = size + size / 2;
        s_arena = (uint8_t *)realloc(s_arena, s_arena_cap);
    }
    memset(s_arena, 0, size);
    last_vsc = ~0u;
    for (i = 0; i < f->draw_count; i++) {
        const GpDraw *d = &f->draws[i];
        const Slots *s = &s_slots[i];
        GpWgslSmp *sx;
        int st;
        if (d->kind != GP_DRAW) continue;
        if (s->xf) memcpy(s_arena + s->xf, f->consts + d->xfc_off,
                          d->vs == GP_VS_TVERT ? sizeof(GpTvConsts) : sizeof(GpXfConsts));
        if (s->ps) memcpy(s_arena + s->ps, f->consts + d->psc_off, sizeof(GpPsConsts));
        if (s->vsc && d->vsc_off != last_vsc) {
            memcpy(s_arena + s->vsc, f->consts + d->vsc_off, sizeof(GpVsConsts));
            last_vsc = d->vsc_off;
        }
        sx = (GpWgslSmp *)(s_arena + s->smp);
        for (st = 0; st < 4; st++) {
            uint32_t b = d->border[st], k = d->smp[st];
            sx->border[st][0] = ((b >> 16) & 0xFF) / 255.0f; sx->border[st][1] = ((b >> 8) & 0xFF) / 255.0f;
            sx->border[st][2] = (b & 0xFF) / 255.0f;         sx->border[st][3] = (b >> 24) / 255.0f;
            if (k & GP_SMP_BORDER)
                sx->flags[st] = (((k >> 4) & 0xF) == 4 ? 1u : 0u) | (((k >> 8) & 0xF) == 4 ? 2u : 0u);
            sx->bias[st] = smp_filtered(k) ? (float)GP_SMP_BIAS_OF(k) / 256.0f : 0.0f;
        }
    }
    if (gbuf(&s_ub, size, WGPUBufferUsage_Uniform) && s_group0) {
        wgpuBindGroupRelease(s_group0); s_group0 = NULL;
    }
    wgpuQueueWriteBuffer(s_queue, s_ub.b, 0, s_arena, (size + 3) & ~(size_t)3);
    if (!s_group0) {
        static const uint64_t sz[4] = { 112, 3072, 320, sizeof(GpWgslSmp) };
        WGPUBindGroupEntry e[4];
        int k;
        memset(e, 0, sizeof e);
        for (k = 0; k < 4; k++) { e[k].binding = (uint32_t)k; e[k].buffer = s_ub.b; e[k].size = sz[k]; }
        s_group0 = wgpuDeviceCreateBindGroup(s_dev, &(WGPUBindGroupDescriptor){
            .layout = s_bgl0, .entryCount = 4, .entries = e });
    }
}

/* ---- state: samplers, pipelines, texture bind groups --------------------- */

#define SMP_CACHE 256
static struct { uint32_t key; WGPUSampler s; } s_smp[SMP_CACHE];
static int s_nsmp;

static WGPUAddressMode addr_mode(uint32_t a)
{
    return a == 1 ? WGPUAddressMode_Repeat : a == 2 ? WGPUAddressMode_MirrorRepeat : WGPUAddressMode_ClampToEdge;
}

static int s_no_mips = -1;            /* RECOMP_GPU_NO_MIPS: level 0 only (as D3D11) */

static int smp_filtered(uint32_t key)
{
    if (s_no_mips < 0) s_no_mips = getenv("RECOMP_GPU_NO_MIPS") != NULL;
    return (key & GP_SMP_FILTER) && !s_no_mips;
}

/* sampler() in gpu_d3d11.c: without GP_SMP_FILTER, GP_SMP_LINEAR alone and
 * level 0; with it, SET_TEXTURE_FILTER's MIN (1 BOX_LOD0, 2 TENT_LOD0,
 * 3 BOX_NEARESTLOD, 4 TENT_NEARESTLOD, 5 BOX_TENT_LOD, 6 TENT_TENT_LOD) and
 * MAG (2 TENT). The LOD bias is not a sampler field in WebGPU: the PS adds
 * GpWgslSmp.bias. */
static WGPUSampler sampler(uint32_t key)
{
    WGPUSamplerDescriptor sd = WGPU_SAMPLER_DESCRIPTOR_INIT;
    int i;
    key &= smp_filtered(key) ? 0x00FF3FFFu : 0x0FFFu;   /* bias is not part of the sampler */
    for (i = 0; i < s_nsmp; i++)
        if (s_smp[i].key == key) return s_smp[i].s;
    if (s_nsmp == SMP_CACHE) return s_default_smp;
    if (key & GP_SMP_FILTER) {
        uint32_t mn = GP_SMP_MIN_OF(key), mg = GP_SMP_MAG_OF(key);
        sd.minFilter = (mn == 2 || mn == 4 || mn == 6) ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
        sd.magFilter = mg == 2 ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
        sd.mipmapFilter = (mn == 5 || mn == 6) ? WGPUMipmapFilterMode_Linear : WGPUMipmapFilterMode_Nearest;
        sd.lodMaxClamp = (mn >= 3 && mn <= 6) ? 32.0f : 0.0f;
    } else {
        sd.magFilter = sd.minFilter = (key & GP_SMP_LINEAR) ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
        sd.mipmapFilter = (key & GP_SMP_LINEAR) ? WGPUMipmapFilterMode_Linear : WGPUMipmapFilterMode_Nearest;
        sd.lodMaxClamp = 0.0f;
    }
    sd.addressModeU = addr_mode((key >> 4) & 0xF);
    sd.addressModeV = addr_mode((key >> 8) & 0xF);
    sd.addressModeW = WGPUAddressMode_ClampToEdge;
    s_smp[s_nsmp].key = key;
    s_smp[s_nsmp].s = wgpuDeviceCreateSampler(s_dev, &sd);
    return s_smp[s_nsmp++].s;
}

static WGPUBlendFactor blend_factor(uint32_t f, int alpha)
{
    switch (f) {
    case 0x0000: return WGPUBlendFactor_Zero;
    case 0x0001: return WGPUBlendFactor_One;
    case 0x0300: return alpha ? WGPUBlendFactor_SrcAlpha : WGPUBlendFactor_Src;
    case 0x0301: return alpha ? WGPUBlendFactor_OneMinusSrcAlpha : WGPUBlendFactor_OneMinusSrc;
    case 0x0302: return WGPUBlendFactor_SrcAlpha;
    case 0x0303: return WGPUBlendFactor_OneMinusSrcAlpha;
    case 0x0304: return WGPUBlendFactor_DstAlpha;
    case 0x0305: return WGPUBlendFactor_OneMinusDstAlpha;
    case 0x0306: return alpha ? WGPUBlendFactor_DstAlpha : WGPUBlendFactor_Dst;
    case 0x0307: return alpha ? WGPUBlendFactor_OneMinusDstAlpha : WGPUBlendFactor_OneMinusDst;
    case 0x0308: return WGPUBlendFactor_SrcAlphaSaturated;
    case 0x8001: case 0x8003: return WGPUBlendFactor_Constant;
    case 0x8002: case 0x8004: return WGPUBlendFactor_OneMinusConstant;
    default:     return WGPUBlendFactor_One;
    }
}

static WGPUBlendOperation blend_op(uint32_t e)
{
    switch (e) {
    case 0x800A: return WGPUBlendOperation_Subtract;
    case 0x800B: return WGPUBlendOperation_ReverseSubtract;
    case 0x8007: return WGPUBlendOperation_Min;
    case 0x8008: return WGPUBlendOperation_Max;
    default:     return WGPUBlendOperation_Add;
    }
}

static WGPUCompareFunction cmp_func(uint32_t f)
{
    switch (f) {
    case 0x200: return WGPUCompareFunction_Never;
    case 0x201: return WGPUCompareFunction_Less;
    case 0x202: return WGPUCompareFunction_Equal;
    case 0x203: return WGPUCompareFunction_LessEqual;
    case 0x204: return WGPUCompareFunction_Greater;
    case 0x205: return WGPUCompareFunction_NotEqual;
    case 0x206: return WGPUCompareFunction_GreaterEqual;
    default:    return WGPUCompareFunction_Always;
    }
}

static WGPUStencilOperation stencil_op(uint32_t o)
{
    switch (o) {
    case 0x0000: return WGPUStencilOperation_Zero;
    case 0x1E01: return WGPUStencilOperation_Replace;
    case 0x1E02: return WGPUStencilOperation_IncrementClamp;
    case 0x1E03: return WGPUStencilOperation_DecrementClamp;
    case 0x150A: return WGPUStencilOperation_Invert;
    case 0x8507: return WGPUStencilOperation_IncrementWrap;
    case 0x8508: return WGPUStencilOperation_DecrementWrap;
    default:     return WGPUStencilOperation_Keep;
    }
}

enum { K_PROGRAM, K_PASSTHRU, K_TVERT };
typedef struct {
    uint32_t vs, ps, kind, cube, blend_en, bsrc, bdst, beq, wmask;
    uint32_t has_ds, dt, dw, dfunc, sten, sfunc, sfmask, swmask, sfail, szfail, szpass;
} PipeKey;

#define PIPE_HASH 4096
static struct { uint64_t h; PipeKey k; WGPURenderPipeline p; } s_pipes[PIPE_HASH];
static uint32_t s_npipes;

static WGPURenderPipeline make_pipeline(const PipeKey *k, WGPUShaderModule vs, WGPUShaderModule ps)
{
    WGPURenderPipelineDescriptor pd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    WGPUVertexAttribute at[16];
    WGPUVertexBufferLayout vbl = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
    WGPUFragmentState fs = WGPU_FRAGMENT_STATE_INIT;
    WGPUColorTargetState ct = WGPU_COLOR_TARGET_STATE_INIT;
    WGPUBlendState bs;
    WGPUDepthStencilState ds = WGPU_DEPTH_STENCIL_STATE_INIT;
    int i, n;

    memset(at, 0, sizeof at);
    if (k->kind == K_TVERT) {
        at[0].format = WGPUVertexFormat_Float32x4; at[0].offset = 0;  at[0].shaderLocation = 0;
        at[1].format = WGPUVertexFormat_Unorm8x4;  at[1].offset = 16; at[1].shaderLocation = 1;
        at[2].format = WGPUVertexFormat_Float32x2; at[2].offset = 20; at[2].shaderLocation = 2;
        n = 3; vbl.arrayStride = sizeof(GpTVertex);
    } else {
        n = k->kind == K_PASSTHRU ? 8 : 16;
        for (i = 0; i < n; i++) {
            at[i].format = WGPUVertexFormat_Float32x4; at[i].offset = (uint64_t)i * 16; at[i].shaderLocation = (uint32_t)i;
        }
        vbl.arrayStride = (uint64_t)n * 16;
    }
    vbl.stepMode = WGPUVertexStepMode_Vertex;
    vbl.attributeCount = (size_t)n; vbl.attributes = at;

    pd.layout = s_pl[k->cube & 15];
    pd.vertex.module = vs; pd.vertex.entryPoint = SV("main");
    pd.vertex.bufferCount = 1; pd.vertex.buffers = &vbl;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.cullMode = WGPUCullMode_None;
    if (s_active) pd.multisample.count = (uint32_t)s_msaa;

    ct.format = WGPUTextureFormat_BGRA8Unorm;
    ct.writeMask = k->wmask;
    if (k->blend_en) {
        WGPUBlendOperation op = blend_op(k->beq);
        int mm = op == WGPUBlendOperation_Min || op == WGPUBlendOperation_Max;
        bs.color.operation = op; bs.alpha.operation = op;
        bs.color.srcFactor = mm ? WGPUBlendFactor_One : blend_factor(k->bsrc, 0);
        bs.color.dstFactor = mm ? WGPUBlendFactor_One : blend_factor(k->bdst, 0);
        bs.alpha.srcFactor = mm ? WGPUBlendFactor_One : blend_factor(k->bsrc, 1);
        bs.alpha.dstFactor = mm ? WGPUBlendFactor_One : blend_factor(k->bdst, 1);
        ct.blend = &bs;
    }
    fs.module = ps; fs.entryPoint = SV("main");
    fs.targetCount = 1; fs.targets = &ct;
    pd.fragment = &fs;

    if (k->has_ds) {
        WGPUStencilFaceState face = WGPU_STENCIL_FACE_STATE_INIT;
        ds.format = s_ds_fmt;
        ds.depthWriteEnabled = k->dw ? WGPUOptionalBool_True : WGPUOptionalBool_False;
        ds.depthCompare = k->dt ? cmp_func(k->dfunc) : WGPUCompareFunction_Always;
        face.compare = WGPUCompareFunction_Always;
        face.failOp = face.depthFailOp = face.passOp = WGPUStencilOperation_Keep;
        if (k->sten) {
            face.compare = cmp_func(k->sfunc);
            face.failOp = stencil_op(k->sfail);
            face.depthFailOp = stencil_op(k->szfail);
            face.passOp = stencil_op(k->szpass);
        }
        ds.stencilFront = ds.stencilBack = face;
        ds.stencilReadMask = k->sten ? k->sfmask : 0xFF;
        ds.stencilWriteMask = k->sten ? k->swmask : 0;
        pd.depthStencil = &ds;
    }
    s_npipes++;
    return wgpuDeviceCreateRenderPipeline(s_dev, &pd);
}

static WGPURenderPipeline pipeline(const GpDraw *d, uint32_t kind, uint32_t cube, int has_ds,
                                   WGPUShaderModule vs, WGPUShaderModule ps)
{
    const GpState *st = &d->st;
    uint32_t m = st->color_mask, slot, i;
    PipeKey k;
    uint64_t h;
    memset(&k, 0, sizeof k);
    k.vs = d->vs; k.ps = d->ps; k.kind = kind; k.cube = cube;
    k.blend_en = st->blend_en != 0;
    if (k.blend_en) { k.bsrc = st->blend_src; k.bdst = st->blend_dst; k.beq = st->blend_eq; }
    k.wmask = ((m & 0x00010000) ? WGPUColorWriteMask_Red : 0) | ((m & 0x00000100) ? WGPUColorWriteMask_Green : 0)
            | ((m & 0x00000001) ? WGPUColorWriteMask_Blue : 0) | ((m & 0x01000000) ? WGPUColorWriteMask_Alpha : 0);
    k.has_ds = has_ds != 0;
    k.dt = has_ds && st->depth_test;
    k.dw = k.dt && st->depth_write;
    k.dfunc = k.dt ? st->depth_func : 0;
    k.sten = has_ds && st->stencil_en;
    if (k.sten) {
        k.sfunc = st->stencil_func; k.sfmask = st->stencil_fmask & 0xFF; k.swmask = st->stencil_wmask & 0xFF;
        k.sfail = st->stencil_fail; k.szfail = st->stencil_zfail; k.szpass = st->stencil_zpass;
    }
    h = fnv(&k, sizeof k);
    slot = (uint32_t)h & (PIPE_HASH - 1);
    for (i = 0; i < PIPE_HASH; i++) {
        uint32_t j = (slot + i) & (PIPE_HASH - 1);
        if (s_pipes[j].h == h && !memcmp(&s_pipes[j].k, &k, sizeof k)) return s_pipes[j].p;
        if (!s_pipes[j].h) {
            s_pipes[j].h = h; s_pipes[j].k = k;
            s_pipes[j].p = make_pipeline(&k, vs, ps);
            return s_pipes[j].p;
        }
    }
    return NULL;
}

#define BG_HASH 8192
typedef struct { uint64_t v[9]; } BgKey;
static struct { uint64_t h; BgKey k; WGPUBindGroup g; } s_bgs[BG_HASH];
static uint32_t s_nbgs;

static void bg_flush(void)
{
    uint32_t i;
    for (i = 0; i < BG_HASH; i++)
        if (s_bgs[i].g) wgpuBindGroupRelease(s_bgs[i].g);
    memset(s_bgs, 0, sizeof s_bgs);
    s_nbgs = 0;
    s_bg_flush = 0;
}

static WGPUBindGroup tex_group(uint32_t cube, WGPUTextureView v[4], WGPUSampler s[4])
{
    BgKey k;
    uint64_t h;
    uint32_t slot, i;
    int st;
    k.v[0] = cube;
    for (st = 0; st < 4; st++) { k.v[1 + st] = (uint64_t)(uintptr_t)v[st]; k.v[5 + st] = (uint64_t)(uintptr_t)s[st]; }
    if (s_nbgs > BG_HASH * 3 / 4) bg_flush();
    h = fnv(&k, sizeof k);
    slot = (uint32_t)h & (BG_HASH - 1);
    for (i = 0; i < BG_HASH; i++) {
        uint32_t j = (slot + i) & (BG_HASH - 1);
        if (s_bgs[j].h == h && !memcmp(&s_bgs[j].k, &k, sizeof k)) return s_bgs[j].g;
        if (!s_bgs[j].h) {
            WGPUBindGroupEntry e[8];
            memset(e, 0, sizeof e);
            for (st = 0; st < 4; st++) {
                e[st].binding = (uint32_t)st; e[st].textureView = v[st];
                e[4 + st].binding = (uint32_t)(4 + st); e[4 + st].sampler = s[st];
            }
            s_bgs[j].h = h; s_bgs[j].k = k;
            s_bgs[j].g = wgpuDeviceCreateBindGroup(s_dev, &(WGPUBindGroupDescriptor){
                .layout = s_bgl1[cube & 15], .entryCount = 8, .entries = e });
            s_nbgs++;
            return s_bgs[j].g;
        }
    }
    return NULL;
}

/* ---- passes and records -------------------------------------------------- */

static WGPURenderPassEncoder s_pass;
static uint32_t s_cur_target, s_cur_zeta;
static struct { uint64_t draws, tris, skipped, clears, passes, no_vs, no_ps, no_rt, z_scratch, sub_copies; } s_st;

static void end_pass(void)
{
    if (s_pass) { wgpuRenderPassEncoderEnd(s_pass); wgpuRenderPassEncoderRelease(s_pass); s_pass = NULL; }
}

static void begin_pass(Res *rt, Res *ds, const float *clear_rgba, const float *clear_z, const uint32_t *clear_s)
{
    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    WGPURenderPassDepthStencilAttachment da = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
    WGPURenderPassDescriptor pd = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    ca.view = s_active ? draw_view(rt) : rt->view;
    ca.loadOp = clear_rgba ? WGPULoadOp_Clear : WGPULoadOp_Load;
    ca.storeOp = WGPUStoreOp_Store;
    if (clear_rgba) ca.clearValue = (WGPUColor){ clear_rgba[0], clear_rgba[1], clear_rgba[2], clear_rgba[3] };
    pd.colorAttachmentCount = 1; pd.colorAttachments = &ca;
    if (ds) {
        da.view = ds->view;
        da.depthLoadOp = clear_z ? WGPULoadOp_Clear : WGPULoadOp_Load;
        da.depthStoreOp = WGPUStoreOp_Store;
        da.depthClearValue = clear_z ? *clear_z : 1.0f;
        da.stencilLoadOp = clear_s ? WGPULoadOp_Clear : WGPULoadOp_Load;
        da.stencilStoreOp = WGPUStoreOp_Store;
        da.stencilClearValue = clear_s ? *clear_s : 0;
        pd.depthStencilAttachment = &da;
    }
    end_pass();
    s_pass = wgpuCommandEncoderBeginRenderPass(s_enc, &pd);
    if (s_active) {
        wgpuRenderPassEncoderSetViewport(s_pass, 0, 0, (float)rt->sw, (float)rt->sh, 0, 1);
        if (rt->ms) rt->msdirty = 1;
    } else
    wgpuRenderPassEncoderSetViewport(s_pass, 0, 0, (float)rt->w, (float)rt->h, 0, 1);
    s_st.passes++;
}

/* A depth whose size differs from the target cannot be attached in WebGPU
 * (D3D11 accepts a larger one, using its top-left corner). Such a use gets a
 * scratch depth of the target's size, one per (depth id, size); its contents
 * are not shared with the big one -- fine for the title's render-to-texture
 * passes, which clear Z first. Counted as z_scratch. */
#define MAX_SCRATCH 32
static struct { uint32_t zeta, w, h; Res r; } s_scratch[MAX_SCRATCH];
static int s_nscratch;

static Res *depth_for(const GpDraw *d, const Res *rt, uint32_t *key)
{
    Res *ds = d->zeta ? res(d->zeta) : NULL;
    int i;
    *key = 0;
    if (!ds || ds->kind != R_DS) return NULL;
    *key = d->zeta;
    if (s_active ? ds->sw == rt->sw && ds->sh == rt->sh : ds->w == rt->w && ds->h == rt->h) return ds;
    s_st.z_scratch++;
    for (i = 0; i < s_nscratch; i++)
        if (s_scratch[i].zeta == d->zeta && s_scratch[i].w == rt->w && s_scratch[i].h == rt->h) break;
    if (i == s_nscratch) {
        if (s_nscratch == MAX_SCRATCH) { *key = 0; return NULL; }
        s_scratch[i].zeta = d->zeta; s_scratch[i].w = rt->w; s_scratch[i].h = rt->h;
        memset(&s_scratch[i].r, 0, sizeof s_scratch[i].r);
        if (s_active)
            s_scratch[i].r.tex = make_tex_n(rt->sw, rt->sh, s_ds_fmt, WGPUTextureUsage_RenderAttachment, (uint32_t)s_msaa);
        else
        s_scratch[i].r.tex = make_tex(rt->w, rt->h, 1, s_ds_fmt, WGPUTextureUsage_RenderAttachment);
        s_scratch[i].r.view = wgpuTextureCreateView(s_scratch[i].r.tex, NULL);
        s_scratch[i].r.kind = R_DS; s_scratch[i].r.w = rt->w; s_scratch[i].r.h = rt->h;
        s_nscratch++;
    }
    *key = d->zeta | 0x80000000u | ((uint32_t)i << 24);
    return &s_scratch[i].r;
}

static Res *bind_target(const GpDraw *d, Res **ds_out)
{
    Res *rt = res(d->target), *ds;
    if (!rt || rt->kind != R_RT) return NULL;
    rt->swz = d->target_swz;               /* the frame's last use decides */
    uint32_t zkey;
    ds = depth_for(d, rt, &zkey);
    if (!s_pass || s_cur_target != d->target || s_cur_zeta != zkey) {
        begin_pass(rt, ds, NULL, NULL, NULL);
        s_cur_target = d->target;
        s_cur_zeta = zkey;
    }
    rt->dirty = 1;
    *ds_out = ds;
    return rt;
}

static void do_clear(const GpDraw *d)
{
    Res *rt = res(d->target), *ds;
    float c[4], z;
    uint32_t s, zkey;
    if (!rt || rt->kind != R_RT) return;
    ds = depth_for(d, rt, &zkey);
    c[0] = ((d->clr_argb >> 16) & 0xFF) / 255.0f; c[1] = ((d->clr_argb >> 8) & 0xFF) / 255.0f;
    c[2] = (d->clr_argb & 0xFF) / 255.0f;         c[3] = (d->clr_argb >> 24) / 255.0f;
    z = d->zeta_format == 1 ? (float)(d->clr_zs & 0xFFFF) / 65535.0f : (float)(d->clr_zs >> 8) / 16777215.0f;
    s = d->clr_zs & 0xFF;
    begin_pass(rt, ds, (d->clr_flags & 0xF0) ? c : NULL,
               (ds && (d->clr_flags & 1)) ? &z : NULL, (ds && (d->clr_flags & 2)) ? &s : NULL);
    s_cur_target = d->target; s_cur_zeta = zkey;
    rt->dirty = 1;
    s_st.clears++;
}

static void do_draw(const GpDraw *d, const Slots *sl)
{
    WGPUShaderModule vs, ps;
    WGPUTextureView views[4];
    WGPUSampler smps[4];
    WGPURenderPipeline pipe;
    uint32_t kind, cube = 0, offs[4];
    Res *rt, *ds;
    double bc[4];
    int st;

    if (d->vs == GP_VS_TVERT) { vs = s_vs_tv; kind = K_TVERT; }
    else if (d->vs == GP_VS_PASSTHRU) { vs = s_vs_pass; kind = K_PASSTHRU; }
    else { Res *r = res(d->vs); vs = r && r->kind == R_VS ? r->mod : NULL; kind = K_PROGRAM; }
    if (d->ps == GP_PS_TVERT) ps = s_ps_tv;
    else { Res *r = res(d->ps); ps = r && r->kind == R_PS ? r->mod : NULL; cube = ps ? r->cube : 0; }
    if (!vs) { s_st.no_vs++; s_st.skipped++; return; }
    if (!ps) { s_st.no_ps++; s_st.skipped++; return; }
    if (!d->vtx_count) { s_st.skipped++; return; }
    /* Tiles of render targets are copied out first: a copy cannot happen
     * inside a render pass, so this ends the current one (bind_target opens
     * the next). As D3D11: none when the tile's source is the draw's target. */
    for (st = 0; st < 4; st++) {
        uint32_t id = d->tex[st];
        Res *r, *src;
        if (s_active && id && (id & GP_TEX_RT) && (id & ~GP_TEX_RT) != d->target
            && (r = res(id & ~GP_TEX_RT)) && r->kind == R_RT)
            resolve(r);                       /* MSAA: sampled from tex */
        if (!id || (id & GP_TEX_RT) || !(r = res(id)) || r->kind != R_SUB) continue;
        src = res(r->va);
        if (s_active && src && src->kind == R_RT && r->va != d->target
            && r->bx + r->sw <= src->sw && r->by + r->sh <= src->sh) {
            resolve(src);
            end_pass();
            wgpuCommandEncoderCopyTextureToTexture(s_enc,
                &(WGPUTexelCopyTextureInfo){ .texture = src->tex, .origin = { r->bx, r->by, 0 },
                                             .aspect = WGPUTextureAspect_All },
                &(WGPUTexelCopyTextureInfo){ .texture = r->tex, .aspect = WGPUTextureAspect_All },
                &(WGPUExtent3D){ r->sw, r->sh, 1 });
            s_st.sub_copies++;
            continue;
        }
        if (s_active) continue;
        if (!src || src->kind != R_RT || r->va == d->target
            || (r->pitch & 0xFFFF) + r->w > src->w || (r->pitch >> 16) + r->h > src->h)
            continue;
        end_pass();
        wgpuCommandEncoderCopyTextureToTexture(s_enc,
            &(WGPUTexelCopyTextureInfo){ .texture = src->tex, .origin = { r->pitch & 0xFFFF, r->pitch >> 16, 0 },
                                         .aspect = WGPUTextureAspect_All },
            &(WGPUTexelCopyTextureInfo){ .texture = r->tex, .aspect = WGPUTextureAspect_All },
            &(WGPUExtent3D){ r->w, r->h, 1 });
        s_st.sub_copies++;
    }
    if (!(rt = bind_target(d, &ds))) { s_st.no_rt++; s_st.skipped++; return; }

    for (st = 0; st < 4; st++) {
        uint32_t id = d->tex[st], want_cube = (cube >> st) & 1;
        WGPUTextureView v = NULL;
        if (id) {
            if (id & GP_TEX_RT) { id &= ~GP_TEX_RT; if (id == d->target) id = 0; }   /* own target: 0 */
            if (id) {
                Res *r = res(id);
                if (r && r->kind == R_SUB && (r->va == d->target || res(r->va)->kind != R_RT)) r = NULL;
                if (r && (r->kind == R_TEX || r->kind == R_RT || r->kind == R_SUB) && r->view
                    && (r->cube != 0) == (want_cube != 0))
                    v = r->view;
            }
        }
        views[st] = v ? v : (want_cube ? s_dummy_cube : s_dummy2d);
        smps[st] = v ? sampler(d->smp[st]) : s_default_smp;
    }
    if (!(pipe = pipeline(d, kind, cube, ds != NULL, vs, ps))) { s_st.skipped++; return; }

    wgpuRenderPassEncoderSetPipeline(s_pass, pipe);
    offs[0] = sl->xf; offs[1] = sl->vsc; offs[2] = sl->ps; offs[3] = sl->smp;
    wgpuRenderPassEncoderSetBindGroup(s_pass, 0, s_group0, 4, offs);
    wgpuRenderPassEncoderSetBindGroup(s_pass, 1, tex_group(cube, views, smps), 0, NULL);
    bc[0] = ((d->st.blend_color >> 16) & 0xFF) / 255.0; bc[1] = ((d->st.blend_color >> 8) & 0xFF) / 255.0;
    bc[2] = (d->st.blend_color & 0xFF) / 255.0;         bc[3] = (d->st.blend_color >> 24) / 255.0;
    if (d->st.blend_src == 0x8003 || d->st.blend_src == 0x8004
     || d->st.blend_dst == 0x8003 || d->st.blend_dst == 0x8004)
        bc[0] = bc[1] = bc[2] = bc[3];
    wgpuRenderPassEncoderSetBlendConstant(s_pass, &(WGPUColor){ bc[0], bc[1], bc[2], bc[3] });
    if (ds) wgpuRenderPassEncoderSetStencilReference(s_pass, d->st.stencil_ref & 0xFF);
    wgpuRenderPassEncoderSetVertexBuffer(s_pass, 0, s_vb.b, d->vtx_off, (uint64_t)d->vtx_count * d->vtx_stride);
    if (d->idx_count) {
        wgpuRenderPassEncoderSetIndexBuffer(s_pass, s_ib.b, WGPUIndexFormat_Uint32,
                                            (uint64_t)d->idx_off * 4, (uint64_t)d->idx_count * 4);
        wgpuRenderPassEncoderDrawIndexed(s_pass, d->idx_count, 1, 0, 0, 0);
        s_st.tris += d->idx_count / 3;
    } else {
        wgpuRenderPassEncoderDraw(s_pass, d->vtx_count, 1, 0, 0);
        s_st.tris += d->vtx_count / 3;
    }
    s_st.draws++;
}

/* ---- writeback ----------------------------------------------------------- */

static void on_map(WGPUMapAsyncStatus st, WGPUStringView msg, void *u1, void *u2)
{
    (void)msg; (void)u2;
    if (st != WGPUMapAsyncStatus_Success)
        fprintf(stderr, "  [WGPU] map failed %d: %.*s\n", (int)st, (int)msg.length, msg.data);
    *(volatile int *)u1 = st == WGPUMapAsyncStatus_Success ? 1 : 2;
}

static uint32_t rb_pitch(const Res *r) { return (r->w * 4 + 255) & ~255u; }

/* Queue the copy into the target's staging buffer (same command buffer). */
static void writeback_copy(Res *r)
{
    uint32_t bpr = rb_pitch(r);
    WGPUTexture src = r->tex;
    if (s_active) {
        /* MSAA resolved; a scaled target box-filtered to the guest size. */
        resolve(r);
        if (r->sw != r->w || r->sh != r->h) {
            if (!r->down) {
                r->down = make_tex(r->w, r->h, 1, WGPUTextureFormat_BGRA8Unorm,
                                   WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc);
                r->downview = wgpuTextureCreateView(r->down, NULL);
            }
            blit(r->view, r->sw, r->sh, r->downview, WGPUTextureFormat_BGRA8Unorm, 1, 0,
                 0, 0, (float)r->w, (float)r->h);
            src = r->down;
        }
    }
    if (!r->rb) {
        WGPUBufferDescriptor bd = WGPU_BUFFER_DESCRIPTOR_INIT;
        bd.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead; bd.size = (uint64_t)bpr * r->h;
        r->rb = wgpuDeviceCreateBuffer(s_dev, &bd);
    }
    wgpuCommandEncoderCopyTextureToBuffer(s_enc,
        &(WGPUTexelCopyTextureInfo){ .texture = src, .aspect = WGPUTextureAspect_All },
        &(WGPUTexelCopyBufferInfo){ .buffer = r->rb, .layout = { .bytesPerRow = bpr, .rowsPerImage = r->h } },
        &(WGPUExtent3D){ r->w, r->h, 1 });
}

static volatile int s_map_done[256];

static void writeback_store(Res *r, volatile int *done)
{
    uint8_t *mem = (uint8_t *)xbox_GetMemoryOffset();
    uint32_t bpr = rb_pitch(r), y, x;
    size_t n = (size_t)bpr * r->h;
    const uint8_t *src;
    if (*done != 1) return;
    src = (const uint8_t *)wgpuBufferGetConstMappedRange(r->rb, 0, n);
    for (y = 0; src && y < r->h; y++) {
        const uint32_t *row = (const uint32_t *)(src + (size_t)y * bpr);
        uint8_t *dst = mem + r->va + (size_t)y * r->pitch;
        if (r->bpp == 4) memcpy(dst, row, (size_t)r->w * 4);
        else for (x = 0; x < r->w; x++) {           /* argb_to_16 in gpu_d3d11.c */
            uint32_t c = row[x], rr = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
            ((uint16_t *)dst)[x] = r->fmt == 3 ? (uint16_t)(((rr >> 3) << 11) | ((g >> 2) << 5) | (b >> 3))
                                               : (uint16_t)(((rr >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
        }
    }
    wgpuBufferUnmap(r->rb);
}

/* Map every dirty target's staging buffer, wait once, store them all. */
static void writeback_all(void)
{
    int j, n = 0, k;
    uint32_t ids[256];
    for (j = 0; j < s_nrt_ids && n < 256; j++) {
        Res *r = res(s_rt_ids[j]);
        if (!r->dirty) continue;
        r->dirty = 0;
        if (!r->rb) continue;
        s_map_done[n] = 0;
        wgpuBufferMapAsync(r->rb, WGPUMapMode_Read, 0, (size_t)rb_pitch(r) * r->h, (WGPUBufferMapCallbackInfo){
            .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_map, .userdata1 = (void *)&s_map_done[n] });
        ids[n++] = s_rt_ids[j];
    }
    for (k = 0; k < 100000; k++) {
        int all = 1;
        for (j = 0; j < n; j++) if (!s_map_done[j]) { all = 0; break; }
        if (all) break;
        wgpuDevicePoll(s_dev, 1, NULL);
        wgpuInstanceProcessEvents(s_inst);
    }
    for (j = 0; j < n; j++) writeback_store(res(ids[j]), &s_map_done[j]);
}

/* ---- display options: scaling, MSAA, presenting (gpu_display.h) ---------- */

static SRWLOCK s_lock = SRWLOCK_INIT;   /* consume (flip thread) vs pixels() (window thread) */
static float s_want_sx = 1.0f, s_want_sy = 1.0f;   /* "window": the scale the next frame uses */
static WGPUBindGroupLayout s_blit_bgl;
static WGPUPipelineLayout s_blit_pl;
static WGPUShaderModule s_blit_mod;
static WGPUSampler s_blit_smp;
static GBuf s_blit_ub;
static uint32_t s_blit_slot;              /* 256-byte uniform slots used in this submit */
#define BLIT_SLOTS 1024
static struct { WGPUTextureFormat f; uint32_t n; WGPURenderPipeline p; } s_blit_pipes[8];

/* blit() in gpu_d3d11.c: bilinear when enlarging, a box filter when
 * reducing (taps at texel centres at whole ratios). */
static const char s_blit_wgsl[] =
"struct B { ratio: vec2f, srcsize: vec2f, origin: vec2f, pad: vec2f };\n"
"@group(0) @binding(0) var t: texture_2d<f32>;\n"
"@group(0) @binding(1) var s: sampler;\n"
"@group(0) @binding(2) var<uniform> u: B;\n"
"@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
"  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));\n"
"  return vec4f(q * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);\n"
"}\n"
"@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {\n"
"  let d = p.xy - u.origin;\n"
"  if (u.ratio.x <= 1.0 && u.ratio.y <= 1.0) { return textureSampleLevel(t, s, d * u.ratio / u.srcsize, 0.0); }\n"
"  let nx = max(i32(ceil(u.ratio.x - 0.001)), 1);\n"
"  let ny = max(i32(ceil(u.ratio.y - 0.001)), 1);\n"
"  let p0 = floor(d) * u.ratio;\n"
"  let st = u.ratio / vec2f(f32(nx), f32(ny));\n"
"  var c = vec4f(0.0);\n"
"  for (var y = 0; y < ny; y++) { for (var x = 0; x < nx; x++) {\n"
"    c += textureSampleLevel(t, s, (p0 + (vec2f(f32(x), f32(y)) + 0.5) * st) / u.srcsize, 0.0); } }\n"
"  return c / f32(nx * ny);\n"
"}\n";

static int display_init(void)
{
    const GpDisplay *g = gp_display();
    WGPUBindGroupLayoutEntry e[3];
    WGPUSamplerDescriptor sd = WGPU_SAMPLER_DESCRIPTOR_INIT;
    if (!g->active) return 1;
    s_active = 1;
    gp_display_scale_for(0, 0, &s_sx, &s_sy);
    s_want_sx = s_sx; s_want_sy = s_sy;
    s_msaa = g->msaa > 4 ? 4 : g->msaa;   /* WebGPU guarantees 1 and 4; 2 is allowed for BGRA8 by wgpu */
    memset(e, 0, sizeof e);
    e[0].binding = 0; e[0].visibility = WGPUShaderStage_Fragment;
    e[0].texture.sampleType = WGPUTextureSampleType_Float; e[0].texture.viewDimension = WGPUTextureViewDimension_2D;
    e[1].binding = 1; e[1].visibility = WGPUShaderStage_Fragment; e[1].sampler.type = WGPUSamplerBindingType_Filtering;
    e[2].binding = 2; e[2].visibility = WGPUShaderStage_Fragment;
    e[2].buffer.type = WGPUBufferBindingType_Uniform; e[2].buffer.hasDynamicOffset = 1; e[2].buffer.minBindingSize = 32;
    s_blit_bgl = wgpuDeviceCreateBindGroupLayout(s_dev, &(WGPUBindGroupLayoutDescriptor){ .entryCount = 3, .entries = e });
    s_blit_pl = wgpuDeviceCreatePipelineLayout(s_dev, &(WGPUPipelineLayoutDescriptor){ .bindGroupLayoutCount = 1, .bindGroupLayouts = &s_blit_bgl });
    s_blit_mod = wgsl_module(s_blit_wgsl, (uint32_t)(sizeof s_blit_wgsl - 1), "blit");
    sd.magFilter = sd.minFilter = WGPUFilterMode_Linear;
    s_blit_smp = wgpuDeviceCreateSampler(s_dev, &sd);
    gbuf(&s_blit_ub, (uint64_t)BLIT_SLOTS * 256, WGPUBufferUsage_Uniform);
    fprintf(stderr, "  [WGPU] display: scale %.3f x %.3f%s, MSAA %dx\n", s_sx, s_sy,
            g->window ? " (follows the window)" : "", s_msaa);
    return s_blit_bgl && s_blit_pl && s_blit_mod && s_blit_smp;
}

static WGPURenderPipeline blit_pipe(WGPUTextureFormat f, uint32_t samples)
{
    WGPURenderPipelineDescriptor pd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    WGPUFragmentState fs = WGPU_FRAGMENT_STATE_INIT;
    WGPUColorTargetState ct = WGPU_COLOR_TARGET_STATE_INIT;
    int i;
    for (i = 0; i < 8 && s_blit_pipes[i].p; i++)
        if (s_blit_pipes[i].f == f && s_blit_pipes[i].n == samples) return s_blit_pipes[i].p;
    if (i == 8) return NULL;
    ct.format = f; ct.writeMask = WGPUColorWriteMask_All;
    fs.module = s_blit_mod; fs.entryPoint = SV("fs"); fs.targetCount = 1; fs.targets = &ct;
    pd.layout = s_blit_pl;
    pd.vertex.module = s_blit_mod; pd.vertex.entryPoint = SV("vs");
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.cullMode = WGPUCullMode_None;
    pd.multisample.count = samples;
    pd.fragment = &fs;
    s_blit_pipes[i].f = f; s_blit_pipes[i].n = samples;
    s_blit_pipes[i].p = wgpuDeviceCreateRenderPipeline(s_dev, &pd);
    return s_blit_pipes[i].p;
}

/* Scale `src` (srcw x srch) into x,y,w,h of `dst`, in s_enc, in its own
 * pass (ends the current one). clear: the rest of dst goes black. */
static void blit(WGPUTextureView src, uint32_t srcw, uint32_t srch, WGPUTextureView dst,
                 WGPUTextureFormat fmt, uint32_t samples, int clear,
                 float x, float y, float w, float h)
{
    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    WGPURenderPassDescriptor pd = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    WGPURenderPassEncoder p;
    WGPUBindGroup bg;
    WGPUBindGroupEntry be[3];
    WGPURenderPipeline pipe = blit_pipe(fmt, samples);
    float u[8];
    uint32_t off;
    if (!pipe || s_blit_slot >= BLIT_SLOTS) return;
    off = s_blit_slot++ * 256;
    u[0] = (float)srcw / w; u[1] = (float)srch / h; u[2] = (float)srcw; u[3] = (float)srch;
    u[4] = x; u[5] = y; u[6] = u[7] = 0;
    wgpuQueueWriteBuffer(s_queue, s_blit_ub.b, off, u, sizeof u);
    memset(be, 0, sizeof be);
    be[0].binding = 0; be[0].textureView = src;
    be[1].binding = 1; be[1].sampler = s_blit_smp;
    be[2].binding = 2; be[2].buffer = s_blit_ub.b; be[2].size = 32;
    bg = wgpuDeviceCreateBindGroup(s_dev, &(WGPUBindGroupDescriptor){ .layout = s_blit_bgl, .entryCount = 3, .entries = be });
    end_pass();
    ca.view = dst;
    ca.loadOp = clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
    ca.storeOp = WGPUStoreOp_Store;
    ca.clearValue = (WGPUColor){ 0, 0, 0, 1 };
    pd.colorAttachmentCount = 1; pd.colorAttachments = &ca;
    p = wgpuCommandEncoderBeginRenderPass(s_enc, &pd);
    wgpuRenderPassEncoderSetViewport(p, x, y, w, h, 0, 1);
    wgpuRenderPassEncoderSetPipeline(p, pipe);
    wgpuRenderPassEncoderSetBindGroup(p, 0, bg, 1, &off);
    wgpuRenderPassEncoderDraw(p, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(p);
    wgpuRenderPassEncoderRelease(p);
    wgpuBindGroupRelease(bg);
}

/* MSAA: the multisampled picture into tex (an empty pass that resolves). */
static void resolve(Res *r)
{
    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    WGPURenderPassDescriptor pd = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    WGPURenderPassEncoder p;
    if (!r->ms || !r->msdirty) return;
    end_pass();
    ca.view = r->msview; ca.resolveTarget = r->view;
    ca.loadOp = WGPULoadOp_Load; ca.storeOp = WGPUStoreOp_Store;
    pd.colorAttachmentCount = 1; pd.colorAttachments = &ca;
    p = wgpuCommandEncoderBeginRenderPass(s_enc, &pd);
    wgpuRenderPassEncoderEnd(p);
    wgpuRenderPassEncoderRelease(p);
    r->msdirty = 0;
}

static WGPUTextureView draw_view(Res *r) { return r->msview ? r->msview : r->view; }

static WGPUTexture make_tex_n(uint32_t w, uint32_t h, WGPUTextureFormat f, WGPUTextureUsage u, uint32_t samples)
{
    WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
    td.usage = u; td.size = (WGPUExtent3D){ w, h, 1 }; td.format = f; td.sampleCount = samples;
    return wgpuDeviceCreateTexture(s_dev, &td);
}

/* A render target at the current scale (r->w, r->h guest): tex/view are
 * what is sampled, copied, written back and presented; with MSAA draws go
 * into ms and are resolved into tex. */
static void rt_make(Res *r)
{
    r->sw = gp_scaled(r->w, s_sx); r->sh = gp_scaled(r->h, s_sy);
    r->tex = make_tex(r->sw, r->sh, 1, WGPUTextureFormat_BGRA8Unorm,
                      WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding
                      | WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst);
    r->view = wgpuTextureCreateView(r->tex, NULL);
    if (s_msaa > 1) {
        r->ms = make_tex_n(r->sw, r->sh, WGPUTextureFormat_BGRA8Unorm, WGPUTextureUsage_RenderAttachment, (uint32_t)s_msaa);
        r->msview = wgpuTextureCreateView(r->ms, NULL);
    }
}

/* "window": every target remade at the new scale with its picture scaled
 * across; depth, tiles and scratch depth remade. Old textures are released,
 * not destroyed: this encoder still reads them. */
static void rescale(float sx, float sy)
{
    uint32_t i;
    int k;
    float ox = s_sx, oy = s_sy;
    s_sx = sx; s_sy = sy;
    for (i = 0; i < s_nres; i++) {
        Res *r = &s_res[i];
        if (r->kind == R_RT) {
            Res old;
            resolve(r);
            old = *r;
            r->tex = NULL; r->view = NULL; r->ms = NULL; r->msview = NULL; r->msdirty = 0;
            rt_make(r);
            blit(old.view, old.sw, old.sh, draw_view(r), WGPUTextureFormat_BGRA8Unorm,
                 r->ms ? (uint32_t)s_msaa : 1, 0, 0, 0, (float)r->sw, (float)r->sh);
            if (r->ms) r->msdirty = 1;
            if (old.view) wgpuTextureViewRelease(old.view);
            if (old.tex) wgpuTextureRelease(old.tex);
            if (old.msview) wgpuTextureViewRelease(old.msview);
            if (old.ms) wgpuTextureRelease(old.ms);
            s_bg_flush = 1;
        } else if (r->kind == R_DS) {
            GpCmd c;
            memset(&c, 0, sizeof c);
            c.id = i; c.b = r->w; c.c = r->h;
            q_ds_create(&c);
        } else if (r->kind == R_SUB) {
            GpCmd c;
            memset(&c, 0, sizeof c);
            c.id = i; c.a = r->va; c.b = r->w; c.c = r->h; c.d = r->pitch;
            q_sub_create(&c);
        }
    }
    for (k = 0; k < s_nscratch; k++) {
        if (s_scratch[k].r.view) wgpuTextureViewRelease(s_scratch[k].r.view);
        if (s_scratch[k].r.tex) wgpuTextureRelease(s_scratch[k].r.tex);
    }
    s_nscratch = 0;
    fprintf(stderr, "  [WGPU] display: scale %.3f x %.3f -> %.3f x %.3f\n", ox, oy, sx, sy);
}

/* ---- the window's presenter (fb_presenter.h, via gpu_display.c) ---------- */

static WGPUSurface s_surf;
static int s_surf_failed;
static uint32_t s_surf_w, s_surf_h;
static WGPUTextureFormat s_surf_fmt;
static WGPUPresentMode s_surf_mode;
static WGPUTexture s_px_tex;
static WGPUTextureView s_px_view;
static uint32_t s_px_w, s_px_h;

static int surf_ready(HWND h)
{
    RECT rc;
    uint32_t cw, ch;
    if (s_surf_failed || !GetClientRect(h, &rc)) return 0;
    cw = (uint32_t)(rc.right - rc.left); ch = (uint32_t)(rc.bottom - rc.top);
    if (!cw || !ch) return 0;
    if (!s_surf) {
        WGPUSurfaceSourceWindowsHWND src;
        WGPUSurfaceDescriptor sd = { 0 };
        WGPUSurfaceCapabilities caps = WGPU_SURFACE_CAPABILITIES_INIT;
        size_t k;
        memset(&src, 0, sizeof src);
        src.chain.sType = WGPUSType_SurfaceSourceWindowsHWND;
        src.hinstance = GetModuleHandleA(NULL);
        src.hwnd = h;
        sd.nextInChain = &src.chain;
        s_surf = wgpuInstanceCreateSurface(s_inst, &sd);
        if (!s_surf || wgpuSurfaceGetCapabilities(s_surf, s_adapter, &caps) != WGPUStatus_Success
            || !caps.formatCount) {
            fprintf(stderr, "  [WGPU] no window surface: the window shows the guest-size frame\n");
            s_surf_failed = 1;
            return 0;
        }
        s_surf_fmt = caps.formats[0];
        for (k = 0; k < caps.formatCount; k++)
            if (caps.formats[k] == WGPUTextureFormat_BGRA8Unorm) s_surf_fmt = caps.formats[k];
        s_surf_mode = WGPUPresentMode_Fifo;
        for (k = 0; k < caps.presentModeCount; k++)       /* not waiting for vsync: the flip pacing is the clock */
            if (caps.presentModes[k] == WGPUPresentMode_Immediate && s_surf_mode != WGPUPresentMode_Mailbox)
                s_surf_mode = WGPUPresentMode_Immediate;
            else if (caps.presentModes[k] == WGPUPresentMode_Mailbox)
                s_surf_mode = WGPUPresentMode_Mailbox;
        wgpuSurfaceCapabilitiesFreeMembers(caps);
        fprintf(stderr, "  [WGPU] presenting the full-size image to the window (format %d, present mode %d)\n",
                (int)s_surf_fmt, (int)s_surf_mode);
    }
    if (cw != s_surf_w || ch != s_surf_h) {
        WGPUSurfaceConfiguration cfg = WGPU_SURFACE_CONFIGURATION_INIT;
        cfg.device = s_dev; cfg.format = s_surf_fmt; cfg.usage = WGPUTextureUsage_RenderAttachment;
        cfg.width = cw; cfg.height = ch; cfg.presentMode = s_surf_mode;
        cfg.alphaMode = WGPUCompositeAlphaMode_Auto;
        wgpuSurfaceConfigure(s_surf, &cfg);
        s_surf_w = cw; s_surf_h = ch;
    }
    return 1;
}

/* src letterboxed to aw:ah on black, submitted with s_enc, and presented. */
static void surf_show(WGPUTextureView src, uint32_t sw, uint32_t sh, uint32_t aw, uint32_t ah)
{
    WGPUSurfaceTexture st;
    WGPUTextureView v = NULL;
    WGPUCommandBuffer cb;
    float w = (float)s_surf_w, h = w * (float)ah / (float)aw;
    memset(&st, 0, sizeof st);
    wgpuSurfaceGetCurrentTexture(s_surf, &st);
    if (st.texture && (st.status == WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal
                       || st.status == WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal)) {
        if (h > (float)s_surf_h) { h = (float)s_surf_h; w = h * (float)aw / (float)ah; }
        w = (float)(int)(w + 0.5f); h = (float)(int)(h + 0.5f);
        v = wgpuTextureCreateView(st.texture, NULL);
        blit(src, sw, sh, v, s_surf_fmt, 1, 1, (float)(int)((s_surf_w - w) / 2),
             (float)(int)((s_surf_h - h) / 2), w, h);
    } else if (st.status == WGPUSurfaceGetCurrentTextureStatus_Outdated
               || st.status == WGPUSurfaceGetCurrentTextureStatus_Lost) {
        s_surf_w = s_surf_h = 0;                     /* reconfigure next time */
    }
    cb = wgpuCommandEncoderFinish(s_enc, NULL);
    wgpuQueueSubmit(s_queue, 1, &cb);
    wgpuCommandBufferRelease(cb);
    wgpuCommandEncoderRelease(s_enc);
    s_enc = NULL;
    s_blit_slot = 0;
    if (v) {
        wgpuSurfacePresent(s_surf);
        wgpuTextureViewRelease(v);
    }
    if (st.texture) wgpuTextureRelease(st.texture);
}

/* RECOMP_HIRES_DUMP: tex (w x h) read back and written as a BMP. */
static void dump_tex(WGPUTexture tex, uint32_t w, uint32_t h)
{
    uint32_t bpr = (w * 4 + 255) & ~255u;
    WGPUBufferDescriptor bd = WGPU_BUFFER_DESCRIPTOR_INIT;
    WGPUBuffer b;
    WGPUCommandEncoder e;
    WGPUCommandBuffer cb;
    volatile int done = 0;
    int k;
    bd.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead; bd.size = (uint64_t)bpr * h;
    b = wgpuDeviceCreateBuffer(s_dev, &bd);
    e = wgpuDeviceCreateCommandEncoder(s_dev, NULL);
    wgpuCommandEncoderCopyTextureToBuffer(e,
        &(WGPUTexelCopyTextureInfo){ .texture = tex, .aspect = WGPUTextureAspect_All },
        &(WGPUTexelCopyBufferInfo){ .buffer = b, .layout = { .bytesPerRow = bpr, .rowsPerImage = h } },
        &(WGPUExtent3D){ w, h, 1 });
    cb = wgpuCommandEncoderFinish(e, NULL);
    wgpuQueueSubmit(s_queue, 1, &cb);
    wgpuCommandBufferRelease(cb);
    wgpuCommandEncoderRelease(e);
    wgpuBufferMapAsync(b, WGPUMapMode_Read, 0, (size_t)bpr * h, (WGPUBufferMapCallbackInfo){
        .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_map, .userdata1 = (void *)&done });
    for (k = 0; k < 100000 && !done; k++) { wgpuDevicePoll(s_dev, 1, NULL); wgpuInstanceProcessEvents(s_inst); }
    if (done == 1) {
        const uint8_t *p = (const uint8_t *)wgpuBufferGetConstMappedRange(b, 0, (size_t)bpr * h);
        if (p) gp_display_dump_bgra(p, bpr, w, h);
        wgpuBufferUnmap(b);
    }
    wgpuBufferDestroy(b);
    wgpuBufferRelease(b);
}

int gp_wgpu_present_frame(void *hwnd, uint32_t fb_va, uint32_t aw, uint32_t ah)
{
    Res *best = NULL;
    int j, shown = 0;
    if (!s_active || !s_dev || s_failed) return 0;
    AcquireSRWLockExclusive(&s_lock);
    for (j = 0; j < s_nrt_ids; j++) {
        Res *r = res(s_rt_ids[j]);
        if (r && r->kind == R_RT && ((r->va ^ fb_va) & 0x03FFFFFFu) == 0 && (!best || !r->swz)) best = r;
    }
    if (best) {
        s_enc = wgpuDeviceCreateCommandEncoder(s_dev, NULL);
        s_pass = NULL;
        resolve(best);
        if (surf_ready((HWND)hwnd)) {
            surf_show(best->view, best->sw, best->sh, aw, ah);
            if (gp_display()->window) {          /* as gp_d3d11_present_frame */
                static float px = -1, py = -1;
                static int same;
                float sx, sy;
                gp_display_scale_for(s_surf_w, s_surf_h, &sx, &sy);
                if (sx != px || sy != py) { px = sx; py = sy; same = 0; }
                else if (++same == 20 && (sx != s_sx || sy != s_sy)) { s_want_sx = sx; s_want_sy = sy; }
            }
        } else {
            WGPUCommandBuffer cb = wgpuCommandEncoderFinish(s_enc, NULL);
            wgpuQueueSubmit(s_queue, 1, &cb);
            wgpuCommandBufferRelease(cb);
            wgpuCommandEncoderRelease(s_enc);
            s_enc = NULL;
            s_blit_slot = 0;
        }
        if (gp_display_dump_due()) dump_tex(best->tex, best->sw, best->sh);
        shown = 1;
    }
    ReleaseSRWLockExclusive(&s_lock);
    return shown;
}

int gp_wgpu_present_pixels(void *hwnd, const uint32_t *px, uint32_t w, uint32_t h,
                           uint32_t aw, uint32_t ah)
{
    int ok = 0;
    if (!s_active || !px || !s_dev || s_failed) return 0;
    /* Never wait for the lock here: the flip thread can hold it while DXGI
     * (swap chain creation, resize) sends this thread's window a message,
     * and waiting would deadlock the two. A skipped tick is redrawn 16 ms on. */
    if (!TryAcquireSRWLockExclusive(&s_lock)) return 0;
    if (surf_ready((HWND)hwnd)) {
        if (!s_px_tex || s_px_w != w || s_px_h != h) {
            if (s_px_view) wgpuTextureViewRelease(s_px_view);
            if (s_px_tex) wgpuTextureRelease(s_px_tex);
            s_px_tex = make_tex(w, h, 1, WGPUTextureFormat_BGRA8Unorm,
                                WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
            s_px_view = wgpuTextureCreateView(s_px_tex, NULL);
            s_px_w = w; s_px_h = h;
        }
        write_tex(s_px_tex, 0, px, (size_t)w * h * 4, w * 4, h, w, h);
        s_enc = wgpuDeviceCreateCommandEncoder(s_dev, NULL);
        s_pass = NULL;
        surf_show(s_px_view, w, h, aw, ah);
        ok = 1;
    }
    ReleaseSRWLockExclusive(&s_lock);
    return ok;
}

/* ---- a frame ------------------------------------------------------------- */

void gp_wgpu_consume(const GpFrame *f)
{
    uint32_t i;
    int j, k;
    WGPUCommandBuffer cb;
    if (!ensure_device()) { gp_d3d11_consume(f); return; }
    AcquireSRWLockExclusive(&s_lock);
    /* The encoder first: scaled render-target uploads and a rescale blit
     * go into it (with the display options off it stays empty until the
     * draws). */
    s_enc = wgpuDeviceCreateCommandEncoder(s_dev, NULL);
    s_pass = NULL;
    if (s_active && (s_want_sx != s_sx || s_want_sy != s_sy))
        rescale(s_want_sx, s_want_sy);
    drain_queue(f);
    if (s_bg_flush) bg_flush();
    gbuf(&s_vb, f->vtx_bytes + 16, WGPUBufferUsage_Vertex);
    if (f->vtx_bytes) wgpuQueueWriteBuffer(s_queue, s_vb.b, 0, f->vtx, (f->vtx_bytes + 3) & ~3u);
    gbuf(&s_ib, (uint64_t)f->idx_count * 4 + 16, WGPUBufferUsage_Index);
    if (f->idx_count) wgpuQueueWriteBuffer(s_queue, s_ib.b, 0, f->idx, (size_t)f->idx_count * 4);
    pack_uniforms(f);

    s_cur_target = s_cur_zeta = ~0u;
    for (i = 0; i < f->draw_count; i++) {
        const GpDraw *d = &f->draws[i];
        if (d->kind == GP_CLEAR) do_clear(d);
        else if (d->kind == GP_DRAW) do_draw(d, &s_slots[i]);
        else s_st.skipped++;
    }
    end_pass();
    /* Linear targets drawn this frame go back to guest memory. */
    for (j = k = 0; j < s_nrt_ids; j++) {
        Res *r = res(s_rt_ids[j]);
        if (!r || r->kind != R_RT) continue;
        s_rt_ids[k++] = s_rt_ids[j];
        if (r->dirty && !r->swz && r->pitch) writeback_copy(r);
        else r->dirty = 0;     /* swizzled: never written back (as D3D11) */
    }
    s_nrt_ids = k;
    cb = wgpuCommandEncoderFinish(s_enc, NULL);
    wgpuQueueSubmit(s_queue, 1, &cb);
    wgpuCommandBufferRelease(cb);
    wgpuCommandEncoderRelease(s_enc);
    s_enc = NULL;
    s_blit_slot = 0;
    writeback_all();
    ReleaseSRWLockExclusive(&s_lock);

    if (f->frame % 300 == 299) {
        fprintf(stderr, "  [WGPU] frames %u: %llu draws, %llu tris, %llu clears, %llu passes, %llu skipped"
                " (vs %llu ps %llu rt %llu), %llu on scratch Z, %llu tile copies; %u textures, %u shaders, %u pipelines,"
                " %u bind groups, %u errors\n", f->frame + 1,
                (unsigned long long)s_st.draws, (unsigned long long)s_st.tris,
                (unsigned long long)s_st.clears, (unsigned long long)s_st.passes,
                (unsigned long long)s_st.skipped, (unsigned long long)s_st.no_vs,
                (unsigned long long)s_st.no_ps, (unsigned long long)s_st.no_rt,
                (unsigned long long)s_st.z_scratch, (unsigned long long)s_st.sub_copies, s_stat_tex, s_stat_shaders, s_npipes, s_nbgs, s_errors);
        memset(&s_st, 0, sizeof s_st);
        s_stat_tex = s_stat_shaders = 0;
    }
}
