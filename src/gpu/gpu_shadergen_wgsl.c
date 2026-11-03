/*
 * NV2A vertex programs and register combiners -> WGSL.
 *
 * The WGSL twin of gpu_shadergen.c (which emits HLSL for the D3D11 back end).
 * It walks the same microcode fields and combiner words in the same order and
 * emits the same expression for each rule, so both mirror the CPU references
 * (xboxrecomp nv2a_vsh_interp.c, nv2a_combiner.c, nv2a_pb_exec.c) and a
 * difference between the WebGPU and D3D11 pictures is a translation bug in
 * one of the two files. When gpu_shadergen.c changes a rule, change it here.
 *
 * What WGSL forces on the translation (nfsu2-web's vsemu_wgsl.inc found the
 * same things):
 *   - no multi-component swizzle assignment: masked writes are expanded per
 *     component, .rgb writes rebuild the vec4;
 *   - no scalar/vector mixing in max/clamp/select: typed zero and bounds;
 *   - a constant expression that overflows (1.0 / 0.0, an infinity literal)
 *     is a shader-creation error, so +-inf comes from a runtime bitcast;
 *   - no isnan(): a bit test;
 *   - textures have mip levels: combiner fetches are textureSampleBias with
 *     the stage's LOD bias from GpWgslSmp (D3D11 puts it in the sampler,
 *     WebGPU samplers have none); a sampler with lodMaxClamp 0 keeps the
 *     level-0-only cases. WGSL's discard demotes to a helper invocation, so
 *     the fetches after the clip discards stay in uniform control flow;
 *   - no BORDER address mode: emulated from a small per-draw uniform;
 *   - no SV_ClipDistance in core: see GP_WGSL_CLIPDIST in the header.
 */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "gpu_shadergen_wgsl.h"

typedef struct { char *p; size_t n, cap; int overflow; } Sb;

static void emit(Sb *b, const char *fmt, ...)
{
    va_list ap;
    int k;
    if (b->overflow) return;
    va_start(ap, fmt);
    k = vsnprintf(b->p + b->n, b->cap - b->n, fmt, ap);
    va_end(ap);
    if (k < 0 || (size_t)k >= b->cap - b->n) { b->overflow = 1; return; }
    b->n += (size_t)k;
}

/* ---- shared declarations ------------------------------------------------- */

/* binding 0 for the vertex programs and the pass-through; GpXfConsts. */
static const char k_xf_decl[] =
    "struct XfC {\n"
    "  surf: vec2f, zscale: f32, near_z: f32,\n"
    "  aa: vec2f, fog_on: f32, fog_mode: f32,\n"
    "  fog_p0: f32, fog_p1: f32, pad0: vec2f,\n"
    "  uvscale: array<vec4f, 4>,\n"
    "};\n"
    "@group(0) @binding(0) var<uniform> X: XfC;\n";

/* The interstage block. Locations 0..7 are what the PS reads. */
static const char k_vo_head[] =
    "struct VO {\n"
    "  @builtin(position) pos: vec4f,\n"
    "  @location(0) d0: vec4f, @location(1) d1: vec4f,\n"
    "  @location(2) t0: vec4f, @location(3) t1: vec4f,\n"
    "  @location(4) t2: vec4f, @location(5) t3: vec4f,\n"
    "  @location(6) fog: f32, @location(7) clip: vec2f,\n";

