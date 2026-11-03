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
 *
 * Display options (gpu_display.h): with a resolution scale every render
 * target, depth buffer and render-target tile is that much larger (the
 * vertex shaders map guest surface pixels to clip space by the guest size,
 * so only the viewport changes), guest pixels going in are scaled up and
 * targets going back to guest memory are box-filtered down to the guest
 * size; the window shows the full-size image through a swap chain of this
 * device (gp_d3d11_present_*). With MSAA every target and depth buffer is
 * multisampled and resolved before anything reads it. With neither, none of
 * that code runs (s_active == 0).
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
#include "gpu_display.h"
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
    uint32_t mask;                  /* R_VS: the inputs it reads (vertex layout) */
    /* Display options only (s_active): */
    uint32_t sw, sh;                /* scaled size (R_RT, R_DS, R_SUB) */
    uint32_t bx, by;                /* R_SUB: scaled top-left in the source */
    ID3D11Texture2D *ms;            /* MSAA colour (R_RT), drawn into */
    ID3D11RenderTargetView *msrtv;
    uint32_t msdirty;               /* drawn since the last resolve into res */
    ID3D11Texture2D *down;          /* scaled: guest-size copy for writeback */
    ID3D11RenderTargetView *downrtv;
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
    REL(msrtv, ID3D11RenderTargetView); REL(ms, ID3D11Texture2D);
    REL(downrtv, ID3D11RenderTargetView); REL(down, ID3D11Texture2D);
    if (r->code) ID3D10Blob_Release(r->code);
#undef REL
    memset(r, 0, sizeof *r);
}

/* Display options (gpu_display.h): the current scale per axis, the MSAA
 * sample count, and whether any of it is on. */
static float s_sx = 1.0f, s_sy = 1.0f;
static int s_msaa = 1, s_active;
static int rt_make(Res *r);
static void blit(ID3D11ShaderResourceView *src, uint32_t srcw, uint32_t srch,
                 ID3D11RenderTargetView *dst, float x, float y, float w, float h);
static void resolve(Res *r);
static ID3D11RenderTargetView *draw_rtv(Res *r) { return r->msrtv ? r->msrtv : r->rtv; }
static int display_init(void);

/* ---- device -------------------------------------------------------------- */

static ID3D11Buffer *s_vb, *s_ib, *s_cb_vs, *s_cb_xf, *s_cb_ps;
static UINT s_vb_bytes, s_ib_bytes;
static ID3D11RasterizerState *s_rs;
static ID3D11VertexShader *s_vs_pass, *s_vs_tv;
static ID3D11InputLayout *s_lay_pass, *s_lay_tv;
static ID3D11PixelShader *s_ps_tv;
/* A clear of part of a target (GpDraw.rect smaller than the target: a split
 * screen view's viewport): a triangle over the target, cut to the rect by the
 * scissor, writing the clear colour and depth. */
static ID3D11VertexShader *s_vs_clr;
static ID3D11PixelShader *s_ps_clr;
static const char s_clr_hlsl[] =
"cbuffer C : register(b0) { float4 col; float z; float3 pad; };\n"
"float4 vs(uint id : SV_VertexID) : SV_Position {\n"
"  float2 p = float2((id << 1) & 2, id & 2);\n"
"  return float4(p * float2(2, -2) + float2(-1, 1), z, 1); }\n"
"float4 ps() : SV_Target { return col; }\n";

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

/* ---- shader compiles ---------------------------------------------------------
 *
 * D3DCompile takes 10-40 ms per generated shader here, and a race's first
 * frames bring 6-9 new ones (when the race scene appears and when the
 * player's view takes over), all compiled at the flip on the walk thread:
 * 50-80 ms frames. Two things take that off the frame:
 *  - a disk cache of compiled bytecode (RECOMP_GPU_SHADER_CACHE=<dir>,
 *    default "shadercache" under the working directory -- inside atv2-web;
 *    "0" turns it off). Keyed by a hash of the HLSL, the entry point, the
 *    target and the flags, and checked against a second hash and the source
 *    length, so a hit is the same HLSL compiled the same way;
 *  - early compiles: the recorder hands each new shader over the moment it
 *    generates it (gp_d3d11_prefetch_shader, mid-walk), and a thread-pool
 *    worker compiles it while the walk goes on. The flip takes the result,
 *    waiting only if it isn't done yet.
 * Same source, same flags, same compiler: the bytecode is what the old path
 * produced, so nothing drawn changes. */
#define SH_FLAGS (D3DCOMPILE_OPTIMIZATION_LEVEL1)
#define SH_MAGIC 0x31485347u                  /* "GSH1" */

typedef struct ShJob {
    uint64_t key, key2;
    uint32_t variant;                     /* VS input mask (GP_SHADER_VS b), 0 otherwise */
    char *src;
    size_t len;
    char entry[16], target[16];
    ID3DBlob *code;
    char *err;
    LONG done;
    int from_disk;
    struct ShJob *next;
} ShJob;
static SRWLOCK s_sh_lock = SRWLOCK_INIT;
static CONDITION_VARIABLE s_sh_cv = CONDITION_VARIABLE_INIT;
static ShJob *s_sh_jobs;
static struct { uint32_t early, disk, compiled, waited; double compile_ms, wait_ms; } s_sh_st;

static uint64_t sh_fnv(const void *p, size_t n, uint64_t h)
{
    const uint8_t *b = (const uint8_t *)p;
    size_t i;
    for (i = 0; i < n; i++) { h ^= b[i]; h *= 1099511628211ull; }
    return h;
}

static void sh_keys(const char *src, size_t len, const char *entry, const char *target,
                    uint32_t variant, uint64_t *k1, uint64_t *k2)
{
    uint32_t flags = SH_FLAGS;
    uint64_t h = sh_fnv(entry, strlen(entry) + 1, 1469598103934665603ull);
    h = sh_fnv(target, strlen(target) + 1, h);
    h = sh_fnv(&flags, sizeof flags, h);
    h = sh_fnv(&variant, sizeof variant, h);
    *k1 = sh_fnv(src, len, h);
    *k2 = sh_fnv(src, len, h ^ 0x9E3779B97F4A7C15ull);   /* a second, independent hash */
}

static const char *sh_cache_dir(void)
{
    static char dir[MAX_PATH];
    static int state = -1;                    /* -1 unknown, 0 off, 1 on */
    if (state < 0) {
        const char *e = getenv("RECOMP_GPU_SHADER_CACHE");
        state = 0;
        if (!e || !*e) e = "shadercache";
        if (strcmp(e, "0") && _stricmp(e, "off")) {
            snprintf(dir, sizeof dir, "%s", e);
            CreateDirectoryA(dir, NULL);
            state = (GetFileAttributesA(dir) & FILE_ATTRIBUTE_DIRECTORY)
                    && GetFileAttributesA(dir) != INVALID_FILE_ATTRIBUTES;
            fprintf(stderr, "  [GPU11] shader cache: %s%s\n", dir, state ? "" : " (cannot create: off)");
        }
    }
    return state > 0 ? dir : NULL;
}

typedef struct { uint32_t magic, srclen; uint64_t key2; uint32_t bytes, pad; } ShFileHdr;

