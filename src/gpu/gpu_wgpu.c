/*
 * The native WebGPU drawing side (RECOMP_GPU_BACKEND=wgpu): consumes frame
 * packets (gpu_proto.h) exactly like gpu_d3d11.c, through the standard
 * webgpu.h API (webgpu-headers 1.0 as implemented by wgpu-native v25+; Dawn
 * has the same entry points). It is the C twin of web/gpu/encoder.js, which
 * is the version that is exercised today (headless Edge, web/tools/
 * replay.mjs); keep the two in step.
 *
 * Status: SKELETON, NOT YET COMPILED. Built only with -DATV2_WGPU=ON
 * -DWGPU_NATIVE_DIR=<wgpu-native release>, which is not on this machine (see
 * WEBGPU.md for the download). Expect small API-name fixes on first compile.
 *
 * Shape (same as gpu_d3d11.c):
 *   drain the resource queue in order -- render targets, depth, textures by
 *   id; shaders by id, but the WGSL comes from the tap (gp_wgsl_source), the
 *   queue's payload being HLSL;
 *   draw the records in order -- a target/depth change or a clear starts a
 *   render pass; constants repacked into a 256-aligned uniform arena bound
 *   with dynamic offsets; pipelines cached by (vs, ps, blend, depth, stencil,
 *   write mask, cube mask) key;
 *   write the linear render targets drawn this frame back into guest memory
 *   (copyTextureToBuffer + map), so the framebuffer window and dumps work.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <webgpu/webgpu.h>
#include <webgpu/wgpu.h>            /* wgpu-native: wgpuDevicePoll */

#include "gpu_proto.h"
#include "gpu_shadergen_wgsl.h"

extern ptrdiff_t xbox_GetMemoryOffset(void);

#define SV(s) ((WGPUStringView){ (s), WGPU_STRLEN })

static WGPUInstance s_inst;
static WGPUAdapter s_adapter;
static WGPUDevice s_dev;
static WGPUQueue s_queue;
static int s_failed, s_bc, s_d32s8;

/* ---- id table (as gpu_d3d11.c) ------------------------------------------- */

typedef enum { R_NONE, R_RT, R_DS, R_TEX, R_VS, R_PS } RKind;
typedef struct {
    RKind kind;
    WGPUTexture tex;
    WGPUTextureView view;
    WGPUShaderModule mod;
    uint32_t va, w, h, bpp, fmt, swz, pitch, dirty, cube;   /* cube: faces==6 (tex) or PS mask */
} Res;
static Res *s_res;
static uint32_t s_nres;

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

static void res_release(Res *r)
{
    if (r->view) wgpuTextureViewRelease(r->view);
    if (r->tex) { wgpuTextureDestroy(r->tex); wgpuTextureRelease(r->tex); }
    if (r->mod) wgpuShaderModuleRelease(r->mod);
    memset(r, 0, sizeof *r);
}

/* Built-in shaders live outside the id table (VS 1/2 and PS 1 share ids). */
static WGPUShaderModule s_vs_pass, s_vs_tv, s_ps_tv;

/* ---- device -------------------------------------------------------------- */

static void on_adapter(WGPURequestAdapterStatus st, WGPUAdapter a, WGPUStringView msg, void *u1, void *u2)
{
    (void)msg; (void)u2;
    if (st == WGPURequestAdapterStatus_Success) *(WGPUAdapter *)u1 = a;
    else fprintf(stderr, "  [WGPU] no adapter: %.*s\n", (int)msg.length, msg.data);
}

static void on_device(WGPURequestDeviceStatus st, WGPUDevice d, WGPUStringView msg, void *u1, void *u2)
{
    (void)u2;
    if (st == WGPURequestDeviceStatus_Success) *(WGPUDevice *)u1 = d;
    else fprintf(stderr, "  [WGPU] no device: %.*s\n", (int)msg.length, msg.data);
}