static const char k_xf_funcs[] =
    "fn is_nan(f: f32) -> bool { return (bitcast<u32>(f) & 0x7fffffffu) > 0x7f800000u; }\n"
    /* fog_factor() in nv2a_pb_exec.c. Modes: 0x800 EXP, 0x801 EXP2,
     * 0x802/0x803 their ABS forms, 0x804 LINEAR_ABS, else LINEAR. */
    "fn fog_factor(d: f32) -> f32 {\n"
    "  if (X.fog_on < 0.5) { return 1.0; }\n"
    "  var f: f32; let m = i32(X.fog_mode);\n"
    "  if (m == 0x800 || m == 0x802) { f = X.fog_p0 + exp2(d * X.fog_p1 * 16.0) - 1.5; }\n"
    "  else if (m == 0x801 || m == 0x803) { f = X.fog_p0 + exp2(-d * d * X.fog_p1 * X.fog_p1 * 32.0) - 1.5; }\n"
    "  else { f = X.fog_p0 + d * X.fog_p1 - 1.0; }\n"
    "  if (m == 0x802 || m == 0x803 || m == 0x804) { f = abs(f); }\n"
    "  if (is_nan(f)) { f = 1.0; }\n"
    "  return saturate(f);\n"
    "}\n"
    /* Screen space (pixels, z in depth units, clip-space w) to clip space;
     * WebGPU's NDC and viewport match D3D's. See finish() in the HLSL. */
    "fn finish(p: vec4f, d0: vec4f, d1: vec4f, fogd: f32, t0: vec4f, t1: vec4f,\n"
    "          t2: vec4f, t3: vec4f, clip_near: bool) -> VO {\n"
    "  var o: VO;\n"
    "  let w = p.w;\n"
    "  o.pos = vec4f((p.x / X.surf.x * 2.0 - 1.0) * w, (1.0 - p.y / X.surf.y * 2.0) * w,\n"
    "                saturate(p.z * X.zscale) * w, w);\n"
    "  o.d0 = d0; o.d1 = d1; o.fog = fog_factor(fogd);\n"
    "  o.t0 = vec4f(t0.xy * X.uvscale[0].xy, t0.zw);\n"
    "  o.t1 = vec4f(t1.xy * X.uvscale[1].xy, t1.zw);\n"
    "  o.t2 = vec4f(t2.xy * X.uvscale[2].xy, t2.zw);\n"
    "  o.t3 = vec4f(t3.xy * X.uvscale[3].xy, t3.zw);\n"
    /* The CPU clips at w = 1e-3 and then at the near plane z = near_z. */
    "  var clip = vec2f(1.0, 1.0);\n"
    "  if (clip_near) { clip = vec2f(w - 1e-3, (p.z - X.near_z) * w); }\n";

static void emit_xf_common(Sb *b, uint32_t flags)
{
    if (flags & GP_WGSL_CLIPDIST) emit(b, "enable clip_distances;\n");
    emit(b, "%s%s", k_xf_decl, k_vo_head);
    if (flags & GP_WGSL_CLIPDIST) emit(b, "  @builtin(clip_distances) cd: array<f32, 2>,\n");
    emit(b, "};\n%s", k_xf_funcs);
    if (flags & GP_WGSL_CLIPDIST)
        emit(b, "  o.cd = array<f32, 2>(clip.x, clip.y); o.clip = vec2f(1.0, 1.0);\n");
    else
        emit(b, "  o.clip = clip;\n");
    emit(b, "  return o;\n}\n");
}

/* ---- vertex programs ----------------------------------------------------- */

static uint32_t field(const uint32_t *ins, int dw, int lo, int width)
{
    return (ins[dw] >> lo) & ((1u << width) - 1u);
}

static char comp(uint32_t c) { return "xyzw"[c & 3]; }

/* read_src(): one operand as a WGSL let named `name`. */
static void vsh_src(Sb *b, const uint32_t *ins, int which, const char *name)
{
    uint32_t neg, swz, mux, reg;
    char base[64];

    if (which == 0) {
        neg = field(ins, 1, 8, 1); swz = field(ins, 1, 0, 8);
        mux = field(ins, 2, 26, 2); reg = field(ins, 2, 28, 4);
    } else if (which == 1) {
        neg = field(ins, 2, 25, 1); swz = field(ins, 2, 17, 8);
        mux = field(ins, 2, 11, 2); reg = field(ins, 2, 13, 4);
    } else {
        neg = field(ins, 2, 10, 1); swz = field(ins, 2, 2, 8);
        mux = field(ins, 3, 28, 2);
        reg = (field(ins, 2, 0, 2) << 2) | field(ins, 3, 30, 2);
    }
    base[0] = 0;
    if (mux == 1)
        snprintf(base, sizeof base, "%s", reg == 12 ? "opos" : (reg < 12 ? "" : "R[0]"));
    if (mux == 1 && reg < 12)
        snprintf(base, sizeof base, "R[%u]", reg);
    else if (mux == 2)
        snprintf(base, sizeof base, "v[%u]", field(ins, 1, 9, 4));
    else if (mux != 1) {
        int ci = (int)field(ins, 1, 13, 8);
        if (field(ins, 3, 1, 1))
            snprintf(base, sizeof base, "K.c[cidx(%d + a0)]", ci);
        else
            snprintf(base, sizeof base, "K.c[%d]", (ci < 0 || ci >= 192) ? 0 : ci);
    }
    emit(b, "    let %s = %s%s.%c%c%c%c;\n", name, neg ? "-" : "", base,
         comp(swz >> 6), comp(swz >> 4), comp(swz >> 2), comp(swz));
}