static ID3DBlob *sh_disk_load(uint64_t k1, uint64_t k2, size_t srclen)
{
    const char *dir = sh_cache_dir();
    char path[MAX_PATH + 32];
    ShFileHdr hd;
    ID3DBlob *b = NULL;
    FILE *f;
    if (!dir) return NULL;
    snprintf(path, sizeof path, "%s\\%016llx.dxbc", dir, (unsigned long long)k1);
    if (!(f = fopen(path, "rb"))) return NULL;
    if (fread(&hd, sizeof hd, 1, f) == 1 && hd.magic == SH_MAGIC && hd.key2 == k2
        && hd.srclen == (uint32_t)srclen && hd.bytes && hd.bytes < (64u << 20)
        && SUCCEEDED(D3DCreateBlob(hd.bytes, &b))
        && fread(ID3D10Blob_GetBufferPointer(b), 1, hd.bytes, f) != hd.bytes) {
        ID3D10Blob_Release(b);
        b = NULL;
    }
    fclose(f);
    return b;
}

static void sh_disk_store(uint64_t k1, uint64_t k2, size_t srclen, ID3DBlob *b)
{
    const char *dir = sh_cache_dir();
    char path[MAX_PATH + 32], tmp[MAX_PATH + 48];
    ShFileHdr hd;
    FILE *f;
    int ok;
    if (!dir || !b) return;
    snprintf(path, sizeof path, "%s\\%016llx.dxbc", dir, (unsigned long long)k1);
    snprintf(tmp, sizeof tmp, "%s.%lu.tmp", path, GetCurrentThreadId());
    memset(&hd, 0, sizeof hd);
    hd.magic = SH_MAGIC; hd.srclen = (uint32_t)srclen; hd.key2 = k2;
    hd.bytes = (uint32_t)ID3D10Blob_GetBufferSize(b);
    if (!(f = fopen(tmp, "wb"))) return;
    ok = fwrite(&hd, sizeof hd, 1, f) == 1
      && fwrite(ID3D10Blob_GetBufferPointer(b), 1, hd.bytes, f) == hd.bytes;
    ok = !fclose(f) && ok;
    /* Another process may have written it meanwhile: either copy is the same. */
    if (!ok || !MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING)) DeleteFileA(tmp);
}

/* D3DCompile itself. On failure, *err gets the compiler's message (malloc'd). */
static ID3DBlob *sh_compile(const char *src, size_t len, const char *entry, const char *target,
                            char **err_out)
{
    ID3DBlob *code = NULL, *err = NULL;
    HRESULT hr = D3DCompile(src, len, "gpu", NULL, NULL, entry, target, SH_FLAGS, 0, &code, &err);
    *err_out = NULL;
    if (FAILED(hr)) {
        const char *m = err ? (const char *)ID3D10Blob_GetBufferPointer(err) : "?";
        if ((*err_out = (char *)malloc(strlen(m) + 1))) strcpy(*err_out, m);
        code = NULL;
    }
    if (err) ID3D10Blob_Release(err);
    return code;
}

static void CALLBACK sh_job_run(PTP_CALLBACK_INSTANCE inst, void *arg)
{
    ShJob *j = (ShJob *)arg;
    (void)inst;
    j->from_disk = (j->code = sh_disk_load(j->key, j->key2, j->len)) != NULL;
    if (!j->code) {
        j->code = sh_compile(j->src, j->len, j->entry, j->target, &j->err);
        if (j->code) sh_disk_store(j->key, j->key2, j->len, j->code);
    }
    AcquireSRWLockExclusive(&s_sh_lock);
    j->done = 1;
    WakeAllConditionVariable(&s_sh_cv);
    ReleaseSRWLockExclusive(&s_sh_lock);
}

static int sh_early_on(void)
{
    static int on = -1;
    if (on < 0) {
        const char *b = getenv("RECOMP_GPU_BACKEND"), *e = getenv("RECOMP_GPU_EARLY_COMPILE");
        on = !(b && !_stricmp(b, "wgpu")) && !(e && *e == '0');
    }
    return on;
}

/* The recorder (gpu_rec.c) has just queued shader source: start compiling it. */
void gp_d3d11_prefetch_shader(int pixel, uint32_t mask, const char *src, size_t len)
{
    ShJob *j;
    if (!sh_early_on() || !(j = (ShJob *)calloc(1, sizeof *j))) return;
    if (!(j->src = (char *)malloc(len))) { free(j); return; }
    memcpy(j->src, src, len);
    j->len = len;
    strcpy(j->entry, "main");
    strcpy(j->target, pixel ? "ps_5_0" : "vs_5_0");
    j->variant = pixel ? 0 : (mask ? mask : 0xFFFF);
    sh_keys(src, len, j->entry, j->target, j->variant, &j->key, &j->key2);
    AcquireSRWLockExclusive(&s_sh_lock);
    {
        /* The same HLSL from two programs: one compile serves both (the
         * second flip-time lookup reads the disk cache). */
        ShJob *o;
        for (o = s_sh_jobs; o && !(o->key == j->key && o->key2 == j->key2); o = o->next) ;
        if (o) {
            ReleaseSRWLockExclusive(&s_sh_lock);
            free(j->src);
            free(j);
            return;
        }
    }
    j->next = s_sh_jobs;
    s_sh_jobs = j;
    ReleaseSRWLockExclusive(&s_sh_lock);
    if (!TrySubmitThreadpoolCallback(sh_job_run, j, NULL)) {
        /* No pool: the flip compiles it as before. */
        AcquireSRWLockExclusive(&s_sh_lock);
        j->done = 1;
        ReleaseSRWLockExclusive(&s_sh_lock);
    }
}

/* An early compile of exactly this source, waited for and unlinked, or NULL. */
static ShJob *sh_take_job(uint64_t k1, uint64_t k2, size_t len)
{
    ShJob **pp, *j = NULL;
    double t0 = 0;
    AcquireSRWLockExclusive(&s_sh_lock);
    for (pp = &s_sh_jobs; *pp; pp = &(*pp)->next)
        if ((*pp)->key == k1 && (*pp)->key2 == k2 && (*pp)->len == len) {
            j = *pp;
            *pp = j->next;
            break;
        }
    if (j && !j->done) {
        t0 = gp_now_ms();
        s_sh_st.waited++;
        while (!j->done) SleepConditionVariableSRW(&s_sh_cv, &s_sh_lock, INFINITE, 0);
        s_sh_st.wait_ms += gp_now_ms() - t0;
    }
    ReleaseSRWLockExclusive(&s_sh_lock);
    return j;
}

static ID3DBlob *compile_v(const char *src, size_t len, const char *entry, const char *target,
                           uint32_t id, uint32_t variant)
{
    uint64_t k1, k2;
    ID3DBlob *code;
    ShJob *j;
    char *err = NULL;

    sh_keys(src, len, entry, target, variant, &k1, &k2);
    if ((j = sh_take_job(k1, k2, len)) != NULL) {
        code = j->code;
        err = j->err;
        if (j->from_disk) s_sh_st.disk++;
        else if (code || err) s_sh_st.early++;
        free(j->src);
        free(j);
        if (!code && !err) goto sync;             /* never ran (no thread pool) */
    } else if ((code = sh_disk_load(k1, k2, len)) != NULL) {
        s_sh_st.disk++;
    } else {
        double t0;
sync:
        t0 = gp_now_ms();
        code = sh_compile(src, len, entry, target, &err);
        s_sh_st.compiled++;
        s_sh_st.compile_ms += gp_now_ms() - t0;
        if (code) sh_disk_store(k1, k2, len, code);
    }
    if (!code) {
        static int shown;
        fprintf(stderr, "  [GPU11] shader %u (%s) failed: %s\n", id, target, err ? err : "?");
        if (shown++ < 3) fprintf(stderr, "----\n%.*s\n----\n", (int)len, src);
    }
    free(err);
    if (s_dump_shaders < 0) s_dump_shaders = getenv("RECOMP_GPU_DUMP_SHADERS") != NULL;
    if (s_dump_shaders) {
        char path[128];
        FILE *f;
        snprintf(path, sizeof path, "gpu_shader_%u_%s.hlsl", id, target);
        if ((f = fopen(path, "wb"))) { fwrite(src, 1, len, f); fclose(f); }
    }
    return code;
}

