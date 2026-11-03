/*
 * The D3D11 drawing side: consumes frame packets (gpu_proto.h) from the
 * recorder (gpu_rec.c) at every flip.
 *
 * Drain the resource queue in order, draw the records in order, then copy the
 * linear render targets drawn this frame back into guest memory, so the
 * framebuffer window, BMP dumps and anything else reading the framebuffer
 * keep working unchanged.
 *
 * Resources live in id-indexed tables. Ids are never reused by the recorder,
 * so the tables grow; a freed id's slot is just emptied.
 */
#define COBJMACROS
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_6.h>
#include <d3dcompiler.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gpu_proto.h"
#include "d3d8_swizzle.h"

extern ptrdiff_t xbox_GetMemoryOffset(void);

static ID3D11Device        *s_dev;
static ID3D11DeviceContext *s_ctx;
static int s_failed;

/* ---- id tables ----------------------------------------------------------- */

typedef enum { R_NONE, R_RT, R_DS, R_TEX, R_VS, R_PS, R_SUB } RKind;
typedef struct {
    RKind kind;
    ID3D11Resource *res;
    ID3D11ShaderResourceView *srv;
    ID3D11RenderTargetView *rtv;
    ID3D11DepthStencilView *dsv;
    ID3D11VertexShader *vs;
    ID3D11InputLayout *layout;
    ID3D11PixelShader *ps;
    ID3D11Texture2D *staging;
    ID3DBlob *code;                 /* vertex shaders, while checking: for stream output */
    ID3D11GeometryShader *so_gs;
    uint32_t va, w, h, bpp, fmt, swz, pitch, dirty;
} Res;
static Res *s_res;
static uint32_t s_nres;
/* Live render targets, for the writeback at the flip. Deduplicated and
 * compacted: it was a fixed 256-entry append-only list, and once a long
 * session had (re)created that many targets, a framebuffer recreated after
 * that was never written back -- one of the two buffers froze and the window
 * alternated between the live frame and a minutes-old one. */
static uint32_t *s_rt_ids;
static int s_nrt_ids, s_cap_rt_ids;

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
#define REL(x, T) if (r->x) T##_Release(r->x)
    REL(srv, ID3D11ShaderResourceView); REL(rtv, ID3D11RenderTargetView);
    REL(dsv, ID3D11DepthStencilView); REL(vs, ID3D11VertexShader);
    REL(layout, ID3D11InputLayout); REL(ps, ID3D11PixelShader);
    REL(staging, ID3D11Texture2D); REL(res, ID3D11Resource);
    REL(so_gs, ID3D11GeometryShader);
    if (r->code) ID3D10Blob_Release(r->code);
#undef REL
    memset(r, 0, sizeof *r);
}

/* ---- device -------------------------------------------------------------- */

static ID3D11Buffer *s_vb, *s_ib, *s_cb_vs, *s_cb_xf, *s_cb_ps;
static UINT s_vb_bytes, s_ib_bytes;
static ID3D11RasterizerState *s_rs;
static ID3D11VertexShader *s_vs_pass, *s_vs_tv;
static ID3D11InputLayout *s_lay_pass, *s_lay_tv;
static ID3D11PixelShader *s_ps_tv;

static const char s_tv_hlsl[] =
"cbuffer CB : register(b0) { float2 surf; float zscale; float textured;\n"
"  float2 texsize; float alpha_ref; float alpha_func; };\n"
"Texture2D t0 : register(t0); SamplerState s0 : register(s0);\n"
"struct VI { float4 p : POSITION; float4 c : COLOR; float2 uv : TEXCOORD0; };\n"
"struct VO { float4 p : SV_Position; float4 c : COLOR; float2 uv : TEXCOORD0; };\n"
"VO vs(VI i) {\n"
"  VO o; float w = i.p.w != 0 ? 1.0 / i.p.w : 1.0;\n"
"  float2 ndc = float2(i.p.x / surf.x * 2 - 1, 1 - i.p.y / surf.y * 2);\n"
"  o.p = float4(ndc * w, saturate(i.p.z * zscale) * w, w);\n"
"  o.c = i.c; o.uv = i.uv / texsize; return o; }\n"
"float4 ps(VO i) : SV_Target {\n"
"  float4 c = i.c;\n"
"  if (textured > 0.5) c *= t0.Sample(s0, i.uv);\n"
"  if (alpha_func > 0.5) {\n"
"    float a = round(saturate(c.a) * 255.0); int f = (int)alpha_func - 1; bool ok = true;\n"
"    if (f == 0) ok = false; else if (f == 1) ok = a < alpha_ref;\n"
"    else if (f == 2) ok = a == alpha_ref; else if (f == 3) ok = a <= alpha_ref;\n"
"    else if (f == 4) ok = a > alpha_ref; else if (f == 5) ok = a != alpha_ref;\n"
"    else if (f == 6) ok = a >= alpha_ref;\n"
"    if (!ok) discard; }\n"
"  return c; }\n";

static int s_dump_shaders = -1;

static ID3DBlob *compile(const char *src, size_t len, const char *entry, const char *target,
                         uint32_t id)
{
    ID3DBlob *code = NULL, *err = NULL;
    HRESULT hr = D3DCompile(src, len, "gpu", NULL, NULL, entry, target,
                            D3DCOMPILE_OPTIMIZATION_LEVEL1, 0, &code, &err);
    if (FAILED(hr)) {
        static int shown;
        fprintf(stderr, "  [GPU11] shader %u (%s) failed: %s\n", id, target,
                err ? (const char *)ID3D10Blob_GetBufferPointer(err) : "?");
        if (shown++ < 3) fprintf(stderr, "----\n%.*s\n----\n", (int)len, src);
    }
    if (s_dump_shaders < 0) s_dump_shaders = getenv("RECOMP_GPU_DUMP_SHADERS") != NULL;
    if (s_dump_shaders) {
        char path[128];
        FILE *f;
        snprintf(path, sizeof path, "gpu_shader_%u_%s.hlsl", id, target);
        if ((f = fopen(path, "wb"))) { fwrite(src, 1, len, f); fclose(f); }
    }
    if (err) ID3D10Blob_Release(err);
    return SUCCEEDED(hr) ? code : NULL;
}

static IDXGIAdapter1 *pick_adapter(void)
{
    IDXGIFactory6 *f6 = NULL;
    IDXGIAdapter1 *a = NULL;
    if (SUCCEEDED(CreateDXGIFactory1(&IID_IDXGIFactory6, (void **)&f6))) {
        IDXGIFactory6_EnumAdapterByGpuPreference(f6, 0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                                                 &IID_IDXGIAdapter1, (void **)&a);
        IDXGIFactory6_Release(f6);
    }
    return a;
}