static void on_error(WGPUDevice const *d, WGPUErrorType t, WGPUStringView msg, void *u1, void *u2)
{
    static int shown;
    (void)d; (void)u1; (void)u2;
    if (shown++ < 20) fprintf(stderr, "  [WGPU] error %d: %.*s\n", (int)t, (int)msg.length, msg.data);
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

static void make_layouts(void)
{
    static const uint32_t size[4] = { 112, 3072, 320, 80 };
    WGPUBindGroupLayoutEntry e[8];
    int i, cube;
    memset(e, 0, sizeof e);
    for (i = 0; i < 4; i++) {
        e[i].binding = (uint32_t)i;
        e[i].visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        e[i].buffer.type = WGPUBufferBindingType_Uniform;
        e[i].buffer.hasDynamicOffset = 1;
        e[i].buffer.minBindingSize = 0;
        (void)size;
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
        WGPUTextureDescriptor td = { .usage = WGPUTextureUsage_TextureBinding, .dimension = WGPUTextureDimension_2D,
                                     .size = { 1, 1, 1 }, .format = WGPUTextureFormat_BGRA8Unorm,
                                     .mipLevelCount = 1, .sampleCount = 1 };
        WGPUTexture t = wgpuDeviceCreateTexture(s_dev, &td);
        s_dummy2d = wgpuTextureCreateView(t, NULL);
        td.size.depthOrArrayLayers = 6;
        t = wgpuDeviceCreateTexture(s_dev, &td);
        s_dummy_cube = wgpuTextureCreateView(t, &(WGPUTextureViewDescriptor){
            .dimension = WGPUTextureViewDimension_Cube, .format = WGPUTextureFormat_BGRA8Unorm,
            .mipLevelCount = 1, .arrayLayerCount = 6, .aspect = WGPUTextureAspect_All });
    }
}

static void wait_events(volatile void *const *done)
{
    while (!*done) {
        wgpuInstanceProcessEvents(s_inst);
        wgpuDevicePoll(s_dev, 1, NULL);          /* wgpu-native; Dawn: drop */
    }
}

static int ensure_device(void)
{
    WGPUFeatureName feat[3];
    size_t nf = 0;
    uint32_t n;
    const char *src;
    if (s_failed) return 0;
    if (s_dev) return 1;
    s_failed = 1;
    if (!(s_inst = wgpuCreateInstance(NULL))) return 0;
    wgpuInstanceRequestAdapter(s_inst, &(WGPURequestAdapterOptions){ .powerPreference = WGPUPowerPreference_HighPerformance },
        (WGPURequestAdapterCallbackInfo){ .mode = WGPUCallbackMode_AllowProcessEvents, .callback = on_adapter, .userdata1 = &s_adapter });
    while (!s_adapter) wgpuInstanceProcessEvents(s_inst);   /* ponytail: bounded wait + failure path */
    s_bc = wgpuAdapterHasFeature(s_adapter, WGPUFeatureName_TextureCompressionBC);
    s_d32s8 = wgpuAdapterHasFeature(s_adapter, WGPUFeatureName_Depth32FloatStencil8);
    if (s_bc) feat[nf++] = WGPUFeatureName_TextureCompressionBC;
    if (s_d32s8) feat[nf++] = WGPUFeatureName_Depth32FloatStencil8;
    wgpuAdapterRequestDevice(s_adapter, &(WGPUDeviceDescriptor){
            .requiredFeatureCount = nf, .requiredFeatures = feat,
            .uncapturedErrorCallbackInfo = { .callback = on_error } },
        (WGPURequestDeviceCallbackInfo){ .mode = WGPUCallbackMode_AllowProcessEvents, .callback = on_device, .userdata1 = &s_dev });
    while (!s_dev) wgpuInstanceProcessEvents(s_inst);
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
    WGPUTextureDescriptor td = { .usage = u, .dimension = WGPUTextureDimension_2D, .size = { w, h, layers },
                                 .format = f, .mipLevelCount = 1, .sampleCount = 1 };
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
}

static void q_ds_create(const GpCmd *c)
{
    Res *r = res(c->id);
    if (!r) return;
    res_release(r);
    r->tex = make_tex(c->b, c->c, 1, s_d32s8 ? WGPUTextureFormat_Depth32FloatStencil8
                                             : WGPUTextureFormat_Depth24PlusStencil8,
                      WGPUTextureUsage_RenderAttachment);
    r->view = wgpuTextureCreateView(r->tex, NULL);
    r->kind = R_DS; r->w = c->b; r->h = c->c;
}

static void q_tex_create(const GpCmd *c, const uint8_t *payload)
{
    Res *r = res(c->id);
    uint32_t faces = c->e ? c->e : 1, f, bpr = c->b * 4, rows = c->c, face_bytes;
    WGPUTextureFormat fmt = WGPUTextureFormat_BGRA8Unorm;
    if (!r) return;
    res_release(r);
    if (c->d != GP_FMT_BGRA8) {
        if (!s_bc) return;                /* ponytail: CPU BC decode without the feature */
        fmt = c->d == GP_FMT_BC1 ? WGPUTextureFormat_BC1RGBAUnorm
            : c->d == GP_FMT_BC2 ? WGPUTextureFormat_BC2RGBAUnorm : WGPUTextureFormat_BC3RGBAUnorm;
        bpr = (c->b / 4) * (c->d == GP_FMT_BC1 ? 8 : 16);
        rows = c->c / 4;
    }
    r->tex = make_tex(c->b, c->c, faces, fmt, WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
    face_bytes = c->bytes / faces;
    for (f = 0; f < faces; f++)
        write_tex(r->tex, f, payload + (size_t)f * face_bytes, face_bytes, bpr, rows, c->b, c->c);
    r->view = wgpuTextureCreateView(r->tex, &(WGPUTextureViewDescriptor){
        .dimension = faces == 6 ? WGPUTextureViewDimension_Cube : WGPUTextureViewDimension_2D,
        .format = fmt, .mipLevelCount = 1, .arrayLayerCount = faces, .aspect = WGPUTextureAspect_All });
    r->kind = R_TEX; r->w = c->b; r->h = c->c; r->cube = faces == 6;
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
    if (!r) return;
    res_release(r);
    if (!src) return;
    r->mod = wgsl_module(src, n, is_ps ? "ps" : "vs");
    r->kind = is_ps ? R_PS : R_VS;
    r->cube = is_ps ? cube_mask_of(src) : 0;
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

/* ---- drawing ------------------------------------------------------------- */
/*
 * ponytail: the pieces below are a direct port of encoder.js and are left as
 * outlines with the exact calls, to be filled in on the first compile:
 *
 *   pack_uniforms(f): walk the draws, give each GP_DRAW 256-aligned slots in
 *     one arena (xf 256, vsc 3072 deduped by vsc_off, ps 512, GpWgslSmp 256;
 *     offset 0 = 3072 zero bytes for "no block"), wgpuQueueWriteBuffer once,
 *     one bind group over it with sizes {112, 3072, 320, 80}.
 *   vertex and index arenas: one wgpuQueueWriteBuffer each per frame;
 *     wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vb, d->vtx_off,
 *     d->vtx_count * d->vtx_stride); SetIndexBuffer(.., Uint32, idx_off * 4,
 *     idx_count * 4); DrawIndexed(idx_count, 1, 0, 0, 0) or Draw(vtx_count).
 *   bind_target(d): same target and depth keep the pass; otherwise end it and
 *     begin one with LoadOp_Load. A depth whose size differs from the target
 *     is dropped (WebGPU needs equal sizes; D3D11 accepts a larger DSV).
 *   do_clear(d): end the pass, begin one on (target, depth) with LoadOp_Clear
 *     for the cleared aspects (colour if clr_flags & 0xF0, depth if & 1,
 *     stencil if & 2), values as gpu_d3d11.c do_clear.
 *   pipelines: key and descriptor exactly as encoder.js pipeline(): blend
 *     factors/ops from the GL enums (min/max force factor One), write mask
 *     from color_mask, depth/stencil from GpState, CullMode_None,
 *     TriangleList, vertex layouts as layout.js vertexLayout().
 *   textures: GP_TEX_RT | id, own target -> dummy; cube-ness must match the
 *     PS's cube mask, else the dummy of the right dimension; samplers cached
 *     by GpDraw.smp (Repeat / MirrorRepeat / ClampToEdge, Linear / Nearest,
 *     lodMaxClamp 0).
 *   per draw: SetBlendConstant (alpha replicated for CONSTANT_ALPHA factors),
 *     SetStencilReference(stencil_ref & 0xFF).
 */
static WGPUCommandEncoder s_enc;
static WGPURenderPassEncoder s_pass;
static uint32_t s_cur_target, s_cur_zeta;

static void end_pass(void)
{
    if (s_pass) { wgpuRenderPassEncoderEnd(s_pass); wgpuRenderPassEncoderRelease(s_pass); s_pass = NULL; }
}

static void begin_pass(Res *rt, Res *ds, const float *clear_rgba, const float *clear_z, const uint32_t *clear_s)
{
    WGPURenderPassColorAttachment ca = {
        .view = rt->view, .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,
        .loadOp = clear_rgba ? WGPULoadOp_Clear : WGPULoadOp_Load, .storeOp = WGPUStoreOp_Store,
        .clearValue = clear_rgba ? (WGPUColor){ clear_rgba[0], clear_rgba[1], clear_rgba[2], clear_rgba[3] }
                                 : (WGPUColor){ 0, 0, 0, 0 } };
    WGPURenderPassDepthStencilAttachment da = {
        .view = ds ? ds->view : NULL,
        .depthLoadOp = clear_z ? WGPULoadOp_Clear : WGPULoadOp_Load, .depthStoreOp = WGPUStoreOp_Store,
        .depthClearValue = clear_z ? *clear_z : 1.0f,
        .stencilLoadOp = clear_s ? WGPULoadOp_Clear : WGPULoadOp_Load, .stencilStoreOp = WGPUStoreOp_Store,
        .stencilClearValue = clear_s ? *clear_s : 0 };
    WGPURenderPassDescriptor pd = { .colorAttachmentCount = 1, .colorAttachments = &ca,
                                    .depthStencilAttachment = ds ? &da : NULL };
    end_pass();
    s_pass = wgpuCommandEncoderBeginRenderPass(s_enc, &pd);
    wgpuRenderPassEncoderSetViewport(s_pass, 0, 0, (float)rt->w, (float)rt->h, 0, 1);
}

static void do_clear(const GpDraw *d)
{
    Res *rt = res(d->target), *ds = d->zeta ? res(d->zeta) : NULL;
    float c[4], z;
    uint32_t s;
    if (!rt || rt->kind != R_RT) return;
    if (ds && (ds->kind != R_DS || ds->w != rt->w || ds->h != rt->h)) ds = NULL;
    c[0] = ((d->clr_argb >> 16) & 0xFF) / 255.0f; c[1] = ((d->clr_argb >> 8) & 0xFF) / 255.0f;
    c[2] = (d->clr_argb & 0xFF) / 255.0f;         c[3] = (d->clr_argb >> 24) / 255.0f;
    z = d->zeta_format == 1 ? (float)(d->clr_zs & 0xFFFF) / 65535.0f : (float)(d->clr_zs >> 8) / 16777215.0f;
    s = d->clr_zs & 0xFF;
    begin_pass(rt, ds, (d->clr_flags & 0xF0) ? c : NULL,
               (ds && (d->clr_flags & 1)) ? &z : NULL, (ds && (d->clr_flags & 2)) ? &s : NULL);
    s_cur_target = d->target; s_cur_zeta = ds ? d->zeta : 0;
    rt->dirty = 1;
}

static void do_draw(const GpFrame *f, const GpDraw *d)
{
    (void)f; (void)d;
    /* ponytail: see the outline above / encoder.js doDraw(). */
}

/* ---- writeback ----------------------------------------------------------- */

typedef struct { volatile int done; } MapWait;
static void on_map(WGPUMapAsyncStatus st, WGPUStringView msg, void *u1, void *u2)
{
    (void)st; (void)msg; (void)u2;
    ((MapWait *)u1)->done = 1;
}

static void writeback(Res *r)
{
    uint8_t *mem = (uint8_t *)xbox_GetMemoryOffset();
    uint32_t bpr = (r->w * 4 + 255) & ~255u, y, x;
    WGPUBuffer buf = wgpuDeviceCreateBuffer(s_dev, &(WGPUBufferDescriptor){
        .usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead, .size = (uint64_t)bpr * r->h });
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(s_dev, NULL);
    WGPUCommandBuffer cb;
    MapWait w = { 0 };
    const uint8_t *src;
    wgpuCommandEncoderCopyTextureToBuffer(enc,
        &(WGPUTexelCopyTextureInfo){ .texture = r->tex, .aspect = WGPUTextureAspect_All },
        &(WGPUTexelCopyBufferInfo){ .buffer = buf, .layout = { .bytesPerRow = bpr, .rowsPerImage = r->h } },
        &(WGPUExtent3D){ r->w, r->h, 1 });
    cb = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(s_queue, 1, &cb);
    wgpuBufferMapAsync(buf, WGPUMapMode_Read, 0, (size_t)bpr * r->h,
        (WGPUBufferMapCallbackInfo){ .mode = WGPUCallbackMode_AllowProcessEvents, .callback = on_map, .userdata1 = &w });
    wait_events((volatile void *const *)&w.done);
    src = (const uint8_t *)wgpuBufferGetConstMappedRange(buf, 0, (size_t)bpr * r->h);
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
    wgpuBufferUnmap(buf);
    wgpuBufferRelease(buf);
    wgpuCommandBufferRelease(cb);
    wgpuCommandEncoderRelease(enc);
}

void gp_wgpu_consume(const GpFrame *f)
{
    uint32_t i;
    WGPUCommandBuffer cb;
    if (!ensure_device()) { gp_d3d11_consume(f); return; }
    drain_queue(f);
    s_enc = wgpuDeviceCreateCommandEncoder(s_dev, NULL);
    s_cur_target = s_cur_zeta = ~0u;
    for (i = 0; i < f->draw_count; i++) {
        const GpDraw *d = &f->draws[i];
        if (d->kind == GP_CLEAR) do_clear(d);
        else if (d->kind == GP_DRAW) do_draw(f, d);
    }
    end_pass();
    cb = wgpuCommandEncoderFinish(s_enc, NULL);
    wgpuQueueSubmit(s_queue, 1, &cb);
    wgpuCommandBufferRelease(cb);
    wgpuCommandEncoderRelease(s_enc);
    s_enc = NULL;
    for (i = 0; i < s_nres; i++) {
        Res *r = &s_res[i];
        if (r->kind == R_RT && r->dirty) {
            if (!r->swz && r->pitch) writeback(r);
            r->dirty = 0;
        }
    }
}