static ID3DBlob *compile(const char *src, size_t len, const char *entry, const char *target,
                         uint32_t id)
{
    return compile_v(src, len, entry, target, id, 0);
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
    rd.ScissorEnable = TRUE;            /* GpDraw.rect: the window clip */
    ID3D11Device_CreateRasterizerState(s_dev, &rd, &s_rs);
    if ((b = compile(s_clr_hlsl, sizeof s_clr_hlsl - 1, "vs", "vs_5_0", 3))) {
        ID3D11Device_CreateVertexShader(s_dev, ID3D10Blob_GetBufferPointer(b),
                                        ID3D10Blob_GetBufferSize(b), NULL, &s_vs_clr);
        ID3D10Blob_Release(b);
    }
    if ((b = compile(s_clr_hlsl, sizeof s_clr_hlsl - 1, "ps", "ps_5_0", 2))) {
        ID3D11Device_CreatePixelShader(s_dev, ID3D10Blob_GetBufferPointer(b),
                                       ID3D10Blob_GetBufferSize(b), NULL, &s_ps_clr);
        ID3D10Blob_Release(b);
    }

    if (!display_init()) return 0;
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
    static int no_mips = -1;
    if (no_mips < 0) no_mips = getenv("RECOMP_GPU_NO_MIPS") != NULL;   /* A/B: level 0 only */
    if (s_checking || no_mips || !(key & GP_SMP_FILTER)) {
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
    if (s_active) {
        /* Scaled and/or multisampled: the guest's pixels (if any) go in
         * through a guest-size texture, scaled up into the draw target. */
        r->w = c->b; r->h = c->c;
        if (!rt_make(r)) { res_release(r); return; }
        if (c->bytes) {
            ID3D11Texture2D *t = NULL;
            ID3D11ShaderResourceView *v = NULL;
            memset(&td, 0, sizeof td);
            td.Width = c->b; td.Height = c->c; td.MipLevels = 1; td.ArraySize = 1;
            td.Format = DXGI_FORMAT_B8G8R8A8_UNORM; td.SampleDesc.Count = 1;
            td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
            sd.pSysMem = payload; sd.SysMemPitch = c->b * 4; sd.SysMemSlicePitch = 0;
            if (SUCCEEDED(ID3D11Device_CreateTexture2D(s_dev, &td, &sd, &t))
                && SUCCEEDED(ID3D11Device_CreateShaderResourceView(s_dev, (ID3D11Resource *)t, NULL, &v)))
                blit(v, c->b, c->c, draw_rtv(r), 0, 0, (float)r->sw, (float)r->sh);
            if (v) ID3D11ShaderResourceView_Release(v);
            if (t) ID3D11Texture2D_Release(t);
            if (r->ms) r->msdirty = 1;
        }
        r->kind = R_RT; r->va = c->a;
        rt_list_add(c->id);
        r->bpp = c->d & 0xFF; r->fmt = (c->d >> 8) & 0xFF; r->swz = (c->d >> 16) & 1; r->pitch = c->e;
        return;
    }
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
    if (s_active) {
        /* The tile's box in the scaled source: both edges scaled, so tiles
         * that share an edge share it at any scale. */
        uint32_t x0 = c->d & 0xFFFF, y0 = c->d >> 16;
        r->bx = gp_scaled(x0, s_sx); r->by = gp_scaled(y0, s_sy);
        r->sw = gp_scaled(x0 + c->b, s_sx) - r->bx; r->sh = gp_scaled(y0 + c->c, s_sy) - r->by;
        td.Width = r->sw; td.Height = r->sh;
    }
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
    if (s_active) {
        r->sw = td.Width = gp_scaled(c->b, s_sx);
        r->sh = td.Height = gp_scaled(c->c, s_sy);
        td.SampleDesc.Count = (UINT)s_msaa;
    }
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
    int i, n;
    if (!r) return;
    res_release(r);
    if (!(b = compile_v(src, c->bytes - 1, "main", "vs_5_0", c->id, c->b ? c->b : 0xFFFF))) return;
    ID3D11Device_CreateVertexShader(s_dev, ID3D10Blob_GetBufferPointer(b),
                                    ID3D10Blob_GetBufferSize(b), NULL, &r->vs);
    /* The inputs the program reads, packed in register order (GP_SHADER_VS
     * b; gpu_gen_vs_program declares just those). */
    memset(ie, 0, sizeof ie);
    r->mask = c->b ? c->b : 0xFFFF;
    for (i = n = 0; i < 16; i++) {
        if (!(r->mask & (1u << i))) continue;
        ie[n].SemanticName = "ATTR";
        ie[n].SemanticIndex = i;
        ie[n].Format = DXGI_FORMAT_R32G32B32A32_FLOAT;
        ie[n].AlignedByteOffset = n * 16;
        n++;
    }
    ID3D11Device_CreateInputLayout(s_dev, ie, n, ID3D10Blob_GetBufferPointer(b),
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
    double t = gp_now_ms(), t1;
    while (off + sizeof(GpCmd) <= f->queue_bytes) {
        const GpCmd *c = (const GpCmd *)(f->queue + off);
        const uint8_t *payload = (const uint8_t *)(c + 1);
        int what = c->op == GP_TEX_CREATE ? GP_T_CON_TEX
                 : c->op == GP_SHADER_VS || c->op == GP_SHADER_PS ? GP_T_CON_SH
                 : c->op == GP_TEX_FREE ? -1 : GP_T_CON_RT;
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
        t1 = gp_now_ms();
        gp_time_add(what, t1 - t, 1);
        t = t1;
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
/* Constant-buffer upload cache: runs of draws share their blocks (the
 * recorder hands out one offset for equal consecutive blocks). Keyed on the
 * arena offset, so forgotten at every consume call. */
static uint32_t s_seq, s_last_vsc = ~0u, s_last_xfc = ~0u, s_last_psc = ~0u;

/* The frame's vertex and index arenas, uploaded once per consume (one Map
 * each, not one per draw); ~0 when they did not fit and draws upload their
 * own. */
static UINT s_frame_voff = ~0u, s_frame_ioff = ~0u;

/* What the context has bound, so a run of draws sets only what changes.
 * Forgotten (s_bound.valid = 0) whenever something else binds: clears, the
 * stream-output probe, the window thread's blit (between consumes). */
static struct {
    int valid;
    ID3D11InputLayout *lay;
    ID3D11VertexShader *vs;
    ID3D11PixelShader *ps;
    ID3D11ShaderResourceView *srv[4];
    ID3D11SamplerState *smp[4];
    ID3D11BlendState *bs;
    float bf[4];
    ID3D11DepthStencilState *ds;
    UINT sref;
    D3D11_RECT sc;
    ID3D11Buffer *pcb;
    UINT stride, voff;
    int ib;
} s_bound;

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
        memset(s_bound.srv, 0, sizeof s_bound.srv);
        memset(&vp, 0, sizeof vp);
        if (s_active) {
            ID3D11RenderTargetView *v = draw_rtv(rt);
            ID3D11DeviceContext_OMSetRenderTargets(s_ctx, 1, &v, ds ? ds->dsv : NULL);
            vp.Width = (float)rt->sw; vp.Height = (float)rt->sh; vp.MaxDepth = 1.0f;
        } else {
        ID3D11DeviceContext_OMSetRenderTargets(s_ctx, 1, &rt->rtv, ds ? ds->dsv : NULL);
        vp.Width = (float)rt->w; vp.Height = (float)rt->h; vp.MaxDepth = 1.0f;
        }
        ID3D11DeviceContext_RSSetViewports(s_ctx, 1, &vp);
        s_cur_target = d->target;
        s_cur_zeta = ds ? d->zeta : 0;
    }
    rt->dirty = 1;
    if (rt->ms) rt->msdirty = 1;
    return rt;
}

static struct { uint64_t draws, tris, skipped, clears, no_vs, no_ps, no_rt, no_buf; } s_st;

/* GpDraw.rect as a D3D11 rect; 0 if it covers the whole target. */
static int draw_rect(const GpDraw *d, const Res *rt, D3D11_RECT *r)
{
    r->left = (LONG)(d->rect[0] & 0xFFFF); r->top = (LONG)(d->rect[0] >> 16);
    r->right = (LONG)(d->rect[1] & 0xFFFF); r->bottom = (LONG)(d->rect[1] >> 16);
    if (!d->rect[1] || (r->left <= 0 && r->top <= 0 && r->right >= (LONG)rt->w
                        && r->bottom >= (LONG)rt->h)) {
        r->left = r->top = 0; r->right = (LONG)rt->w; r->bottom = (LONG)rt->h;
        if (s_active) { r->right = (LONG)rt->sw; r->bottom = (LONG)rt->sh; }
        return 0;
    }
    if (s_active) {      /* target pixels at the display scale (both edges scaled) */
        r->left = (LONG)gp_scaled((uint32_t)r->left, s_sx); r->right = (LONG)gp_scaled((uint32_t)r->right, s_sx);
        r->top = (LONG)gp_scaled((uint32_t)r->top, s_sy); r->bottom = (LONG)gp_scaled((uint32_t)r->bottom, s_sy);
    }
    return 1;
}

static void do_clear(const GpDraw *d)
{
    int have_ds;
    D3D11_RECT rc;
    Res *rt = bind_target(d, &have_ds);
    if (!rt) return;
    if (draw_rect(d, rt, &rc) && s_vs_clr && s_ps_clr) {
        /* Part of the target: draw it (ClearView would do colour only). */
        struct { float col[4], z, pad[3]; } cc;
        GpState st;
        uint32_t a = d->clr_argb, f = d->clr_flags;
        cc.col[0] = ((a >> 16) & 0xFF) / 255.0f; cc.col[1] = ((a >> 8) & 0xFF) / 255.0f;
        cc.col[2] = (a & 0xFF) / 255.0f; cc.col[3] = (a >> 24) / 255.0f;
        cc.z = d->zeta_format == 1 ? (float)(d->clr_zs & 0xFFFF) / 65535.0f
                                   : (float)(d->clr_zs >> 8) / 16777215.0f;
        cc.pad[0] = cc.pad[1] = cc.pad[2] = 0;
        memset(&st, 0, sizeof st);
        /* CLEAR_SURFACE: Z 0x1, stencil 0x2, R 0x10 G 0x20 B 0x40 A 0x80 */
        st.color_mask = ((f & 0x10) ? 0x00010000u : 0) | ((f & 0x20) ? 0x100u : 0)
                      | ((f & 0x40) ? 0x1u : 0) | ((f & 0x80) ? 0x01000000u : 0);
        st.depth_test = (f & 3) != 0; st.depth_func = 0x207; st.depth_write = (f & 1) != 0;
        st.stencil_en = (f & 2) != 0; st.stencil_func = 0x207;
        st.stencil_fmask = st.stencil_wmask = 0xFF;
        st.stencil_fail = st.stencil_zfail = 0x1E00; st.stencil_zpass = 0x1E01;
        upload_cb(s_cb_xf, &cc, sizeof cc);
        s_last_xfc = ~0u;
        s_bound.valid = 0;
        ID3D11DeviceContext_VSSetConstantBuffers(s_ctx, 0, 1, &s_cb_xf);
        ID3D11DeviceContext_PSSetConstantBuffers(s_ctx, 0, 1, &s_cb_xf);
        ID3D11DeviceContext_IASetInputLayout(s_ctx, NULL);
        ID3D11DeviceContext_IASetPrimitiveTopology(s_ctx, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D11DeviceContext_VSSetShader(s_ctx, s_vs_clr, NULL, 0);
        ID3D11DeviceContext_PSSetShader(s_ctx, s_ps_clr, NULL, 0);
        ID3D11DeviceContext_RSSetState(s_ctx, s_rs);
        ID3D11DeviceContext_RSSetScissorRects(s_ctx, 1, &rc);
        ID3D11DeviceContext_OMSetBlendState(s_ctx, blend_state(&st), NULL, 0xFFFFFFFF);
        ID3D11DeviceContext_OMSetDepthStencilState(s_ctx, depth_state(&st, have_ds),
                                                   d->clr_zs & 0xFF);
        ID3D11DeviceContext_Draw(s_ctx, 3, 0);
        s_st.clears++;
        return;
    }
    if (d->clr_flags & 0xF0) {
        uint32_t a = d->clr_argb;
        float c[4] = { ((a >> 16) & 0xFF) / 255.0f, ((a >> 8) & 0xFF) / 255.0f,
                       (a & 0xFF) / 255.0f, (a >> 24) / 255.0f };
        ID3D11DeviceContext_ClearRenderTargetView(s_ctx, s_active ? draw_rtv(rt) : rt->rtv, c);
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
            if (s_active && src && src->kind == R_RT) {
                box.left = r->bx; box.top = r->by;
                box.right = box.left + r->sw; box.bottom = box.top + r->sh;
                if (box.right > src->sw || box.bottom > src->sh || r->va == d->target)
                    continue;
                resolve(src);
            } else
            if (!src || src->kind != R_RT || box.right > src->w || box.bottom > src->h
                || r->va == d->target)
                continue;
            ID3D11DeviceContext_CopySubresourceRegion(s_ctx, r->res, 0, 0, 0, 0, src->res, 0, &box);
        }
        if (r->kind == R_RT) resolve(r);       /* MSAA: sampled from res */
        srv[st] = r->srv;
        smp[st] = sampler(d->smp[st], d->border[st]);
    }

    if (s_frame_voff != ~0u)
        voff = s_frame_voff + d->vtx_off;
    else
        voff = ring_put(s_vb, s_vb_bytes, &s_vb_pos, f->vtx + d->vtx_off, d->vtx_count * d->vtx_stride);
    if (voff == ~0u) { s_st.no_buf++; s_st.skipped++; return; }
    if (d->idx_count) {
        if (s_frame_ioff != ~0u)
            ioff = s_frame_ioff + d->idx_off * 4;
        else
            ioff = ring_put(s_ib, s_ib_bytes, &s_ib_pos, f->idx + d->idx_off, d->idx_count * 4);
        if (ioff == ~0u) { s_st.no_buf++; s_st.skipped++; return; }
    }

    if (!s_bound.valid) {
        ID3D11Buffer *vcb[2] = { s_cb_xf, s_cb_vs };
        void *none = (void *)~(uintptr_t)0;   /* matches no real object */
        memset(&s_bound, 0, sizeof s_bound);
        s_bound.valid = 1;
        s_bound.lay = none; s_bound.vs = none; s_bound.ps = none;
        s_bound.bs = none; s_bound.ds = none; s_bound.pcb = none;
        s_bound.sc.left = -1;
        s_bound.stride = s_bound.voff = ~0u;
        s_bound.sref = ~0u;
        s_bound.ib = -1;
        ID3D11DeviceContext_VSSetConstantBuffers(s_ctx, 0, 2, vcb);
        ID3D11DeviceContext_IASetPrimitiveTopology(s_ctx, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D11DeviceContext_RSSetState(s_ctx, s_rs);
        ID3D11DeviceContext_PSSetShaderResources(s_ctx, 0, 4, s_bound.srv);
        ID3D11DeviceContext_PSSetSamplers(s_ctx, 0, 4, s_bound.smp);
    }
    if (d->xfc_off != ~0u && d->xfc_off != s_last_xfc) {
        upload_cb(s_cb_xf, f->consts + d->xfc_off,
                  d->vs == GP_VS_TVERT ? sizeof(GpTvConsts) : sizeof(GpXfConsts));
        s_last_xfc = d->xfc_off;
    }
    if (d->vsc_off != ~0u && d->vsc_off != s_last_vsc) {
        upload_cb(s_cb_vs, f->consts + d->vsc_off, sizeof(GpVsConsts));
        s_last_vsc = d->vsc_off;
    }
    if (d->psc_off != ~0u && d->psc_off != s_last_psc) {
        upload_cb(s_cb_ps, f->consts + d->psc_off, sizeof(GpPsConsts));
        s_last_psc = d->psc_off;
    }

    {
        ID3D11Buffer *pcb = d->ps == GP_PS_TVERT ? s_cb_xf : s_cb_ps;
        if (pcb != s_bound.pcb) {
            ID3D11DeviceContext_PSSetConstantBuffers(s_ctx, 0, 1, &pcb);
            s_bound.pcb = pcb;
        }
    }
    if (lay != s_bound.lay) { ID3D11DeviceContext_IASetInputLayout(s_ctx, lay); s_bound.lay = lay; }
    if (stride != s_bound.stride || voff != s_bound.voff) {
        ID3D11DeviceContext_IASetVertexBuffers(s_ctx, 0, 1, &s_vb, &stride, &voff);
        s_bound.stride = stride; s_bound.voff = voff;
    }
    if (vs != s_bound.vs) { ID3D11DeviceContext_VSSetShader(s_ctx, vs, NULL, 0); s_bound.vs = vs; }
    if (ps != s_bound.ps) { ID3D11DeviceContext_PSSetShader(s_ctx, ps, NULL, 0); s_bound.ps = ps; }
    if (memcmp(srv, s_bound.srv, sizeof srv)) {
        ID3D11DeviceContext_PSSetShaderResources(s_ctx, 0, 4, srv);
        memcpy(s_bound.srv, srv, sizeof srv);
    }
    if (memcmp(smp, s_bound.smp, sizeof smp)) {
        ID3D11DeviceContext_PSSetSamplers(s_ctx, 0, 4, smp);
        memcpy(s_bound.smp, smp, sizeof smp);
    }
    {
        D3D11_RECT rc;
        draw_rect(d, rt, &rc);
        if (memcmp(&rc, &s_bound.sc, sizeof rc)) {
            ID3D11DeviceContext_RSSetScissorRects(s_ctx, 1, &rc);
            s_bound.sc = rc;
        }
    }

    bf[0] = ((d->st.blend_color >> 16) & 0xFF) / 255.0f;
    bf[1] = ((d->st.blend_color >> 8) & 0xFF) / 255.0f;
    bf[2] = (d->st.blend_color & 0xFF) / 255.0f;
    bf[3] = (d->st.blend_color >> 24) / 255.0f;
    if (d->st.blend_src == 0x8003 || d->st.blend_src == 0x8004
     || d->st.blend_dst == 0x8003 || d->st.blend_dst == 0x8004)
        bf[0] = bf[1] = bf[2] = bf[3];
    {
        ID3D11BlendState *bs = blend_state(&d->st);
        ID3D11DepthStencilState *dss = depth_state(&d->st, have_ds);
        UINT ref = d->st.stencil_ref & 0xFF;
        if (bs != s_bound.bs || memcmp(bf, s_bound.bf, sizeof bf)) {
            ID3D11DeviceContext_OMSetBlendState(s_ctx, bs, bf, 0xFFFFFFFF);
            s_bound.bs = bs; memcpy(s_bound.bf, bf, sizeof bf);
        }
        if (dss != s_bound.ds || ref != s_bound.sref) {
            ID3D11DeviceContext_OMSetDepthStencilState(s_ctx, dss, ref);
            s_bound.ds = dss; s_bound.sref = ref;
        }
    }
    if (d->idx_count) {
        if (s_frame_ioff != ~0u) {
            if (s_bound.ib != 0) {
                ID3D11DeviceContext_IASetIndexBuffer(s_ctx, s_ib, DXGI_FORMAT_R32_UINT, 0);
                s_bound.ib = 0;
            }
            ID3D11DeviceContext_DrawIndexed(s_ctx, d->idx_count, ioff / 4, 0);
        } else {
            ID3D11DeviceContext_IASetIndexBuffer(s_ctx, s_ib, DXGI_FORMAT_R32_UINT, ioff);
            s_bound.ib = -1;
            ID3D11DeviceContext_DrawIndexed(s_ctx, d->idx_count, 0, 0);
        }
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

static int down_ensure(Res *r);

static void writeback(Res *r)
{
    uint8_t *mem = (uint8_t *)xbox_GetMemoryOffset();
    D3D11_MAPPED_SUBRESOURCE m;
    uint32_t y, x;
    ID3D11Resource *src = r->res;
    if (s_active) {
        /* MSAA resolved; a scaled target box-filtered down to the size the
         * guest reads it at. */
        resolve(r);
        if (r->sw != r->w || r->sh != r->h) {
            if (!down_ensure(r)) return;
            blit(r->srv, r->sw, r->sh, r->downrtv, 0, 0, (float)r->w, (float)r->h);
            src = (ID3D11Resource *)r->down;
        }
    }
    if (!r->staging) {
        D3D11_TEXTURE2D_DESC td;
        ID3D11Texture2D_GetDesc((ID3D11Texture2D *)src, &td);
        td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, &r->staging))) return;
    }
    ID3D11DeviceContext_CopyResource(s_ctx, (ID3D11Resource *)r->staging, src);
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
    if (s_active) return;            /* check mode only, where the options are off */
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

/* ---- display options: scaling, MSAA, presenting -------------------------- */

static ID3D11VertexShader *s_blit_vs;
static ID3D11PixelShader *s_blit_ps;
static ID3D11Buffer *s_cb_blit;
static ID3D11SamplerState *s_smp_lin;
static SRWLOCK s_lock = SRWLOCK_INIT;   /* consume (flip thread) vs pixels() (window thread) */
static float s_want_sx = 1.0f, s_want_sy = 1.0f;   /* "window": the scale the next frame uses */

/* Scale `srcw x srch` into the rectangle x,y,w,h of dst: bilinear when
 * enlarging, the average of every source texel a destination pixel covers
 * when reducing (an exact box filter at whole ratios: taps at texel centres). */
static const char s_blit_hlsl[] =
"cbuffer B : register(b0) { float2 ratio; float2 srcsize; float2 origin; float2 pad; };\n"
"Texture2D t : register(t0); SamplerState s : register(s0);\n"
"float4 vs(uint i : SV_VertexID) : SV_Position { float2 q = float2((i << 1) & 2, i & 2);\n"
"  return float4(q * float2(2, -2) + float2(-1, 1), 0, 1); }\n"
"float4 ps(float4 p : SV_Position) : SV_Target {\n"
"  float2 d = p.xy - origin;\n"
"  if (ratio.x <= 1.0 && ratio.y <= 1.0) return t.SampleLevel(s, d * ratio / srcsize, 0);\n"
"  int nx = max((int)ceil(ratio.x - 0.001), 1), ny = max((int)ceil(ratio.y - 0.001), 1);\n"
"  float2 p0 = floor(d) * ratio, st = ratio / float2(nx, ny);\n"
"  float4 c = 0;\n"
"  for (int y = 0; y < ny; y++) for (int x = 0; x < nx; x++)\n"
"    c += t.SampleLevel(s, (p0 + (float2(x, y) + 0.5) * st) / srcsize, 0);\n"
"  return c / (float)(nx * ny); }\n";

static int display_init(void)
{
    const GpDisplay *g = gp_display();
    ID3DBlob *b;
    D3D11_SAMPLER_DESC sd;
    if (!g->active) return 1;
    s_active = 1;
    gp_display_scale_for(0, 0, &s_sx, &s_sy);         /* fixed; "window" starts at 1 */
    s_want_sx = s_sx; s_want_sy = s_sy;
    for (s_msaa = g->msaa; s_msaa > 1; s_msaa /= 2) {
        UINT qc = 0, qd = 0;
        ID3D11Device_CheckMultisampleQualityLevels(s_dev, DXGI_FORMAT_B8G8R8A8_UNORM, (UINT)s_msaa, &qc);
        ID3D11Device_CheckMultisampleQualityLevels(s_dev, DXGI_FORMAT_D32_FLOAT_S8X24_UINT, (UINT)s_msaa, &qd);
        if (qc && qd) break;
    }
    if (!(b = compile(s_blit_hlsl, sizeof s_blit_hlsl - 1, "vs", "vs_5_0", 3))) return 0;
    ID3D11Device_CreateVertexShader(s_dev, ID3D10Blob_GetBufferPointer(b), ID3D10Blob_GetBufferSize(b), NULL, &s_blit_vs);
    ID3D10Blob_Release(b);
    if (!(b = compile(s_blit_hlsl, sizeof s_blit_hlsl - 1, "ps", "ps_5_0", 3))) return 0;
    ID3D11Device_CreatePixelShader(s_dev, ID3D10Blob_GetBufferPointer(b), ID3D10Blob_GetBufferSize(b), NULL, &s_blit_ps);
    ID3D10Blob_Release(b);
    if (!make_buffer(32, D3D11_BIND_CONSTANT_BUFFER, &s_cb_blit)) return 0;
    memset(&sd, 0, sizeof sd);
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    ID3D11Device_CreateSamplerState(s_dev, &sd, &s_smp_lin);
    fprintf(stderr, "  [GPU11] display: scale %.3f x %.3f%s, MSAA %dx\n", s_sx, s_sy,
            g->window ? " (follows the window)" : "", s_msaa);
    return s_blit_vs && s_blit_ps && s_smp_lin;
}

static void blit(ID3D11ShaderResourceView *src, uint32_t srcw, uint32_t srch,
                 ID3D11RenderTargetView *dst, float x, float y, float w, float h)
{
    float cb[8];
    D3D11_VIEWPORT vp;
    ID3D11ShaderResourceView *none = NULL;
    cb[0] = (float)srcw / w; cb[1] = (float)srch / h; cb[2] = (float)srcw; cb[3] = (float)srch;
    cb[4] = x; cb[5] = y; cb[6] = cb[7] = 0;
    upload_cb(s_cb_blit, cb, sizeof cb);
    vp.TopLeftX = x; vp.TopLeftY = y; vp.Width = w; vp.Height = h; vp.MinDepth = 0; vp.MaxDepth = 1;
    ID3D11DeviceContext_PSSetShaderResources(s_ctx, 0, 1, &none);
    ID3D11DeviceContext_OMSetRenderTargets(s_ctx, 1, &dst, NULL);
    ID3D11DeviceContext_RSSetViewports(s_ctx, 1, &vp);
    ID3D11DeviceContext_RSSetState(s_ctx, s_rs);
    {   /* s_rs scissors (GpDraw.rect): the blit's own rectangle */
        D3D11_RECT sc;
        sc.left = (LONG)x; sc.top = (LONG)y; sc.right = (LONG)(x + w + 0.5f); sc.bottom = (LONG)(y + h + 0.5f);
        ID3D11DeviceContext_RSSetScissorRects(s_ctx, 1, &sc);
    }
    ID3D11DeviceContext_OMSetBlendState(s_ctx, NULL, NULL, 0xFFFFFFFF);
    ID3D11DeviceContext_OMSetDepthStencilState(s_ctx, NULL, 0);
    ID3D11DeviceContext_IASetInputLayout(s_ctx, NULL);
    ID3D11DeviceContext_IASetPrimitiveTopology(s_ctx, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ID3D11DeviceContext_VSSetShader(s_ctx, s_blit_vs, NULL, 0);
    ID3D11DeviceContext_PSSetShader(s_ctx, s_blit_ps, NULL, 0);
    ID3D11DeviceContext_PSSetConstantBuffers(s_ctx, 0, 1, &s_cb_blit);
    ID3D11DeviceContext_PSSetShaderResources(s_ctx, 0, 1, &src);
    ID3D11DeviceContext_PSSetSamplers(s_ctx, 0, 1, &s_smp_lin);
    ID3D11DeviceContext_Draw(s_ctx, 3, 0);
    ID3D11DeviceContext_PSSetShaderResources(s_ctx, 0, 1, &none);
    s_cur_target = s_cur_zeta = 0;            /* the next draw binds its target again */
    s_bound.valid = 0;                        /* and the rest of its state */
}

static void resolve(Res *r)
{
    if (r->ms && r->msdirty) {
        ID3D11DeviceContext_ResolveSubresource(s_ctx, r->res, 0, (ID3D11Resource *)r->ms, 0,
                                               DXGI_FORMAT_B8G8R8A8_UNORM);
        r->msdirty = 0;
    }
}

/* A render target at the current scale: res (sampled, copied, written back,
 * presented) and, with MSAA, the multisampled texture draws go into. */
static int rt_make(Res *r)
{
    D3D11_TEXTURE2D_DESC td;
    memset(&td, 0, sizeof td);
    r->sw = gp_scaled(r->w, s_sx); r->sh = gp_scaled(r->h, s_sy);
    td.Width = r->sw; td.Height = r->sh; td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, (ID3D11Texture2D **)&r->res)))
        return 0;
    ID3D11Device_CreateRenderTargetView(s_dev, r->res, NULL, &r->rtv);
    ID3D11Device_CreateShaderResourceView(s_dev, r->res, NULL, &r->srv);
    if (s_msaa > 1) {
        td.SampleDesc.Count = (UINT)s_msaa;
        td.BindFlags = D3D11_BIND_RENDER_TARGET;
        if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, &r->ms)))
            return 0;
        ID3D11Device_CreateRenderTargetView(s_dev, (ID3D11Resource *)r->ms, NULL, &r->msrtv);
    }
    return r->rtv && r->srv && (s_msaa == 1 || r->msrtv);
}