static int make_buffer(UINT bytes, UINT bind, ID3D11Buffer **out)
{
    D3D11_BUFFER_DESC bd;
    memset(&bd, 0, sizeof bd);
    bd.ByteWidth = bytes;
    bd.Usage = D3D11_USAGE_DYNAMIC;
    bd.BindFlags = bind;
    bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    return SUCCEEDED(ID3D11Device_CreateBuffer(s_dev, &bd, NULL, out));
}

static int ensure_device(void)
{
    static const D3D_FEATURE_LEVEL fl[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
    IDXGIAdapter1 *ad;
    ID3DBlob *b;
    D3D11_RASTERIZER_DESC rd;
    HRESULT hr;

    if (s_failed) return 0;
    if (s_dev) return 1;
    s_failed = 1;
    ad = pick_adapter();
    hr = D3D11CreateDevice((IDXGIAdapter *)ad, ad ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
                           NULL, 0, fl, 2, D3D11_SDK_VERSION, &s_dev, NULL, &s_ctx);
    if (ad) {
        DXGI_ADAPTER_DESC1 d;
        if (SUCCEEDED(IDXGIAdapter1_GetDesc1(ad, &d)))
            fprintf(stderr, "  [GPU11] adapter: %ls\n", d.Description);
        IDXGIAdapter1_Release(ad);
    }
    if (FAILED(hr)) {
        fprintf(stderr, "  [GPU11] D3D11CreateDevice failed 0x%08lX\n", (unsigned long)hr);
        return 0;
    }

    /* Built-in shaders: screen-space quads, and the pass-through for
     * vertices the CPU transformed. */
    {
        extern int gpu_gen_vs_passthrough(char *out, size_t cap);
        static char src[16384];
        int n = gpu_gen_vs_passthrough(src, sizeof src);
        D3D11_INPUT_ELEMENT_DESC ie[8];
        static const char *names[8] = { "POS", "D", "D", "FOGC", "T", "T", "T", "T" };
        static const UINT index[8] = { 0, 0, 1, 0, 0, 1, 2, 3 };
        int i;
        if (n < 0 || !(b = compile(src, (size_t)n, "main", "vs_5_0", GP_VS_PASSTHRU))) return 0;
        ID3D11Device_CreateVertexShader(s_dev, ID3D10Blob_GetBufferPointer(b),
                                        ID3D10Blob_GetBufferSize(b), NULL, &s_vs_pass);
        memset(ie, 0, sizeof ie);
        for (i = 0; i < 8; i++) {
            ie[i].SemanticName = names[i];
            ie[i].SemanticIndex = index[i];
            ie[i].Format = DXGI_FORMAT_R32G32B32A32_FLOAT;
            ie[i].AlignedByteOffset = i * 16;
        }
        ID3D11Device_CreateInputLayout(s_dev, ie, 8, ID3D10Blob_GetBufferPointer(b),
                                       ID3D10Blob_GetBufferSize(b), &s_lay_pass);
        ID3D10Blob_Release(b);
    }
    {
        D3D11_INPUT_ELEMENT_DESC ie[3];
        if (!(b = compile(s_tv_hlsl, sizeof s_tv_hlsl - 1, "vs", "vs_5_0", GP_VS_TVERT))) return 0;
        ID3D11Device_CreateVertexShader(s_dev, ID3D10Blob_GetBufferPointer(b),
                                        ID3D10Blob_GetBufferSize(b), NULL, &s_vs_tv);
        memset(ie, 0, sizeof ie);
        ie[0].SemanticName = "POSITION"; ie[0].Format = DXGI_FORMAT_R32G32B32A32_FLOAT;
        ie[1].SemanticName = "COLOR"; ie[1].Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        ie[1].AlignedByteOffset = 16;
        ie[2].SemanticName = "TEXCOORD"; ie[2].Format = DXGI_FORMAT_R32G32_FLOAT;
        ie[2].AlignedByteOffset = 20;
        ID3D11Device_CreateInputLayout(s_dev, ie, 3, ID3D10Blob_GetBufferPointer(b),
                                       ID3D10Blob_GetBufferSize(b), &s_lay_tv);
        ID3D10Blob_Release(b);
        if (!(b = compile(s_tv_hlsl, sizeof s_tv_hlsl - 1, "ps", "ps_5_0", GP_PS_TVERT))) return 0;
        ID3D11Device_CreatePixelShader(s_dev, ID3D10Blob_GetBufferPointer(b),
                                       ID3D10Blob_GetBufferSize(b), NULL, &s_ps_tv);
        ID3D10Blob_Release(b);
    }

    s_vb_bytes = 64u << 20;
    s_ib_bytes = 16u << 20;
    if (!make_buffer(s_vb_bytes, D3D11_BIND_VERTEX_BUFFER, &s_vb)
        || !make_buffer(s_ib_bytes, D3D11_BIND_INDEX_BUFFER, &s_ib)
        || !make_buffer(sizeof(GpVsConsts), D3D11_BIND_CONSTANT_BUFFER, &s_cb_vs)
        || !make_buffer(sizeof(GpXfConsts), D3D11_BIND_CONSTANT_BUFFER, &s_cb_xf)
        || !make_buffer(sizeof(GpPsConsts), D3D11_BIND_CONSTANT_BUFFER, &s_cb_ps))
        return 0;

    /* No culling and no depth clip, as the CPU rasteriser: the near plane is
     * a clip distance the vertex shader writes. */
    memset(&rd, 0, sizeof rd);
    rd.FillMode = D3D11_FILL_SOLID;
    rd.CullMode = D3D11_CULL_NONE;
    rd.DepthClipEnable = FALSE;
    ID3D11Device_CreateRasterizerState(s_dev, &rd, &s_rs);

    s_failed = 0;
    fprintf(stderr, "  [GPU11] packet consumer ready\n");
    return 1;
}

int gp_d3d11_ready(void) { return s_dev != NULL && !s_failed; }

/* ---- state translation (NV2A uses OpenGL enums) -------------------------- */

static D3D11_BLEND blend_factor(uint32_t f, int alpha)
{
    switch (f) {
    case 0x0000: return D3D11_BLEND_ZERO;
    case 0x0001: return D3D11_BLEND_ONE;
    case 0x0300: return alpha ? D3D11_BLEND_SRC_ALPHA : D3D11_BLEND_SRC_COLOR;
    case 0x0301: return alpha ? D3D11_BLEND_INV_SRC_ALPHA : D3D11_BLEND_INV_SRC_COLOR;
    case 0x0302: return D3D11_BLEND_SRC_ALPHA;
    case 0x0303: return D3D11_BLEND_INV_SRC_ALPHA;
    case 0x0304: return D3D11_BLEND_DEST_ALPHA;
    case 0x0305: return D3D11_BLEND_INV_DEST_ALPHA;
    case 0x0306: return alpha ? D3D11_BLEND_DEST_ALPHA : D3D11_BLEND_DEST_COLOR;
    case 0x0307: return alpha ? D3D11_BLEND_INV_DEST_ALPHA : D3D11_BLEND_INV_DEST_COLOR;
    case 0x0308: return D3D11_BLEND_SRC_ALPHA_SAT;
    case 0x8001: case 0x8003: return D3D11_BLEND_BLEND_FACTOR;
    case 0x8002: case 0x8004: return D3D11_BLEND_INV_BLEND_FACTOR;
    default:     return D3D11_BLEND_ONE;
    }
}

static D3D11_BLEND_OP blend_op(uint32_t e)
{
    switch (e) {
    case 0x800A: return D3D11_BLEND_OP_SUBTRACT;
    case 0x800B: return D3D11_BLEND_OP_REV_SUBTRACT;
    case 0x8007: return D3D11_BLEND_OP_MIN;
    case 0x8008: return D3D11_BLEND_OP_MAX;
    default:     return D3D11_BLEND_OP_ADD;
    }
}

static D3D11_COMPARISON_FUNC cmp_func(uint32_t f)
{
    switch (f) {
    case 0x200: return D3D11_COMPARISON_NEVER;
    case 0x201: return D3D11_COMPARISON_LESS;
    case 0x202: return D3D11_COMPARISON_EQUAL;
    case 0x203: return D3D11_COMPARISON_LESS_EQUAL;
    case 0x204: return D3D11_COMPARISON_GREATER;
    case 0x205: return D3D11_COMPARISON_NOT_EQUAL;
    case 0x206: return D3D11_COMPARISON_GREATER_EQUAL;
    default:    return D3D11_COMPARISON_ALWAYS;
    }
}

static D3D11_STENCIL_OP stencil_op(uint32_t o)
{
    switch (o) {
    case 0x0000: return D3D11_STENCIL_OP_ZERO;
    case 0x1E01: return D3D11_STENCIL_OP_REPLACE;
    case 0x1E02: return D3D11_STENCIL_OP_INCR_SAT;
    case 0x1E03: return D3D11_STENCIL_OP_DECR_SAT;
    case 0x150A: return D3D11_STENCIL_OP_INVERT;
    case 0x8507: return D3D11_STENCIL_OP_INCR;
    case 0x8508: return D3D11_STENCIL_OP_DECR;
    default:     return D3D11_STENCIL_OP_KEEP;
    }
}

typedef struct { uint64_t k1, k2; void *obj; } StateEnt;
#define MAX_STATE 512
static StateEnt s_blend[MAX_STATE], s_depth[MAX_STATE], s_samp[MAX_STATE];
static int s_nblend, s_ndepth, s_nsamp;

static void *cache_find(StateEnt *c, int n, uint64_t k1, uint64_t k2)
{
    int i;
    for (i = 0; i < n; i++)
        if (c[i].k1 == k1 && c[i].k2 == k2) return c[i].obj;
    return NULL;
}

static ID3D11BlendState *blend_state(const GpState *st)
{
    uint32_t m = st->color_mask;
    UINT8 wm = (UINT8)(((m & 0x00010000) ? D3D11_COLOR_WRITE_ENABLE_RED : 0)
                     | ((m & 0x00000100) ? D3D11_COLOR_WRITE_ENABLE_GREEN : 0)
                     | ((m & 0x00000001) ? D3D11_COLOR_WRITE_ENABLE_BLUE : 0)
                     | ((m & 0x01000000) ? D3D11_COLOR_WRITE_ENABLE_ALPHA : 0));
    uint64_t k1 = ((uint64_t)(st->blend_en != 0) << 40) | ((uint64_t)wm << 32)
                | ((uint64_t)(st->blend_src & 0xFFFF) << 16) | (st->blend_dst & 0xFFFF);
    uint64_t k2 = st->blend_eq;
    D3D11_BLEND_DESC bd;
    ID3D11BlendState *b = (ID3D11BlendState *)cache_find(s_blend, s_nblend, k1, k2);
    if (b || s_nblend >= MAX_STATE) return b;
    memset(&bd, 0, sizeof bd);
    bd.RenderTarget[0].BlendEnable = st->blend_en != 0;
    bd.RenderTarget[0].SrcBlend = blend_factor(st->blend_src, 0);
    bd.RenderTarget[0].DestBlend = blend_factor(st->blend_dst, 0);
    bd.RenderTarget[0].BlendOp = blend_op(st->blend_eq);
    bd.RenderTarget[0].SrcBlendAlpha = blend_factor(st->blend_src, 1);
    bd.RenderTarget[0].DestBlendAlpha = blend_factor(st->blend_dst, 1);
    bd.RenderTarget[0].BlendOpAlpha = blend_op(st->blend_eq);
    bd.RenderTarget[0].RenderTargetWriteMask = wm;
    if (FAILED(ID3D11Device_CreateBlendState(s_dev, &bd, &b))) return NULL;
    s_blend[s_nblend].k1 = k1; s_blend[s_nblend].k2 = k2; s_blend[s_nblend].obj = b; s_nblend++;
    return b;
}

static ID3D11DepthStencilState *depth_state(const GpState *st, int have_ds)
{
    int dt = have_ds && st->depth_test, sten = have_ds && st->stencil_en;
    int dw = have_ds && st->depth_test && st->depth_write;
    uint64_t k1 = ((uint64_t)dt << 63) | ((uint64_t)dw << 62) | ((uint64_t)sten << 61)
                | ((uint64_t)(st->depth_func & 0xF) << 56) | ((uint64_t)(st->stencil_func & 0xF) << 52)
                | ((uint64_t)(st->stencil_fmask & 0xFF) << 44) | ((uint64_t)(st->stencil_wmask & 0xFF) << 36);
    uint64_t k2 = ((uint64_t)stencil_op(st->stencil_fail) << 32)
                | ((uint64_t)stencil_op(st->stencil_zfail) << 16) | stencil_op(st->stencil_zpass);
    D3D11_DEPTH_STENCIL_DESC dd;
    ID3D11DepthStencilState *d = (ID3D11DepthStencilState *)cache_find(s_depth, s_ndepth, k1, k2);
    if (d || s_ndepth >= MAX_STATE) return d;
    memset(&dd, 0, sizeof dd);
    dd.DepthEnable = dt;
    dd.DepthWriteMask = dw ? D3D11_DEPTH_WRITE_MASK_ALL : D3D11_DEPTH_WRITE_MASK_ZERO;
    dd.DepthFunc = cmp_func(st->depth_func);
    dd.StencilEnable = sten;
    dd.StencilReadMask = (UINT8)st->stencil_fmask;
    dd.StencilWriteMask = (UINT8)st->stencil_wmask;
    dd.FrontFace.StencilFunc = cmp_func(st->stencil_func);
    dd.FrontFace.StencilFailOp = stencil_op(st->stencil_fail);
    dd.FrontFace.StencilDepthFailOp = stencil_op(st->stencil_zfail);
    dd.FrontFace.StencilPassOp = stencil_op(st->stencil_zpass);
    dd.BackFace = dd.FrontFace;
    if (FAILED(ID3D11Device_CreateDepthStencilState(s_dev, &dd, &d))) return NULL;
    s_depth[s_ndepth].k1 = k1; s_depth[s_ndepth].k2 = k2; s_depth[s_ndepth].obj = d; s_ndepth++;
    return d;
}

static D3D11_TEXTURE_ADDRESS_MODE addr_mode(uint32_t a, int border)
{
    switch (a) {
    case 1:  return D3D11_TEXTURE_ADDRESS_WRAP;
    case 2:  return D3D11_TEXTURE_ADDRESS_MIRROR;
    case 4:  return border ? D3D11_TEXTURE_ADDRESS_BORDER : D3D11_TEXTURE_ADDRESS_CLAMP;
    default: return D3D11_TEXTURE_ADDRESS_CLAMP;
    }
}

/* While the executor checks a frame against the CPU rasteriser: sample level
 * 0 only and filter as rc_texel() does (tent or nearest, one switch for
 * both), so mip selection is not counted as a difference. */
static int s_checking;

static ID3D11SamplerState *sampler(uint32_t key, uint32_t border)
{
    uint64_t k1 = key | ((uint64_t)s_checking << 40), k2 = (key & GP_SMP_BORDER) ? border : 0;
    D3D11_SAMPLER_DESC sd;
    ID3D11SamplerState *s = (ID3D11SamplerState *)cache_find(s_samp, s_nsamp, k1, k2);
    int b = (key & GP_SMP_BORDER) != 0;
    if (s || s_nsamp >= MAX_STATE) return s;
    memset(&sd, 0, sizeof sd);
    if (s_checking || !(key & GP_SMP_FILTER)) {
        sd.Filter = (key & GP_SMP_LINEAR) ? D3D11_FILTER_MIN_MAG_MIP_LINEAR : D3D11_FILTER_MIN_MAG_MIP_POINT;
        sd.MaxLOD = 0.0f;             /* level 0 only, as the CPU rasteriser */
    } else {
        /* SET_TEXTURE_FILTER: MIN 1 BOX_LOD0, 2 TENT_LOD0, 3 BOX_NEARESTLOD,
         * 4 TENT_NEARESTLOD, 5 BOX_TENT_LOD, 6 TENT_TENT_LOD (xemu
         * pgraph_texture_min_filter_map); MAG 2 is TENT. D3D11_FILTER is
         * min linear 0x10 | mag linear 0x4 | mip linear 0x1. */
        uint32_t mn = GP_SMP_MIN_OF(key), mg = GP_SMP_MAG_OF(key);
        int minlin = mn == 2 || mn == 4 || mn == 6, miplin = mn == 5 || mn == 6;
        int mips = mn >= 3 && mn <= 6;
        sd.Filter = (D3D11_FILTER)((minlin ? 0x10 : 0) | (mg == 2 ? 0x4 : 0) | (miplin ? 0x1 : 0));
        sd.MaxLOD = mips ? D3D11_FLOAT32_MAX : 0.0f;
        sd.MipLODBias = (float)GP_SMP_BIAS_OF(key) / 256.0f;
    }
    sd.AddressU = addr_mode((key >> 4) & 0xF, b);
    sd.AddressV = addr_mode((key >> 8) & 0xF, b);
    sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.BorderColor[0] = ((border >> 16) & 0xFF) / 255.0f;
    sd.BorderColor[1] = ((border >> 8) & 0xFF) / 255.0f;
    sd.BorderColor[2] = (border & 0xFF) / 255.0f;
    sd.BorderColor[3] = (border >> 24) / 255.0f;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    if (FAILED(ID3D11Device_CreateSamplerState(s_dev, &sd, &s))) return NULL;
    s_samp[s_nsamp].k1 = k1; s_samp[s_nsamp].k2 = k2; s_samp[s_nsamp].obj = s; s_nsamp++;
    return s;
}

/* ---- resource queue ------------------------------------------------------ */

static uint32_t s_stat_tex, s_stat_shaders;

static void q_rt_create(const GpCmd *c, const void *payload)
{
    Res *r = res(c->id);
    D3D11_TEXTURE2D_DESC td;
    D3D11_SUBRESOURCE_DATA sd;
    if (!r) return;
    res_release(r);
    memset(&td, 0, sizeof td);
    td.Width = c->b; td.Height = c->c; td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    sd.pSysMem = payload; sd.SysMemPitch = c->b * 4; sd.SysMemSlicePitch = 0;
    if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, c->bytes ? &sd : NULL,
                                            (ID3D11Texture2D **)&r->res)))
        return;
    ID3D11Device_CreateRenderTargetView(s_dev, r->res, NULL, &r->rtv);
    ID3D11Device_CreateShaderResourceView(s_dev, r->res, NULL, &r->srv);
    r->kind = R_RT; r->va = c->a; r->w = c->b; r->h = c->c;
    rt_list_add(c->id);
    r->bpp = c->d & 0xFF; r->fmt = (c->d >> 8) & 0xFF; r->swz = (c->d >> 16) & 1; r->pitch = c->e;
}