/* A masked write, one component at a time (x = bit 3 ... w = bit 0). */
static void vsh_write(Sb *b, const char *dst, uint32_t mask, const char *src)
{
    int i;
    for (i = 0; i < 4; i++)
        if (mask & (8u >> i))
            emit(b, "    %s.%c = %s.%c;\n", dst, "xyzw"[i], src, "xyzw"[i]);
}

int gpu_gen_vs_program_wgsl(const uint32_t (*prog)[4], uint32_t len, uint32_t flags,
                            char *out, size_t cap)
{
    Sb b = { out, 0, cap, 0 };
    uint32_t s;
    int k;

    emit_xf_common(&b, flags);
    emit(&b, "struct VsC { c: array<vec4f, 192> };\n"
             "@group(0) @binding(1) var<uniform> K: VsC;\n"
             "struct VI {\n");
    for (k = 0; k < 16; k++)
        emit(&b, "  @location(%d) v%d: vec4f,\n", k, k);
    emit(&b, "};\n"
             "fn cidx(i: i32) -> i32 { return select(i, 0, i < 0 || i >= 192); }\n"
             /* Runtime, not constant: an infinite constant expression is an error. */
             "fn inf_of(neg: bool) -> f32 { var u = 0x7f800000u; if (neg) { u = 0xff800000u; } return bitcast<f32>(u); }\n"
             "@vertex fn main(vin: VI) -> VO {\n"
             "  let v = array<vec4f, 16>(vin.v0, vin.v1, vin.v2, vin.v3, vin.v4, vin.v5, vin.v6, vin.v7,\n"
             "                           vin.v8, vin.v9, vin.v10, vin.v11, vin.v12, vin.v13, vin.v14, vin.v15);\n"
             "  var R: array<vec4f, 12>;\n"
             "  var opos = vec4f(0.0); var a0: i32 = 0;\n"
             "  var o: array<vec4f, 13>;\n"
             "  o[3].w = 1.0; o[4].w = 1.0;\n"
             "  o[9].w = 1.0; o[10].w = 1.0; o[11].w = 1.0; o[12].w = 1.0;\n");

    for (s = 0; s < len; s++) {
        const uint32_t *ins = prog[s];
        uint32_t mac = field(ins, 1, 21, 4), ilu = field(ins, 1, 25, 3);
        uint32_t mac_mask = field(ins, 3, 24, 4), ilu_mask = field(ins, 3, 16, 4);
        uint32_t tdst = field(ins, 3, 20, 4);
        uint32_t omask = field(ins, 3, 12, 4), oaddr = field(ins, 3, 3, 8);
        char d[16];

        emit(&b, "  { // slot %u\n", s);
        vsh_src(&b, ins, 0, "A");
        vsh_src(&b, ins, 1, "B");
        vsh_src(&b, ins, 2, "C");
        emit(&b, "    var M = vec4f(0.0); var I = vec4f(0.0);\n");
        switch (mac) {                            /* run_mac */
        case 0:  break;
        case 1:  emit(&b, "    M = A;\n"); break;
        case 2:  emit(&b, "    M = A * B;\n"); break;
        case 3:  emit(&b, "    M = A + C;\n"); break;
        case 4:  emit(&b, "    M = A * B + C;\n"); break;
        case 5:  emit(&b, "    M = vec4f(dot(A.xyz, B.xyz));\n"); break;
        case 6:  emit(&b, "    M = vec4f(dot(A.xyz, B.xyz) + B.w);\n"); break;
        case 7:  emit(&b, "    M = vec4f(dot(A, B));\n"); break;
        case 8:  emit(&b, "    M = vec4f(1.0, A.y * B.y, A.z, B.w);\n"); break;
        case 9:  emit(&b, "    M = select(B, A, A < B);\n"); break;
        case 10: emit(&b, "    M = select(B, A, A >= B);\n"); break;
        case 11: emit(&b, "    M = select(vec4f(0.0), vec4f(1.0), A < B);\n"); break;
        case 12: emit(&b, "    M = select(vec4f(0.0), vec4f(1.0), A >= B);\n"); break;
        case 13: emit(&b, "    M = A; a0 = i32(floor(A.x + 0.001));\n"); break;
        default: emit(&b, "    M = A;\n"); break;
        }
        switch (ilu) {                            /* run_ilu */
        case 0:  break;
        case 1:  emit(&b, "    I = C;\n"); break;
        case 2:  emit(&b, "    I = vec4f(select(1.0 / C.x, inf_of(false), C.x == 0.0));\n"); break;
        case 3:  emit(&b, "    { var f = 1.0 / C.x;\n"
                          "      if (abs(f) < 5.42101e-20) { f = select(5.42101e-20, -5.42101e-20, f < 0.0); }\n"
                          "      if (abs(f) > 1.884467e19) { f = select(1.884467e19, -1.884467e19, f < 0.0); }\n"
                          "      I = vec4f(f); }\n"); break;
        case 4:  emit(&b, "    I = vec4f(1.0 / sqrt(abs(C.x)));\n"); break;
        case 5:  emit(&b, "    { let fl = floor(C.x);"
                          " I = vec4f(exp2(fl), C.x - fl, exp2(C.x), 1.0); }\n"); break;
        case 6:  emit(&b, "    { let ax = abs(C.x);\n"
                          "      if (ax == 0.0) { I = vec4f(inf_of(true), 1.0, inf_of(true), 1.0); }\n"
                          "      else { let e = floor(log2(ax)); I = vec4f(e, ax / exp2(e), log2(ax), 1.0); } }\n");
                 break;
        case 7:  emit(&b, "    { let nl = select(0.0, C.x, C.x > 0.0); let nh = select(0.0, C.y, C.y > 0.0);\n"
                          "      let p = clamp(C.w, -127.9961, 127.9961);\n"
                          "      I = vec4f(1.0, nl, select(0.0, pow(nh, p), C.x > 0.0), 1.0); }\n"); break;
        default: emit(&b, "    I = C;\n"); break;
        }
        if (mac && mac != 13 && mac_mask) {
            if (tdst == 12) vsh_write(&b, "opos", mac_mask, "M");
            else if (tdst < 12) { snprintf(d, sizeof d, "R[%u]", tdst); vsh_write(&b, d, mac_mask, "M"); }
        }
        if (ilu && ilu_mask) {
            /* Paired with any MAC op the ILU writes R1 (see nv2a_vsh_run). */
            uint32_t it = mac ? 1u : tdst;
            if (it == 12) vsh_write(&b, "opos", ilu_mask, "I");
            else if (it < 12) { snprintf(d, sizeof d, "R[%u]", it); vsh_write(&b, d, ilu_mask, "I"); }
        }
        if (omask && field(ins, 3, 11, 1)) {      /* writes to c[] are refused upstream */
            const char *src = field(ins, 3, 2, 1) ? "I" : "M";
            if (oaddr == 0) vsh_write(&b, "opos", omask, src);
            else if (oaddr < 13) { snprintf(d, sizeof d, "o[%u]", oaddr); vsh_write(&b, d, omask, src); }
        }
        emit(&b, "  }\n");
        if (field(ins, 3, 0, 1))
            break;
    }
    emit(&b,
        "  var p = opos;\n"
        /* oPos.w == +0: a program that never divided by w; draw at w = 1. */
        "  if (bitcast<u32>(p.w) == 0u) { p.w = 1.0; }\n"
        "  p.x = p.x * X.aa.x; p.y = p.y * X.aa.y;\n"
        "  return finish(p, saturate(o[3]), saturate(o[4]), o[5].x, o[9], o[10], o[11], o[12], true);\n"
        "}\n");
    return b.overflow ? -1 : (int)b.n;
}