static int down_ensure(Res *r)
{
    D3D11_TEXTURE2D_DESC td;
    if (r->down) return 1;
    memset(&td, 0, sizeof td);
    td.Width = r->w; td.Height = r->h; td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM; td.SampleDesc.Count = 1;
    td.BindFlags = D3D11_BIND_RENDER_TARGET;
    if (FAILED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, &r->down))) return 0;
    if (FAILED(ID3D11Device_CreateRenderTargetView(s_dev, (ID3D11Resource *)r->down, NULL, &r->downrtv))) return 0;
    return 1;
}

/* "window": the window's picture changed size. Every target is remade at
 * the new scale with its picture scaled across (the title samples some of
 * them frames later: impostors, the TV); depth buffers and tiles are remade
 * (depth is cleared by the next frame; tiles are copied before each use). */
static void rescale(float sx, float sy)
{
    uint32_t i;
    float ox = s_sx, oy = s_sy;
    s_sx = sx; s_sy = sy;
    for (i = 0; i < s_nres; i++) {
        Res *r = &s_res[i];
        if (r->kind == R_RT) {
            Res old;
            resolve(r);
            old = *r;
            r->res = NULL; r->rtv = NULL; r->srv = NULL; r->ms = NULL; r->msrtv = NULL; r->msdirty = 0;
            if (!rt_make(r)) {
                if (r->srv) ID3D11ShaderResourceView_Release(r->srv);
                if (r->rtv) ID3D11RenderTargetView_Release(r->rtv);
                if (r->res) ID3D11Resource_Release(r->res);
                r->srv = NULL; r->rtv = NULL; r->res = NULL;
                r->kind = R_NONE;
            } else {
                blit(old.srv, old.sw, old.sh, draw_rtv(r), 0, 0, (float)r->sw, (float)r->sh);
                if (r->ms) r->msdirty = 1;
            }
            if (old.srv) ID3D11ShaderResourceView_Release(old.srv);
            if (old.rtv) ID3D11RenderTargetView_Release(old.rtv);
            if (old.msrtv) ID3D11RenderTargetView_Release(old.msrtv);
            if (old.ms) ID3D11Texture2D_Release(old.ms);
            if (old.res) ID3D11Resource_Release(old.res);
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
    fprintf(stderr, "  [GPU11] display: scale %.3f x %.3f -> %.3f x %.3f\n", ox, oy, sx, sy);
}

/* ---- the window's presenter (fb_presenter.h, via gpu_display.c) ---------- */

static IDXGISwapChain1 *s_sc;
static ID3D11RenderTargetView *s_sc_rtv;
static UINT s_sc_w, s_sc_h;
static int s_sc_failed;
static ID3D11Texture2D *s_px_tex;
static ID3D11ShaderResourceView *s_px_srv;
static uint32_t s_px_w, s_px_h;

/* The swap chain on the window, at its client size; 0 when there is none
 * or the window is minimised. */
static int sc_ready(HWND h)
{
    RECT rc;
    UINT cw, ch;
    if (s_sc_failed || !GetClientRect(h, &rc)) return 0;
    cw = (UINT)(rc.right - rc.left); ch = (UINT)(rc.bottom - rc.top);
    if (!cw || !ch) return 0;
    if (!s_sc) {
        IDXGIDevice *dd = NULL;
        IDXGIAdapter *ad = NULL;
        IDXGIFactory2 *f2 = NULL;
        DXGI_SWAP_CHAIN_DESC1 d;
        HRESULT hr = E_FAIL;
        memset(&d, 0, sizeof d);
        d.Width = cw; d.Height = ch; d.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        d.SampleDesc.Count = 1; d.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        d.BufferCount = 2; d.Scaling = DXGI_SCALING_STRETCH;
        d.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD; d.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
        if (SUCCEEDED(ID3D11Device_QueryInterface(s_dev, &IID_IDXGIDevice, (void **)&dd))
            && SUCCEEDED(IDXGIDevice_GetAdapter(dd, &ad))
            && SUCCEEDED(IDXGIAdapter_GetParent(ad, &IID_IDXGIFactory2, (void **)&f2)))
            hr = IDXGIFactory2_CreateSwapChainForHwnd(f2, (IUnknown *)s_dev, h, &d, NULL, NULL, &s_sc);
        if (SUCCEEDED(hr)) IDXGIFactory2_MakeWindowAssociation(f2, h, DXGI_MWA_NO_ALT_ENTER);
        if (f2) IDXGIFactory2_Release(f2);
        if (ad) IDXGIAdapter_Release(ad);
        if (dd) IDXGIDevice_Release(dd);
        if (FAILED(hr)) {
            fprintf(stderr, "  [GPU11] window swap chain failed 0x%08lX: the window shows the"
                            " guest-size frame\n", (unsigned long)hr);
            s_sc_failed = 1;
            return 0;
        }
        s_sc_w = cw; s_sc_h = ch;
        fprintf(stderr, "  [GPU11] presenting the full-size image to the window (%ux%u)\n", cw, ch);
    }
    if (cw != s_sc_w || ch != s_sc_h) {
        if (s_sc_rtv) { ID3D11RenderTargetView_Release(s_sc_rtv); s_sc_rtv = NULL; }
        ID3D11DeviceContext_OMSetRenderTargets(s_ctx, 0, NULL, NULL);
        s_cur_target = s_cur_zeta = 0;
        if (FAILED(IDXGISwapChain1_ResizeBuffers(s_sc, 0, cw, ch, DXGI_FORMAT_UNKNOWN, 0))) return 0;
        s_sc_w = cw; s_sc_h = ch;
    }
    if (!s_sc_rtv) {
        ID3D11Texture2D *back = NULL;
        if (FAILED(IDXGISwapChain1_GetBuffer(s_sc, 0, &IID_ID3D11Texture2D, (void **)&back))) return 0;
        ID3D11Device_CreateRenderTargetView(s_dev, (ID3D11Resource *)back, NULL, &s_sc_rtv);
        ID3D11Texture2D_Release(back);
    }
    return s_sc_rtv != NULL;
}

/* src letterboxed to aw:ah on black, then shown (no vsync wait: the game's
 * flip pacing is the clock, and DWM shows the newest frame). */
static void sc_show(ID3D11ShaderResourceView *src, uint32_t sw, uint32_t sh, uint32_t aw, uint32_t ah)
{
    static const float black[4] = { 0, 0, 0, 1 };
    float w = (float)s_sc_w, h = w * (float)ah / (float)aw;
    if (h > (float)s_sc_h) { h = (float)s_sc_h; w = h * (float)aw / (float)ah; }
    w = (float)(int)(w + 0.5f); h = (float)(int)(h + 0.5f);
    ID3D11DeviceContext_ClearRenderTargetView(s_ctx, s_sc_rtv, black);
    blit(src, sw, sh, s_sc_rtv, (float)(int)((s_sc_w - w) / 2), (float)(int)((s_sc_h - h) / 2), w, h);
    IDXGISwapChain1_Present(s_sc, 0, 0);
}

int gp_d3d11_present_frame(void *hwnd, uint32_t fb_va, uint32_t aw, uint32_t ah)
{
    Res *best = NULL;
    int j, shown = 0;
    if (!s_active || !s_dev || s_failed) return 0;   /* s_failed until ensure_device is done */
    AcquireSRWLockExclusive(&s_lock);
    for (j = 0; j < s_nrt_ids; j++) {
        Res *r = res(s_rt_ids[j]);
        if (r && r->kind == R_RT && ((r->va ^ fb_va) & 0x03FFFFFFu) == 0 && (!best || !r->swz)) best = r;
    }
    if (best) {
        resolve(best);
        if (gp_display_dump_due()) {
            /* RECOMP_HIRES_DUMP: the full-size image, as presented. */
            D3D11_TEXTURE2D_DESC td;
            ID3D11Texture2D *st = NULL;
            D3D11_MAPPED_SUBRESOURCE m;
            ID3D11Texture2D_GetDesc((ID3D11Texture2D *)best->res, &td);
            td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            if (SUCCEEDED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, &st))) {
                ID3D11DeviceContext_CopyResource(s_ctx, (ID3D11Resource *)st, best->res);
                if (SUCCEEDED(ID3D11DeviceContext_Map(s_ctx, (ID3D11Resource *)st, 0, D3D11_MAP_READ, 0, &m))) {
                    gp_display_dump_bgra((const uint8_t *)m.pData, m.RowPitch, td.Width, td.Height);
                    ID3D11DeviceContext_Unmap(s_ctx, (ID3D11Resource *)st, 0);
                }
                ID3D11Texture2D_Release(st);
            }
        }
        if (sc_ready((HWND)hwnd)) {
            sc_show(best->srv, best->sw, best->sh, aw, ah);
            if (gp_display()->window) {
                /* The scale the window's picture asks for, taken once it has
                 * held for 20 frames (a drag-resize does not rebuild every
                 * target on each step). */
                static float px = -1, py = -1;
                static int same;
                float sx, sy;
                gp_display_scale_for(s_sc_w, s_sc_h, &sx, &sy);
                if (sx != px || sy != py) { px = sx; py = sy; same = 0; }
                else if (++same == 20 && (sx != s_sx || sy != s_sy)) { s_want_sx = sx; s_want_sy = sy; }
            }
        }
        shown = 1;     /* minimised: nothing to show, but nothing else should either */
    }
    ReleaseSRWLockExclusive(&s_lock);
    return shown;
}