/* A tile of a render target (GP_SUB_CREATE): va holds the source target id,
 * pitch its x0 | y0 << 16. Filled by do_draw, in draw order. */
static void q_sub_create(const GpCmd *c)
{
    Res *r = res(c->id);
    D3D11_TEXTURE2D_DESC td;
    if (!r) return;
    res_release(r);
    memset(&td, 0, sizeof td);
    td.Width = c->b; td.Height = c->c; td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, (ID3D11Texture2D **)&r->res)))
        return;
    ID3D11Device_CreateShaderResourceView(s_dev, r->res, NULL, &r->srv);
    r->kind = R_SUB; r->w = c->b; r->h = c->c; r->va = c->a; r->pitch = c->d;
}

static void q_ds_create(const GpCmd *c)
{
    Res *r = res(c->id);
    D3D11_TEXTURE2D_DESC td;
    if (!r) return;
    res_release(r);
    memset(&td, 0, sizeof td);
    td.Width = c->b; td.Height = c->c; td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_D32_FLOAT_S8X24_UINT;
    td.SampleDesc.Count = 1;
    td.BindFlags = D3D11_BIND_DEPTH_STENCIL;
    if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, (ID3D11Texture2D **)&r->res)))
        return;
    ID3D11Device_CreateDepthStencilView(s_dev, r->res, NULL, &r->dsv);
    r->kind = R_DS; r->w = c->b; r->h = c->c;
}