/* Already transformed and clipped on the CPU: GpXfVertex as it is. */
int gpu_gen_vs_passthrough_wgsl(uint32_t flags, char *out, size_t cap)
{
    Sb b = { out, 0, cap, 0 };
    emit_xf_common(&b, flags);
    emit(&b, "struct VI {\n"
             "  @location(0) pos: vec4f, @location(1) d0: vec4f, @location(2) d1: vec4f,\n"
             "  @location(3) fog: vec4f, @location(4) t0: vec4f, @location(5) t1: vec4f,\n"
             "  @location(6) t2: vec4f, @location(7) t3: vec4f,\n"
             "};\n"
             "@vertex fn main(i: VI) -> VO {\n"
             "  return finish(i.pos, i.d0, i.d1, i.fog.x, i.t0, i.t1, i.t2, i.t3, false);\n"
             "}\n");
    return b.overflow ? -1 : (int)b.n;
}

/* ---- screen-space quads (s_tv_hlsl in gpu_d3d11.c) ----------------------- */

static const char k_tv_decl[] =
    "struct TvC { surf: vec2f, zscale: f32, textured: f32,\n"
    "  texsize: vec2f, alpha_ref: f32, alpha_func: f32 };\n"
    "@group(0) @binding(0) var<uniform> U: TvC;\n"
    "struct TvO { @builtin(position) p: vec4f, @location(0) c: vec4f, @location(1) uv: vec2f };\n";