int gp_d3d11_present_pixels(void *hwnd, const uint32_t *px, uint32_t w, uint32_t h,
                            uint32_t aw, uint32_t ah)
{
    int ok = 0;
    if (!s_active || !px || !s_dev || s_failed) return 0;   /* the window thread can get here while the flip thread is still in ensure_device */
    /* Never wait for the lock here: the flip thread can hold it while DXGI
     * (swap chain creation, resize) sends this thread's window a message,
     * and waiting would deadlock the two. A skipped tick is redrawn 16 ms on. */
    if (!TryAcquireSRWLockExclusive(&s_lock)) return 0;
    if (sc_ready((HWND)hwnd)) {
        if (!s_px_tex || s_px_w != w || s_px_h != h) {
            D3D11_TEXTURE2D_DESC td;
            if (s_px_srv) { ID3D11ShaderResourceView_Release(s_px_srv); s_px_srv = NULL; }
            if (s_px_tex) { ID3D11Texture2D_Release(s_px_tex); s_px_tex = NULL; }
            memset(&td, 0, sizeof td);
            td.Width = w; td.Height = h; td.MipLevels = 1; td.ArraySize = 1;
            td.Format = DXGI_FORMAT_B8G8R8A8_UNORM; td.SampleDesc.Count = 1;
            td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
            if (SUCCEEDED(ID3D11Device_CreateTexture2D(s_dev, &td, NULL, &s_px_tex)))
                ID3D11Device_CreateShaderResourceView(s_dev, (ID3D11Resource *)s_px_tex, NULL, &s_px_srv);
            s_px_w = w; s_px_h = h;
        }
        if (s_px_srv) {
            ID3D11DeviceContext_UpdateSubresource(s_ctx, (ID3D11Resource *)s_px_tex, 0, NULL, px, w * 4, 0);
            sc_show(s_px_srv, w, h, aw, ah);
            ok = 1;
        }
    }
    ReleaseSRWLockExclusive(&s_lock);
    return ok;
}