static void q_tex_create(const GpCmd *c, const uint8_t *payload)
{
    Res *r = res(c->id);
    D3D11_TEXTURE2D_DESC td;
    D3D11_SUBRESOURCE_DATA sd[6 * 16];
    uint32_t faces = c->e ? c->e : 1, levels = c->a ? c->a : 1, f, l, bb = 0;
    const uint8_t *p = payload;
    if (!r) return;
    res_release(r);
    if (levels > 16) levels = 16;
    memset(&td, 0, sizeof td);
    td.Width = c->b; td.Height = c->c; td.MipLevels = levels; td.ArraySize = faces;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_IMMUTABLE;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    if (faces == 6) td.MiscFlags = D3D11_RESOURCE_MISC_TEXTURECUBE;
    switch (c->d) {
    case GP_FMT_BC1: td.Format = DXGI_FORMAT_BC1_UNORM; bb = 8; break;
    case GP_FMT_BC2: td.Format = DXGI_FORMAT_BC2_UNORM; bb = 16; break;
    case GP_FMT_BC3: td.Format = DXGI_FORMAT_BC3_UNORM; bb = 16; break;
    default:         td.Format = DXGI_FORMAT_B8G8R8A8_UNORM; break;
    }
    /* Payload: per face, its levels in order, each tightly packed (BC
     * levels below 4x4 still take a whole block). Subresource order is the
     * same: face-major, then level. */
    for (f = 0; f < faces; f++)
        for (l = 0; l < levels; l++) {
            uint32_t lw = c->b >> l ? c->b >> l : 1, lh = c->c >> l ? c->c >> l : 1;
            uint32_t pitch = bb ? ((lw + 3) / 4) * bb : lw * 4;
            uint32_t rows = bb ? (lh + 3) / 4 : lh;
            sd[f * levels + l].pSysMem = p;
            sd[f * levels + l].SysMemPitch = pitch;
            sd[f * levels + l].SysMemSlicePitch = 0;
            p += (size_t)pitch * rows;
        }
    if ((uint32_t)(p - payload) > c->bytes) return;   /* malformed: nothing to read */
    if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, sd, (ID3D11Texture2D **)&r->res)))
        return;
    ID3D11Device_CreateShaderResourceView(s_dev, r->res, NULL, &r->srv);
    r->kind = R_TEX; r->w = c->b; r->h = c->c;
    s_stat_tex++;
}