int gpu_gen_vs_tvert_wgsl(char *out, size_t cap)
{
    Sb b = { out, 0, cap, 0 };
    emit(&b, "%s", k_tv_decl);
    emit(&b, "struct TvI { @location(0) p: vec4f, @location(1) c: vec4f, @location(2) uv: vec2f };\n"
             "@vertex fn main(i: TvI) -> TvO {\n"
             "  var o: TvO;\n"
             "  let w = select(1.0, 1.0 / i.p.w, i.p.w != 0.0);\n"
             "  let ndc = vec2f(i.p.x / U.surf.x * 2.0 - 1.0, 1.0 - i.p.y / U.surf.y * 2.0);\n"
             "  o.p = vec4f(ndc * w, saturate(i.p.z * U.zscale) * w, w);\n"
             /* unorm8x4 over the D3DCOLOR's bytes B, G, R, A. */
             "  o.c = i.c.zyxw; o.uv = i.uv / U.texsize;\n"
             "  return o;\n"
             "}\n");
    return b.overflow ? -1 : (int)b.n;
}

int gpu_gen_ps_tvert_wgsl(char *out, size_t cap)
{
    Sb b = { out, 0, cap, 0 };
    emit(&b, "%s", k_tv_decl);
    emit(&b, "@group(1) @binding(0) var t0: texture_2d<f32>;\n"
             "@group(1) @binding(4) var s0: sampler;\n"
             "@fragment fn main(i: TvO) -> @location(0) vec4f {\n"
             "  var c = i.c;\n"
             "  if (U.textured > 0.5) { c = c * textureSample(t0, s0, i.uv); }\n"
             "  if (U.alpha_func > 0.5) {\n"
             "    let a = round(saturate(c.a) * 255.0); let f = i32(U.alpha_func) - 1; var ok = true;\n"
             "    if (f == 0) { ok = false; } else if (f == 1) { ok = a < U.alpha_ref; }\n"
             "    else if (f == 2) { ok = a == U.alpha_ref; } else if (f == 3) { ok = a <= U.alpha_ref; }\n"
             "    else if (f == 4) { ok = a > U.alpha_ref; } else if (f == 5) { ok = a != U.alpha_ref; }\n"
             "    else if (f == 6) { ok = a >= U.alpha_ref; }\n"
             "    if (!ok) { discard; }\n"
             "  }\n"
             "  return c;\n"
             "}\n");
    return b.overflow ? -1 : (int)b.n;
}

/* ---- register combiners -------------------------------------------------- */

static const char k_ps_decl[] =
    "struct PsC {\n"
    "  f0: array<vec4f, 8>, f1: array<vec4f, 8>, fc0: vec4f, fc1: vec4f, fogc: vec4f,\n"
    "  alpha_ref: f32, alpha_func: f32, alpha_on: f32, clip_mode: f32,\n"
    "};\n"
    "@group(0) @binding(2) var<uniform> P: PsC;\n"
    "struct SmpX { border: array<vec4f, 4>, flags: vec4u, bias: vec4f };\n"
    "@group(0) @binding(3) var<uniform> S: SmpX;\n"
    "struct FI {\n"
    "  @builtin(position) pos: vec4f,\n"
    "  @location(0) d0: vec4f, @location(1) d1: vec4f,\n"
    "  @location(2) t0: vec4f, @location(3) t1: vec4f,\n"
    "  @location(4) t2: vec4f, @location(5) t3: vec4f,\n"
    "  @location(6) fog: f32, @location(7) clip: vec2f,\n"
    "};\n"
    /* alpha_test_pass(): on the 0..255 value, GL compare enums. */
    "fn alpha_pass(a: f32) -> bool {\n"
    "  if (P.alpha_on < 0.5) { return true; }\n"
    "  let v = i32(a * 255.0 + 0.5); let r = i32(P.alpha_ref); let f = i32(P.alpha_func);\n"
    "  if (f == 0x200) { return false; } if (f == 0x201) { return v < r; } if (f == 0x202) { return v == r; }\n"
    "  if (f == 0x203) { return v <= r; } if (f == 0x204) { return v > r; } if (f == 0x205) { return v != r; }\n"
    "  if (f == 0x206) { return v >= r; } return true;\n"
    "}\n";