static void consume_draws(const GpFrame *f, int sync)
{
    uint32_t i;
    double t_draw;
    s_cur_target = s_cur_zeta = 0;
    s_seq++;
    s_bound.valid = 0;                     /* the window thread may have bound its blit */
    s_last_vsc = s_last_xfc = s_last_psc = ~0u;   /* offsets are per frame (and per sync) */
    if (s_active && (s_want_sx != s_sx || s_want_sy != s_sy))
        rescale(s_want_sx, s_want_sy);
    drain_queue(f);
    /* The frame's vertices and indices in one Map each. */
    s_frame_voff = f->vtx_bytes ? ring_put(s_vb, s_vb_bytes, &s_vb_pos, f->vtx, f->vtx_bytes) : ~0u;
    s_frame_ioff = f->idx_count ? ring_put(s_ib, s_ib_bytes, &s_ib_pos, f->idx, f->idx_count * 4) : ~0u;
    t_draw = gp_now_ms();
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
    gp_time_add(GP_T_CON_DRAW, gp_now_ms() - t_draw, 0);
}

void gp_d3d11_sync(const GpFrame *f)
{
    if (!ensure_device()) return;
    AcquireSRWLockExclusive(&s_lock);
    s_checking = 1;
    consume_draws(f, 1);
    s_checking = 0;
    ReleaseSRWLockExclusive(&s_lock);
}