static void q_shader_vs(const GpCmd *c, const char *src)
{
    Res *r = res(c->id);
    ID3DBlob *b;
    D3D11_INPUT_ELEMENT_DESC ie[16];
    int i;
    if (!r) return;
    res_release(r);
    if (!(b = compile(src, c->bytes - 1, "main", "vs_5_0", c->id))) return;
    ID3D11Device_CreateVertexShader(s_dev, ID3D10Blob_GetBufferPointer(b),
                                    ID3D10Blob_GetBufferSize(b), NULL, &r->vs);
    memset(ie, 0, sizeof ie);
    for (i = 0; i < 16; i++) {
        ie[i].SemanticName = "ATTR";
        ie[i].SemanticIndex = i;
        ie[i].Format = DXGI_FORMAT_R32G32B32A32_FLOAT;
        ie[i].AlignedByteOffset = i * 16;
    }
    ID3D11Device_CreateInputLayout(s_dev, ie, 16, ID3D10Blob_GetBufferPointer(b),
                                   ID3D10Blob_GetBufferSize(b), &r->layout);
    {
        static int keep = -1;
        if (keep < 0) keep = getenv("RECOMP_GPU_CHECK") != NULL;
        if (keep) r->code = b;                  /* gp_d3d11_vs_probe */
        else ID3D10Blob_Release(b);
    }
    r->kind = R_VS;
    s_stat_shaders++;
}

static void q_shader_ps(const GpCmd *c, const char *src)
{
    Res *r = res(c->id);
    ID3DBlob *b;
    if (!r) return;
    res_release(r);
    if (!(b = compile(src, c->bytes - 1, "main", "ps_5_0", c->id))) return;
    ID3D11Device_CreatePixelShader(s_dev, ID3D10Blob_GetBufferPointer(b),
                                   ID3D10Blob_GetBufferSize(b), NULL, &r->ps);
    ID3D10Blob_Release(b);
    r->kind = R_PS;
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
        case GP_SHADER_VS:  q_shader_vs(c, (const char *)payload); break;
        case GP_SHADER_PS:  q_shader_ps(c, (const char *)payload); break;

        default: break;
        }
        off += sizeof(GpCmd) + ((c->bytes + 15) & ~15u);
    }
}

/* ---- drawing ------------------------------------------------------------- */