/* map_in(): an input byte's mapping applied to expression x of type vecN
 * (`z` is that type's zero). */
static void map_in(char *o, size_t n, const char *x, uint32_t byte, const char *z)
{
    switch ((byte >> 5) & 7) {
    case 0:  snprintf(o, n, "max(%s, %s)", x, z); break;
    case 1:  snprintf(o, n, "(1.0 - saturate(%s))", x); break;
    case 2:  snprintf(o, n, "(2.0 * max(%s, %s) - 1.0)", x, z); break;
    case 3:  snprintf(o, n, "(-2.0 * max(%s, %s) + 1.0)", x, z); break;
    case 4:  snprintf(o, n, "(max(%s, %s) - 0.5)", x, z); break;
    case 5:  snprintf(o, n, "(-max(%s, %s) + 0.5)", x, z); break;
    case 6:  snprintf(o, n, "(%s)", x); break;
    default: snprintf(o, n, "(-(%s))", x); break;
    }
}

/* read_rgb(): vec3f; the alpha bit replicates .a. */
static void rd_rgb(char *o, size_t n, uint32_t byte)
{
    char x[32];
    snprintf(x, sizeof x, (byte & 0x10) ? "R[%u].aaa" : "R[%u].rgb", byte & 0xF);
    map_in(o, n, x, byte, "vec3f(0.0)");
}

/* read_alpha(): the alpha bit picks .a over .b. */
static void rd_a(char *o, size_t n, uint32_t byte)
{
    char x[32];
    snprintf(x, sizeof x, (byte & 0x10) ? "R[%u].a" : "R[%u].b", byte & 0xF);
    map_in(o, n, x, byte, "0.0");
}

static const char *map_out(uint32_t m)
{
    switch (m) {
    case 0x08: return "(%s - 0.5)";
    case 0x10: return "(%s * 2.0)";
    case 0x18: return "((%s - 0.5) * 2.0)";
    case 0x20: return "(%s * 4.0)";
    case 0x30: return "(%s * 0.5)";
    default:   return "(%s)";
    }
}

static void emit_mapped(Sb *b, const char *name, int vec3, const char *expr, uint32_t mapping)
{
    char inner[160];
    snprintf(inner, sizeof inner, map_out(mapping), expr);
    if (vec3)
        emit(b, "    let %s = clamp(%s, vec3f(-1.0), vec3f(1.0));\n", name, inner);
    else
        emit(b, "    let %s = clamp(%s, -1.0, 1.0);\n", name, inner);
}