/* Every swizzled target into guest memory, once at the start of a checked
 * frame: textures the CPU reference samples from targets drawn in earlier
 * frames (shadow maps, impostors) are otherwise whatever memory last held. */
void gp_d3d11_writeback_swizzled(void)
{
    int j;
    if (!s_dev) return;
    for (j = 0; j < s_nrt_ids; j++) {
        Res *r = res(s_rt_ids[j]);
        if (r && r->kind == R_RT && r->swz) writeback_swz(r);
    }
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
    {   /* the layout's form: the inputs the program reads, packed */
        static float pk[GP_PROBE_MAX * 16][4];
        uint32_t i, a, k = 0;
        for (i = 0; i < n; i++)
            for (a = 0; a < 16; a++)
                if (r->mask & (1u << a)) memcpy(pk[k++], in[i].v[a], 16);
        vstride = (k / n) * 16;
        voff = ring_put(s_vb, s_vb_bytes, &s_vb_pos, pk, k * 16);
    }
    if (voff == ~0u) return 0;
    upload_cb(s_cb_xf, xc, sizeof *xc);
    upload_cb(s_cb_vs, vc, sizeof *vc);
    s_last_vsc = s_last_xfc = ~0u;               /* the cbuffers no longer hold a draw's */
    s_bound.valid = 0;
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
    AcquireSRWLockExclusive(&s_lock);
    consume_draws(f, 0);
    ReleaseSRWLockExclusive(&s_lock);
    if (f->frame % 300 == 299) {
        fprintf(stderr, "  [GPU11] frames %u: %llu draws, %llu tris, %llu clears, %llu skipped;"
                " %u textures and %u shaders created\n", f->frame + 1,
                (unsigned long long)s_st.draws, (unsigned long long)s_st.tris,
                (unsigned long long)s_st.clears, (unsigned long long)s_st.skipped,
                s_stat_tex, s_stat_shaders);
        if (s_stat_shaders)
            fprintf(stderr, "  [GPU11] shaders: %u compiled early, %u from the disk cache, %u compiled at"
                    " the flip (%.1f ms), %u waited for (%.1f ms)\n", s_sh_st.early, s_sh_st.disk,
                    s_sh_st.compiled, s_sh_st.compile_ms, s_sh_st.waited, s_sh_st.wait_ms);
        memset(&s_sh_st, 0, sizeof s_sh_st);
        memset(&s_st, 0, sizeof s_st);
        s_stat_tex = s_stat_shaders = 0;
    }
}