static void upload_cb(ID3D11Buffer *cb, const void *p, size_t n)
{
    D3D11_MAPPED_SUBRESOURCE m;
    if (SUCCEEDED(ID3D11DeviceContext_Map(s_ctx, (ID3D11Resource *)cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) {
        memcpy(m.pData, p, n);
        ID3D11DeviceContext_Unmap(s_ctx, (ID3D11Resource *)cb, 0);
    }
}

static UINT s_vb_pos, s_ib_pos;
/* Constant-buffer upload cache: the VS file is 3 KB and shared by runs of
 * draws. Keyed on the arena offset within one consume call (s_seq). */
static uint32_t s_seq, s_last_vsc = ~0u, s_last_vsc_seq = ~0u;

/* Append to a dynamic ring; returns the byte offset, or ~0 if it cannot fit. */
static UINT ring_put(ID3D11Buffer *buf, UINT cap, UINT *pos, const void *p, UINT n)
{
    D3D11_MAPPED_SUBRESOURCE m;
    UINT at;
    if (n > cap) return ~0u;
    if (*pos + n > cap) *pos = 0;
    if (FAILED(ID3D11DeviceContext_Map(s_ctx, (ID3D11Resource *)buf, 0,
                                       *pos ? D3D11_MAP_WRITE_NO_OVERWRITE : D3D11_MAP_WRITE_DISCARD,
                                       0, &m)))
        return ~0u;
    memcpy((uint8_t *)m.pData + *pos, p, n);
    ID3D11DeviceContext_Unmap(s_ctx, (ID3D11Resource *)buf, 0);
    at = *pos;
    *pos += (n + 15) & ~15u;
    return at;
}

static uint32_t s_cur_target, s_cur_zeta;

static Res *bind_target(const GpDraw *d, int *have_ds)
{
    Res *rt = res(d->target), *ds = d->zeta ? res(d->zeta) : NULL;
    if (!rt || rt->kind != R_RT) return NULL;
    rt->swz = d->target_swz;               /* the frame's last use decides */
    if (ds && ds->kind != R_DS) ds = NULL;
    *have_ds = ds != NULL;
    if (s_cur_target != d->target || s_cur_zeta != (ds ? d->zeta : 0)) {
        D3D11_VIEWPORT vp;
        ID3D11ShaderResourceView *none[4] = { NULL, NULL, NULL, NULL };
        ID3D11DeviceContext_PSSetShaderResources(s_ctx, 0, 4, none);
        ID3D11DeviceContext_OMSetRenderTargets(s_ctx, 1, &rt->rtv, ds ? ds->dsv : NULL);
        memset(&vp, 0, sizeof vp);
        vp.Width = (float)rt->w; vp.Height = (float)rt->h; vp.MaxDepth = 1.0f;
        ID3D11DeviceContext_RSSetViewports(s_ctx, 1, &vp);
        s_cur_target = d->target;
        s_cur_zeta = ds ? d->zeta : 0;
    }
    rt->dirty = 1;
    return rt;
}

static struct { uint64_t draws, tris, skipped, clears, no_vs, no_ps, no_rt, no_buf; } s_st;

static void do_clear(const GpDraw *d)
{
    int have_ds;
    Res *rt = bind_target(d, &have_ds);
    if (!rt) return;
    if (d->clr_flags & 0xF0) {
        uint32_t a = d->clr_argb;
        float c[4] = { ((a >> 16) & 0xFF) / 255.0f, ((a >> 8) & 0xFF) / 255.0f,
                       (a & 0xFF) / 255.0f, (a >> 24) / 255.0f };
        ID3D11DeviceContext_ClearRenderTargetView(s_ctx, rt->rtv, c);
    }
    if ((d->clr_flags & 3) && have_ds) {
        Res *ds = res(d->zeta);
        float z = d->zeta_format == 1 ? (float)(d->clr_zs & 0xFFFF) / 65535.0f
                                      : (float)(d->clr_zs >> 8) / 16777215.0f;
        UINT fl = ((d->clr_flags & 1) ? D3D11_CLEAR_DEPTH : 0) | ((d->clr_flags & 2) ? D3D11_CLEAR_STENCIL : 0);
        ID3D11DeviceContext_ClearDepthStencilView(s_ctx, ds->dsv, fl, z, (UINT8)(d->clr_zs & 0xFF));
    }
    s_st.clears++;
}

static void do_draw(const GpFrame *f, const GpDraw *d)
{
    ID3D11ShaderResourceView *srv[4] = { NULL, NULL, NULL, NULL };
    ID3D11SamplerState *smp[4] = { NULL, NULL, NULL, NULL };
    ID3D11VertexShader *vs;
    ID3D11InputLayout *lay;
    ID3D11PixelShader *ps;
    UINT stride = d->vtx_stride, voff, ioff = 0;
    float bf[4];
    int have_ds, st;
    Res *rt;

    if (d->vs == GP_VS_TVERT) { vs = s_vs_tv; lay = s_lay_tv; }
    else if (d->vs == GP_VS_PASSTHRU) { vs = s_vs_pass; lay = s_lay_pass; }
    else { Res *r = res(d->vs); vs = r && r->kind == R_VS ? r->vs : NULL; lay = vs ? r->layout : NULL; }
    if (d->ps == GP_PS_TVERT) ps = s_ps_tv;
    else { Res *r = res(d->ps); ps = r && r->kind == R_PS ? r->ps : NULL; }
    if (!vs || !lay) { s_st.no_vs++; s_st.skipped++; return; }
    if (!ps) { s_st.no_ps++; s_st.skipped++; return; }
    if (!d->vtx_count) { s_st.skipped++; return; }
    if (!(rt = bind_target(d, &have_ds))) { s_st.no_rt++; s_st.skipped++; return; }

    for (st = 0; st < 4; st++) {
        uint32_t id = d->tex[st];
        Res *r;
        if (!id) continue;
        if (id & GP_TEX_RT) {
            id &= ~GP_TEX_RT;
            if (id == d->target) continue;      /* sampling its own target */
        }
        r = res(id);
        if (!r || !r->srv) continue;
        if (r->kind == R_SUB) {
            Res *src = res(r->va);
            D3D11_BOX box;
            box.left = r->pitch & 0xFFFF; box.top = r->pitch >> 16; box.front = 0;
            box.right = box.left + r->w; box.bottom = box.top + r->h; box.back = 1;
            if (!src || src->kind != R_RT || box.right > src->w || box.bottom > src->h
                || r->va == d->target)
                continue;
            ID3D11DeviceContext_CopySubresourceRegion(s_ctx, r->res, 0, 0, 0, 0, src->res, 0, &box);
        }
        srv[st] = r->srv;
        smp[st] = sampler(d->smp[st], d->border[st]);
    }

    voff = ring_put(s_vb, s_vb_bytes, &s_vb_pos, f->vtx + d->vtx_off, d->vtx_count * d->vtx_stride);
    if (voff == ~0u) { s_st.no_buf++; s_st.skipped++; return; }
    if (d->idx_count) {
        ioff = ring_put(s_ib, s_ib_bytes, &s_ib_pos, f->idx + d->idx_off, d->idx_count * 4);
        if (ioff == ~0u) { s_st.no_buf++; s_st.skipped++; return; }
    }

    if (d->xfc_off != ~0u)
        upload_cb(s_cb_xf, f->consts + d->xfc_off,
                  d->vs == GP_VS_TVERT ? sizeof(GpTvConsts) : sizeof(GpXfConsts));
    if (d->vsc_off != ~0u) {
        if (s_last_vsc != d->vsc_off || s_last_vsc_seq != s_seq) {
            upload_cb(s_cb_vs, f->consts + d->vsc_off, sizeof(GpVsConsts));
            s_last_vsc = d->vsc_off; s_last_vsc_seq = s_seq;
        }
    }
    if (d->psc_off != ~0u)
        upload_cb(s_cb_ps, f->consts + d->psc_off, sizeof(GpPsConsts));

    {
        ID3D11Buffer *vcb[2] = { s_cb_xf, s_cb_vs };
        ID3D11Buffer *pcb = d->ps == GP_PS_TVERT ? s_cb_xf : s_cb_ps;
        ID3D11DeviceContext_VSSetConstantBuffers(s_ctx, 0, 2, vcb);
        ID3D11DeviceContext_PSSetConstantBuffers(s_ctx, 0, 1, &pcb);
    }
    ID3D11DeviceContext_IASetInputLayout(s_ctx, lay);
    ID3D11DeviceContext_IASetPrimitiveTopology(s_ctx, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ID3D11DeviceContext_IASetVertexBuffers(s_ctx, 0, 1, &s_vb, &stride, &voff);
    ID3D11DeviceContext_VSSetShader(s_ctx, vs, NULL, 0);
    ID3D11DeviceContext_PSSetShader(s_ctx, ps, NULL, 0);
    ID3D11DeviceContext_PSSetShaderResources(s_ctx, 0, 4, srv);
    ID3D11DeviceContext_PSSetSamplers(s_ctx, 0, 4, smp);
    ID3D11DeviceContext_RSSetState(s_ctx, s_rs);

    bf[0] = ((d->st.blend_color >> 16) & 0xFF) / 255.0f;
    bf[1] = ((d->st.blend_color >> 8) & 0xFF) / 255.0f;
    bf[2] = (d->st.blend_color & 0xFF) / 255.0f;
    bf[3] = (d->st.blend_color >> 24) / 255.0f;
    if (d->st.blend_src == 0x8003 || d->st.blend_src == 0x8004
     || d->st.blend_dst == 0x8003 || d->st.blend_dst == 0x8004)
        bf[0] = bf[1] = bf[2] = bf[3];
    ID3D11DeviceContext_OMSetBlendState(s_ctx, blend_state(&d->st), bf, 0xFFFFFFFF);
    ID3D11DeviceContext_OMSetDepthStencilState(s_ctx, depth_state(&d->st, have_ds),
                                               d->st.stencil_ref & 0xFF);
    if (d->idx_count) {
        ID3D11DeviceContext_IASetIndexBuffer(s_ctx, s_ib, DXGI_FORMAT_R32_UINT, ioff);
        ID3D11DeviceContext_DrawIndexed(s_ctx, d->idx_count, 0, 0);
        s_st.tris += d->idx_count / 3;
    } else {
        ID3D11DeviceContext_Draw(s_ctx, d->vtx_count, 0);
        s_st.tris += d->vtx_count / 3;
    }
    s_st.draws++;
}

static uint16_t argb_to_16(uint32_t c, uint32_t cf)
{
    uint32_t r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
    if (cf == 3) return (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    return (uint16_t)(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
}

static void writeback(Res *r)
{
    uint8_t *mem = (uint8_t *)xbox_GetMemoryOffset();
    D3D11_MAPPED_SUBRESOURCE m;
    uint32_t y, x;
    if (!r->staging) {
        D3D11_TEXTURE2D_DESC td;
        ID3D11Texture2D_GetDesc((ID3D11Texture2D *)r->res, &td);
        td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, &r->staging))) return;
    }
    ID3D11DeviceContext_CopyResource(s_ctx, (ID3D11Resource *)r->staging, r->res);
    if (FAILED(ID3D11DeviceContext_Map(s_ctx, (ID3D11Resource *)r->staging, 0, D3D11_MAP_READ, 0, &m)))
        return;
    for (y = 0; y < r->h; y++) {
        const uint32_t *src = (const uint32_t *)((const uint8_t *)m.pData + (size_t)y * m.RowPitch);
        uint8_t *dst = mem + r->va + (size_t)y * r->pitch;
        if (r->bpp == 4) memcpy(dst, src, (size_t)r->w * 4);
        else for (x = 0; x < r->w; x++) ((uint16_t *)dst)[x] = argb_to_16(src[x], r->fmt);
    }
    ID3D11DeviceContext_Unmap(s_ctx, (ID3D11Resource *)r->staging, 0);
}

/* A swizzled target into guest memory in the NV2A's Morton order, as the
 * hardware would have left it (check mode only: normally a swizzled target is
 * only ever sampled, and the GPU samples its own copy). */
static void writeback_swz(Res *r)
{
    uint8_t *mem = (uint8_t *)xbox_GetMemoryOffset() + r->va;
    D3D11_MAPPED_SUBRESOURCE m;
    uint32_t y, x, mx, my;
    if ((r->w & (r->w - 1)) || (r->h & (r->h - 1))) return;
    if (!r->staging) {
        D3D11_TEXTURE2D_DESC td;
        ID3D11Texture2D_GetDesc((ID3D11Texture2D *)r->res, &td);
        td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, &r->staging))) return;
    }
    ID3D11DeviceContext_CopyResource(s_ctx, (ID3D11Resource *)r->staging, r->res);
    if (FAILED(ID3D11DeviceContext_Map(s_ctx, (ID3D11Resource *)r->staging, 0, D3D11_MAP_READ, 0, &m)))
        return;
    xbox_swizzle_masks(r->w, r->h, &mx, &my);
    for (y = 0; y < r->h; y++) {
        const uint32_t *src = (const uint32_t *)((const uint8_t *)m.pData + (size_t)y * m.RowPitch);
        uint32_t sy = swizzle_deposit(y, my);
        for (x = 0; x < r->w; x++) {
            uint32_t i = sy | swizzle_deposit(x, mx);
            if (r->bpp == 4) ((uint32_t *)mem)[i] = src[x];
            else ((uint16_t *)mem)[i] = argb_to_16(src[x], r->fmt);
        }
    }
    ID3D11DeviceContext_Unmap(s_ctx, (ID3D11Resource *)r->staging, 0);
}