int gpu_gen_ps_wgsl(const GpPsKey *k, char *out, size_t cap)
{
    Sb b = { out, 0, cap, 0 };
    int st;
    uint32_t n = k->control & 0xFF, flags = k->control >> 8, s;

    if (n > 8) n = 8;
    emit(&b, "%s", k_ps_decl);
    for (st = 0; st < 4; st++) {
        int cube = (k->cube >> st) & 1;
        emit(&b, "@group(1) @binding(%d) var tx%d: %s;\n"
                 "@group(1) @binding(%d) var sm%d: sampler;\n",
             st, st, cube ? "texture_cube<f32>" : "texture_2d<f32>", st + 4, st);
        if (!cube)
            /* D3D11_TEXTURE_ADDRESS_BORDER, emulated: outside [0,1] on a
             * border axis reads the border colour. */
            emit(&b, "fn s2d%d(uv: vec2f) -> vec4f {\n"
                     "  let c = textureSampleBias(tx%d, sm%d, uv, S.bias[%d]); let f = S.flags[%d];\n"
                     "  let ou = (f & 1u) != 0u && (uv.x < 0.0 || uv.x > 1.0);\n"
                     "  let ov = (f & 2u) != 0u && (uv.y < 0.0 || uv.y > 1.0);\n"
                     "  return select(c, S.border[%d], ou || ov);\n"
                     "}\n", st, st, st, st, st, st);
    }
    emit(&b, "@fragment fn main(i: FI) -> @location(0) vec4f {\n"
             /* Near-plane / w clip, when the VS could not use clip_distances. */
             "  if (i.clip.x < 0.0 || i.clip.y < 0.0) { discard; }\n"
             "  let tc = array<vec4f, 4>(i.t0, i.t1, i.t2, i.t3);\n"
             "  var T: array<vec4f, 4>;\n");

    if (!k->rc_seen) {
        /* No combiners programmed: stage-0 texel * diffuse. */
        if (k->textured && (k->valid & 1) && !(k->cube & 1))
            emit(&b, "  var col = i.d0 * s2d0(tc[0].xy);\n");
        else
            emit(&b, "  var col = i.d0;\n");
        emit(&b, "  if (!alpha_pass(col.a)) { discard; }\n  return saturate(col);\n}\n");
        return b.overflow ? -1 : (int)b.n;
    }

    /* rc_stage_fetch(), per stage. */
    for (st = 0; st < 4; st++) {
        uint32_t mode = (k->stage_program >> (st * 5)) & 0x1F;
        int valid = (k->valid >> st) & 1, cube = (k->cube >> st) & 1;
        switch (mode) {
        case 0:
            emit(&b, "  T[%d] = vec4f(0.0, 0.0, 0.0, 1.0);\n", st);
            break;
        case 1: case 2:
            if (!valid) { emit(&b, "  T[%d] = vec4f(1.0);\n", st); break; }
            if (cube) {         /* cannot happen: cube bits are set for mode 3 only */
                emit(&b, "  T[%d] = textureSampleBias(tx%d, sm%d, tc[%d].xyz, S.bias[%d]);\n", st, st, st, st, st);
                break;
            }
            emit(&b, "  { let q = select(1.0, tc[%d].w, tc[%d].w != 0.0);"
                     " T[%d] = s2d%d(tc[%d].xy / q); }\n", st, st, st, st, st);
            break;
        case 3:
            if (!valid) { emit(&b, "  T[%d] = vec4f(1.0);\n", st); break; }
            if (cube)
                emit(&b, "  T[%d] = textureSampleBias(tx%d, sm%d, tc[%d].xyz, S.bias[%d]);\n", st, st, st, st, st);
            else
                emit(&b, "  T[%d] = s2d%d(tc[%d].xy);\n", st, st, st);
            break;
        case 4:
            emit(&b, "  T[%d] = saturate(tc[%d]);\n", st, st);
            break;
        case 5: {
            int j;
            emit(&b, "  T[%d] = vec4f(0.0);\n", st);
            for (j = 0; j < 4; j++) {
                int ge = (k->clip_plane_mode >> (st * 4 + j)) & 1;
                emit(&b, "  if (tc[%d].%c %s 0.0) { discard; }\n", st, "xyzw"[j], ge ? ">=" : "<");
            }
            break;
        }
        default:
            emit(&b, "  T[%d] = vec4f(0.0);\n", st);   /* bump/dot modes: as the CPU */
            break;
        }
    }

    /* nv2a_rc_eval(). */
    emit(&b, "  var R: array<vec4f, 16>;\n"
             "  R[3] = vec4f(P.fogc.rgb, i.fog);\n"
             "  R[4] = i.d0; R[5] = i.d1;\n"
             "  R[8] = T[0]; R[9] = T[1]; R[10] = T[2]; R[11] = T[3];\n"
             "  R[12].a = %s;\n", (k->stage_program & 0x1F) ? "T[0].a" : "1.0");

    for (s = 0; s < n; s++) {
        uint32_t icw = k->color_icw[s], ocw = k->color_ocw[s];
        uint32_t aicw = k->alpha_icw[s], aocw = k->alpha_ocw[s];
        uint32_t fl = ocw >> 12, afl = aocw >> 12;
        char A[96], B[96], C[96], D[96], aA[96], aB[96], aC[96], aD[96];

        emit(&b, "  { // stage %u\n", s);
        emit(&b, "    R[1] = P.f0[%u]; R[2] = P.f1[%u];\n",
             (flags & 0x010) ? s : 0, (flags & 0x100) ? s : 0);
        if (flags & 1)
            emit(&b, "    let mux_cd = R[12].a >= 0.5;\n");
        else
            emit(&b, "    let mux_cd = (i32(R[12].a * 255.0) & 1) != 0;\n");
        rd_rgb(A, sizeof A, icw >> 24); rd_rgb(B, sizeof B, icw >> 16);
        rd_rgb(C, sizeof C, icw >> 8);  rd_rgb(D, sizeof D, icw);
        rd_a(aA, sizeof aA, aicw >> 24); rd_a(aB, sizeof aB, aicw >> 16);
        rd_a(aC, sizeof aC, aicw >> 8);  rd_a(aD, sizeof aD, aicw);
        emit(&b, "    let A = %s; let B = %s; let C = %s; let D = %s;\n", A, B, C, D);
        emit(&b, "    let aA = %s; let aB = %s; let aC = %s; let aD = %s;\n", aA, aB, aC, aD);
        emit(&b, "    let pab = %s; let pcd = %s;\n",
             (fl & 2) ? "vec3f(dot(A, B))" : "A * B", (fl & 1) ? "vec3f(dot(C, D))" : "C * D");
        emit(&b, "    let sum = %s;\n", (fl & 4) ? "select(pab, pcd, mux_cd)" : "pab + pcd");
        emit_mapped(&b, "ab", 1, "pab", fl & 0x38);
        emit_mapped(&b, "cd", 1, "pcd", fl & 0x38);
        emit_mapped(&b, "ms", 1, "sum", fl & 0x38);
        emit(&b, "    let apab = aA * aB; let apcd = aC * aD;\n");
        emit(&b, "    let asum = %s;\n", (afl & 4) ? "select(apab, apcd, mux_cd)" : "apab + apcd");
        emit_mapped(&b, "aab", 0, "apab", afl & 0x38);
        emit_mapped(&b, "acd", 0, "apcd", afl & 0x38);
        emit_mapped(&b, "ams", 0, "asum", afl & 0x38);
        if ((ocw >> 4) & 0xF) {
            uint32_t r = (ocw >> 4) & 0xF;
            emit(&b, "    R[%u] = vec4f(ab, R[%u].a);\n", r, r);
            if (fl & 0x80) emit(&b, "    R[%u].a = ab.b;\n", r);
        }
        if (ocw & 0xF) {
            uint32_t r = ocw & 0xF;
            emit(&b, "    R[%u] = vec4f(cd, R[%u].a);\n", r, r);
            if (fl & 0x40) emit(&b, "    R[%u].a = cd.b;\n", r);
        }
        if ((ocw >> 8) & 0xF)  emit(&b, "    R[%u] = vec4f(ms, R[%u].a);\n", (ocw >> 8) & 0xF, (ocw >> 8) & 0xF);
        if ((aocw >> 4) & 0xF) emit(&b, "    R[%u].a = aab;\n", (aocw >> 4) & 0xF);
        if (aocw & 0xF)        emit(&b, "    R[%u].a = acd;\n", aocw & 0xF);
        if ((aocw >> 8) & 0xF) emit(&b, "    R[%u].a = ams;\n", (aocw >> 8) & 0xF);
        emit(&b, "    R[0] = vec4f(0.0);\n  }\n");
    }

    if (k->final0 || k->final1) {
        uint32_t f0 = k->final0, f1 = k->final1, ff = f1 & 0xFF;
        char A[96], B[96], C[96], D[96], E[96], F[96], G[96];
        emit(&b, "  R[1] = P.fc0; R[2] = P.fc1;\n");
        emit(&b, "  { let sa = %s; let sb = %s; R[14] = vec4f(%s, 0.0); }\n",
             (ff & 0x40) ? "1.0 - R[5].rgb" : "R[5].rgb",
             (ff & 0x20) ? "1.0 - R[12].rgb" : "R[12].rgb",
             (ff & 0x80) ? "saturate(sa + sb)" : "sa + sb");
        rd_rgb(E, sizeof E, f1 >> 24); rd_rgb(F, sizeof F, f1 >> 16);
        emit(&b, "  R[15] = vec4f(%s * %s, 0.0);\n", E, F);
        rd_rgb(A, sizeof A, f0 >> 24); rd_rgb(B, sizeof B, f0 >> 16);
        rd_rgb(C, sizeof C, f0 >> 8);  rd_rgb(D, sizeof D, f0);
        rd_a(G, sizeof G, f1 >> 8);
        emit(&b, "  let fA = %s; let fB = %s; let fC = %s; let fD = %s;\n", A, B, C, D);
        emit(&b, "  var col = vec4f(fD + fC * (1.0 - fA) + fB * fA, %s);\n", G);
    } else {
        emit(&b, "  var col = R[12];\n");
    }
    emit(&b, "  col = saturate(col);\n"
             "  if (!alpha_pass(col.a)) { discard; }\n"
             "  return col;\n}\n");
    return b.overflow ? -1 : (int)b.n;
}
