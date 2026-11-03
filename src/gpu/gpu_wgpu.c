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

typedef enum { R_NONE, R_RT, R_DS, R_TEX, R_VS, R_PS } RKind;
typedef struct {
    RKind kind;
    WGPUTexture tex;
    WGPUTextureView view;
    WGPUShaderModule mod;
    WGPUBuffer rb;                  /* writeback staging */
    uint32_t va, w, h, bpp, fmt, swz, pitch, dirty, cube;   /* cube: faces==6 (tex) or PS mask */
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
    if (r->mod) wgpuShaderModuleRelease(r->mod);
    if (r->rb) { wgpuBufferDestroy(r->rb); wgpuBufferRelease(r->rb); }
    memset(r, 0, sizeof *r);
}

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
    r->tex = make_tex(c->b, c->c, 1, s_ds_fmt, WGPUTextureUsage_RenderAttachment);
    r->view = wgpuTextureCreateView(r->tex, NULL);
    r->kind = R_DS; r->w = c->b; r->h = c->c;
}

static uint32_t s_stat_tex, s_stat_shaders, s_stat_nobc;

static void q_tex_create(const GpCmd *c, const uint8_t *payload)
{
    Res *r = res(c->id);
    uint32_t faces = c->e ? c->e : 1, f, bpr = c->b * 4, rows = c->c, face_bytes;
    WGPUTextureFormat fmt = WGPUTextureFormat_BGRA8Unorm;
    WGPUTextureViewDescriptor vd = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    if (!r) return;
    res_release(r);
    if (c->d != GP_FMT_BGRA8) {
        if (!s_bc) { s_stat_nobc++; return; }   /* ponytail: CPU BC decode without the feature */
        fmt = c->d == GP_FMT_BC1 ? WGPUTextureFormat_BC1RGBAUnorm
            : c->d == GP_FMT_BC2 ? WGPUTextureFormat_BC2RGBAUnorm : WGPUTextureFormat_BC3RGBAUnorm;
        bpr = (c->b / 4) * (c->d == GP_FMT_BC1 ? 8 : 16);
        rows = c->c / 4;
    }
    r->tex = make_tex(c->b, c->c, faces, fmt, WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
    face_bytes = c->bytes / faces;
    for (f = 0; f < faces; f++)
        write_tex(r->tex, f, payload + (size_t)f * face_bytes, face_bytes, bpr, rows, c->b, c->c);
    vd.dimension = faces == 6 ? WGPUTextureViewDimension_Cube : WGPUTextureViewDimension_2D;
    vd.arrayLayerCount = faces;
    r->view = wgpuTextureCreateView(r->tex, &vd);
    r->kind = R_TEX; r->w = c->b; r->h = c->c; r->cube = faces == 6;
    s_stat_tex++;
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
        }
    }
    if (gbuf(&s_ub, size, WGPUBufferUsage_Uniform) && s_group0) {
        wgpuBindGroupRelease(s_group0); s_group0 = NULL;
    }
    wgpuQueueWriteBuffer(s_queue, s_ub.b, 0, s_arena, (size + 3) & ~(size_t)3);
    if (!s_group0) {
        static const uint64_t sz[4] = { 112, 3072, 320, 80 };
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

static WGPUSampler sampler(uint32_t key)
{
    WGPUSamplerDescriptor sd = WGPU_SAMPLER_DESCRIPTOR_INIT;
    int i;
    key &= 0xFFF;
    for (i = 0; i < s_nsmp; i++)
        if (s_smp[i].key == key) return s_smp[i].s;
    if (s_nsmp == SMP_CACHE) return s_default_smp;
    sd.magFilter = sd.minFilter = (key & GP_SMP_LINEAR) ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
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

static WGPUCommandEncoder s_enc;
static WGPURenderPassEncoder s_pass;
static uint32_t s_cur_target, s_cur_zeta;
static struct { uint64_t draws, tris, skipped, clears, passes, no_vs, no_ps, no_rt, z_scratch; } s_st;

static void end_pass(void)
{
    if (s_pass) { wgpuRenderPassEncoderEnd(s_pass); wgpuRenderPassEncoderRelease(s_pass); s_pass = NULL; }
}

static void begin_pass(Res *rt, Res *ds, const float *clear_rgba, const float *clear_z, const uint32_t *clear_s)
{
    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    WGPURenderPassDepthStencilAttachment da = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
    WGPURenderPassDescriptor pd = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    ca.view = rt->view;
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
    if (ds->w == rt->w && ds->h == rt->h) return ds;
    s_st.z_scratch++;
    for (i = 0; i < s_nscratch; i++)
        if (s_scratch[i].zeta == d->zeta && s_scratch[i].w == rt->w && s_scratch[i].h == rt->h) break;
    if (i == s_nscratch) {
        if (s_nscratch == MAX_SCRATCH) { *key = 0; return NULL; }
        s_scratch[i].zeta = d->zeta; s_scratch[i].w = rt->w; s_scratch[i].h = rt->h;
        memset(&s_scratch[i].r, 0, sizeof s_scratch[i].r);
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
    if (!(rt = bind_target(d, &ds))) { s_st.no_rt++; s_st.skipped++; return; }

    for (st = 0; st < 4; st++) {
        uint32_t id = d->tex[st], want_cube = (cube >> st) & 1;
        WGPUTextureView v = NULL;
        if (id) {
            if (id & GP_TEX_RT) { id &= ~GP_TEX_RT; if (id == d->target) id = 0; }   /* own target: 0 */
            if (id) {
                Res *r = res(id);
                if (r && (r->kind == R_TEX || r->kind == R_RT) && r->view && (r->cube != 0) == (want_cube != 0))
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
    if (!r->rb) {
        WGPUBufferDescriptor bd = WGPU_BUFFER_DESCRIPTOR_INIT;
        bd.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead; bd.size = (uint64_t)bpr * r->h;
        r->rb = wgpuDeviceCreateBuffer(s_dev, &bd);
    }
    wgpuCommandEncoderCopyTextureToBuffer(s_enc,
        &(WGPUTexelCopyTextureInfo){ .texture = r->tex, .aspect = WGPUTextureAspect_All },
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

/* ---- a frame ------------------------------------------------------------- */

void gp_wgpu_consume(const GpFrame *f)
{
    uint32_t i;
    int j, k;
    WGPUCommandBuffer cb;
    if (!ensure_device()) { gp_d3d11_consume(f); return; }
    drain_queue(f);
    if (s_bg_flush) bg_flush();
    gbuf(&s_vb, f->vtx_bytes + 16, WGPUBufferUsage_Vertex);
    if (f->vtx_bytes) wgpuQueueWriteBuffer(s_queue, s_vb.b, 0, f->vtx, (f->vtx_bytes + 3) & ~3u);
    gbuf(&s_ib, (uint64_t)f->idx_count * 4 + 16, WGPUBufferUsage_Index);
    if (f->idx_count) wgpuQueueWriteBuffer(s_queue, s_ib.b, 0, f->idx, (size_t)f->idx_count * 4);
    pack_uniforms(f);

    s_enc = wgpuDeviceCreateCommandEncoder(s_dev, NULL);
    s_pass = NULL;
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
    writeback_all();

    if (f->frame % 300 == 299) {
        fprintf(stderr, "  [WGPU] frames %u: %llu draws, %llu tris, %llu clears, %llu passes, %llu skipped"
                " (vs %llu ps %llu rt %llu), %llu on scratch Z; %u textures, %u shaders, %u pipelines,"
                " %u bind groups, %u errors\n", f->frame + 1,
                (unsigned long long)s_st.draws, (unsigned long long)s_st.tris,
                (unsigned long long)s_st.clears, (unsigned long long)s_st.passes,
                (unsigned long long)s_st.skipped, (unsigned long long)s_st.no_vs,
                (unsigned long long)s_st.no_ps, (unsigned long long)s_st.no_rt,
                (unsigned long long)s_st.z_scratch, s_stat_tex, s_stat_shaders, s_npipes, s_nbgs, s_errors);
        memset(&s_st, 0, sizeof s_st);
        s_stat_tex = s_stat_shaders = 0;
    }
}