static void consume_draws(const GpFrame *f, int sync)
{
    uint32_t i;
    s_cur_target = s_cur_zeta = 0;
    s_seq++;
    drain_queue(f);
    for (i = 0; i < f->draw_count; i++) {
        const GpDraw *d = &f->draws[i];
        if (d->kind == GP_CLEAR) do_clear(d);
        else if (d->kind == GP_DRAW) do_draw(f, d);
        else s_st.skipped++;
    }
    {
        int k = 0, j;
        for (j = 0; j < s_nrt_ids; j++) {
            Res *r = res(s_rt_ids[j]);
            if (!r || r->kind != R_RT) continue;          /* freed: drop it */
            s_rt_ids[k++] = s_rt_ids[j];
            if (r->dirty) {
                if (!r->swz && r->pitch) writeback(r);
                else if (r->swz && sync) writeback_swz(r);
                r->dirty = 0;
            }
        }
        s_nrt_ids = k;
    }
}

void gp_d3d11_sync(const GpFrame *f)
{
    if (!ensure_device()) return;
    s_checking = 1;
    consume_draws(f, 1);
    s_checking = 0;
}

/* Stream output of a program's vertex shader (gpu_proto.h). The GS is made
 * from the VS bytecode itself, which D3D11 allows: a pass-through GS with a
 * stream-output declaration and no rasterised stream. */
uint32_t gp_d3d11_vs_probe(uint32_t vs, const GpXfConsts *xc, const GpVsConsts *vc,
                           const GpProgVertex *in, uint32_t n, float *out)
{
    static ID3D11Buffer *so, *rd;
    static const D3D11_SO_DECLARATION_ENTRY decl[8] = {
        { 0, "SV_Position", 0, 0, 4, 0 }, { 0, "COLOR", 0, 0, 4, 0 }, { 0, "COLOR", 1, 0, 4, 0 },
        { 0, "TEXCOORD", 0, 0, 4, 0 }, { 0, "TEXCOORD", 1, 0, 4, 0 }, { 0, "TEXCOORD", 2, 0, 4, 0 },
        { 0, "TEXCOORD", 3, 0, 4, 0 }, { 0, "TEXCOORD", 4, 0, 1, 0 } };
    UINT stride = GP_PROBE_FLOATS * 4, zero = 0, voff, vstride = sizeof(GpProgVertex);
    Res *r = res(vs);
    D3D11_MAPPED_SUBRESOURCE m;
    ID3D11Buffer *none = NULL, *vcb[2];
    D3D11_QUERY_DESC qd;
    ID3D11Query *q = NULL;
    D3D11_QUERY_DATA_SO_STATISTICS stats;

    if (!s_dev || !r || r->kind != R_VS || !r->code || !n || n > GP_PROBE_MAX) return 0;
    if (!so) {
        D3D11_BUFFER_DESC bd;
        memset(&bd, 0, sizeof bd);
        bd.ByteWidth = GP_PROBE_MAX * GP_PROBE_FLOATS * 4;
        bd.Usage = D3D11_USAGE_DEFAULT;
        bd.BindFlags = D3D11_BIND_STREAM_OUTPUT;
        if (FAILED(ID3D11Device_CreateBuffer(s_dev, &bd, NULL, &so))) return 0;
        bd.Usage = D3D11_USAGE_STAGING; bd.BindFlags = 0; bd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        if (FAILED(ID3D11Device_CreateBuffer(s_dev, &bd, NULL, &rd))) return 0;
    }
    if (!r->so_gs
        && FAILED(ID3D11Device_CreateGeometryShaderWithStreamOutput(s_dev,
                    ID3D10Blob_GetBufferPointer(r->code), ID3D10Blob_GetBufferSize(r->code),
                    decl, 8, &stride, 1, D3D11_SO_NO_RASTERIZED_STREAM, NULL, &r->so_gs))) {
        static int shown;
        if (shown++ < 3) fprintf(stderr, "  [GPU11] stream-output GS for shader %u failed\n", vs);
        return 0;
    }
    voff = ring_put(s_vb, s_vb_bytes, &s_vb_pos, in, n * vstride);
    if (voff == ~0u) return 0;
    upload_cb(s_cb_xf, xc, sizeof *xc);
    upload_cb(s_cb_vs, vc, sizeof *vc);
    s_last_vsc = ~0u;                            /* the VS file no longer holds a draw's */
    vcb[0] = s_cb_xf; vcb[1] = s_cb_vs;
    ID3D11DeviceContext_VSSetConstantBuffers(s_ctx, 0, 2, vcb);
    ID3D11DeviceContext_IASetInputLayout(s_ctx, r->layout);
    ID3D11DeviceContext_IASetPrimitiveTopology(s_ctx, D3D11_PRIMITIVE_TOPOLOGY_POINTLIST);
    ID3D11DeviceContext_IASetVertexBuffers(s_ctx, 0, 1, &s_vb, &vstride, &voff);
    ID3D11DeviceContext_VSSetShader(s_ctx, r->vs, NULL, 0);
    ID3D11DeviceContext_GSSetShader(s_ctx, r->so_gs, NULL, 0);
    ID3D11DeviceContext_SOSetTargets(s_ctx, 1, &so, &zero);
    memset(&qd, 0, sizeof qd);
    qd.Query = D3D11_QUERY_SO_STATISTICS;
    ID3D11Device_CreateQuery(s_dev, &qd, &q);
    if (q) ID3D11DeviceContext_Begin(s_ctx, (ID3D11Asynchronous *)q);
    ID3D11DeviceContext_Draw(s_ctx, n, 0);
    if (q) ID3D11DeviceContext_End(s_ctx, (ID3D11Asynchronous *)q);
    ID3D11DeviceContext_SOSetTargets(s_ctx, 1, &none, &zero);
    ID3D11DeviceContext_GSSetShader(s_ctx, NULL, NULL, 0);
    ID3D11DeviceContext_CopyResource(s_ctx, (ID3D11Resource *)rd, (ID3D11Resource *)so);
    memset(&stats, 0, sizeof stats);
    if (q) {
        while (ID3D11DeviceContext_GetData(s_ctx, (ID3D11Asynchronous *)q, &stats, sizeof stats, 0) == S_FALSE)
            ;
        ID3D11Query_Release(q);
        if (stats.NumPrimitivesWritten < n) n = (uint32_t)stats.NumPrimitivesWritten;
    }
    if (FAILED(ID3D11DeviceContext_Map(s_ctx, (ID3D11Resource *)rd, 0, D3D11_MAP_READ, 0, &m)))
        return 0;
    memcpy(out, m.pData, (size_t)n * GP_PROBE_FLOATS * 4);
    ID3D11DeviceContext_Unmap(s_ctx, (ID3D11Resource *)rd, 0);
    return n;
}

void gp_d3d11_consume(const GpFrame *f)
{
    if (!ensure_device()) return;
    consume_draws(f, 0);
    if (f->frame % 300 == 299) {
        fprintf(stderr, "  [GPU11] frames %u: %llu draws, %llu tris, %llu clears, %llu skipped;"
                " %u textures and %u shaders created\n", f->frame + 1,
                (unsigned long long)s_st.draws, (unsigned long long)s_st.tris,
                (unsigned long long)s_st.clears, (unsigned long long)s_st.skipped,
                s_stat_tex, s_stat_shaders);
        memset(&s_st, 0, sizeof s_st);
        s_stat_tex = s_stat_shaders = 0;
    }
}
