/*
 * NV2A vertex programs and register combiners -> HLSL.
 *
 * Each generator mirrors the CPU reference it replaces, rule for rule:
 *   vertex programs: xboxrecomp/src/kernel/nv2a_vsh_interp.c (nv2a_vsh_run)
 *   pixel path:      nv2a_combiner.c (nv2a_rc_eval), rc_stage_fetch and the
 *                    pixel loop in nv2a_pb_exec.c
 * so a difference between the GPU and the software rasteriser is a bug in one
 * of the two, never a difference of interpretation. The program and the
 * combiner words are baked into the shader as constants; what changes per
 * draw (constants, combiner factors, fog, alpha ref) comes from cbuffers.
 *
 * ponytail: HLSL only. The emitters are plain string building over the same
 * decode, so a WGSL twin (for the WebGPU back end) is a second set of format
 * strings, like nfsu2-web's vsemu_wgsl.inc.
 */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "gpu_shadergen.h"

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

/* ---- shared cbuffer declarations ----------------------------------------- */

/* b0 for both vertex shaders; must match GpXfConsts in gpu_proto.h. */
static const char k_xf_cb[] =
    "cbuffer XF : register(b0) {\n"
    "  float2 surf; float zscale; float near_z;\n"
    "  float2 aa; float fog_on; float fog_mode;\n"
    "  float fog_p0; float fog_p1; float2 pad0;\n"
    "  float4 uvscale[4];\n"
    "};\n"
    "struct VO { float4 pos : SV_Position; float4 d0 : COLOR0; float4 d1 : COLOR1;\n"
    "  float4 t0 : TEXCOORD0; float4 t1 : TEXCOORD1; float4 t2 : TEXCOORD2; float4 t3 : TEXCOORD3;\n"
    "  float fog : TEXCOORD4; float2 clip : SV_ClipDistance0; };\n"
    /* fog_factor() in nv2a_pb_exec.c. Modes: 0x800 EXP, 0x801 EXP2,
     * 0x802/0x803 their ABS forms, 0x804 LINEAR_ABS, else LINEAR. */
    "float fog_factor(float d) {\n"
    "  if (fog_on < 0.5) return 1.0;\n"
    "  float f; int m = (int)fog_mode;\n"
    "  if (m == 0x800 || m == 0x802) f = fog_p0 + exp2(d * fog_p1 * 16.0) - 1.5;\n"
    "  else if (m == 0x801 || m == 0x803) f = fog_p0 + exp2(-d * d * fog_p1 * fog_p1 * 32.0) - 1.5;\n"
    "  else f = fog_p0 + d * fog_p1 - 1.0;\n"
    "  if (m == 0x802 || m == 0x803 || m == 0x804) f = abs(f);\n"
    "  if (isnan(f)) f = 1.0;\n"
    "  return saturate(f); }\n"
    /* Screen space (pixels, z in depth units, clip-space w) to D3D clip
     * space. Multiplying back by w makes the rasteriser's perspective divide
     * land where the NV2A's did, and interpolation perspective-correct. */
    "void finish(float4 p, float4 d0, float4 d1, float fogd, float4 t[4], bool clip_near, out VO o) {\n"
    "  float w = p.w;\n"
    "  o.pos = float4((p.x / surf.x * 2.0 - 1.0) * w, (1.0 - p.y / surf.y * 2.0) * w,\n"
    "                 saturate(p.z * zscale) * w, w);\n"
    "  o.d0 = d0; o.d1 = d1; o.fog = fog_factor(fogd);\n"
    "  o.t0 = float4(t[0].xy * uvscale[0].xy, t[0].zw);\n"
    "  o.t1 = float4(t[1].xy * uvscale[1].xy, t[1].zw);\n"
    "  o.t2 = float4(t[2].xy * uvscale[2].xy, t[2].zw);\n"
    "  o.t3 = float4(t[3].xy * uvscale[3].xy, t[3].zw);\n"
    /* The CPU clips at w = 1e-3 and then at the near plane z = near_z. */
    "  o.clip = clip_near ? float2(w - 1e-3, (p.z - near_z) * w) : float2(1, 1); }\n";

/* ---- vertex programs ----------------------------------------------------- */

static uint32_t field(const uint32_t *ins, int dw, int lo, int width)
{
    return (ins[dw] >> lo) & ((1u << width) - 1u);
}

static const char *comp(uint32_t c) { return "xyzw" + (c & 3); }

/* read_src(): one operand as an HLSL expression into variable `name`. */
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
    if (mux == 1)
        snprintf(base, sizeof base, "%s", reg == 12 ? "opos" : (reg < 12 ? "" : "R[0]"));
    if (mux == 1 && reg < 12)
        snprintf(base, sizeof base, "R[%u]", reg);
    else if (mux == 2)
        snprintf(base, sizeof base, "v[%u]", field(ins, 1, 9, 4));
    else if (mux != 1) {
        int ci = (int)field(ins, 1, 13, 8);
        if (field(ins, 3, 1, 1))
            snprintf(base, sizeof base, "c[cidx(%d + a0)]", ci);
        else
            snprintf(base, sizeof base, "c[%d]", (ci < 0 || ci >= 192) ? 0 : ci);
    }
    emit(b, "    float4 %s = %s%s.%c%c%c%c;\n", name, neg ? "-" : "", base,
         *comp(swz >> 6), *comp(swz >> 4), *comp(swz >> 2), *comp(swz));
}

static const char *mask_str(uint32_t m, char out[5])
{
    int k = 0;
    if (m & 8) out[k++] = 'x';
    if (m & 4) out[k++] = 'y';
    if (m & 2) out[k++] = 'z';
    if (m & 1) out[k++] = 'w';
    out[k] = 0;
    return out;
}

static void vsh_write(Sb *b, const char *dst, uint32_t mask, const char *src)
{
    char m[5];
    if (!mask) return;
    mask_str(mask, m);
    emit(b, "    %s.%s = %s.%s;\n", dst, m, src, m);
}

int gpu_gen_vs_program(const uint32_t (*prog)[4], uint32_t len, char *out, size_t cap)
{
    Sb b = { out, 0, cap, 0 };
    uint32_t s;

    emit(&b, "%s", k_xf_cb);
    emit(&b, "cbuffer VSC : register(b1) { float4 c[192]; };\n");
    emit(&b, "struct VI { float4 v[16] : ATTR; };\n");
    emit(&b, "int cidx(int i) { return (i < 0 || i >= 192) ? 0 : i; }\n");
    emit(&b, "VO main(VI vin) {\n"
             "    float4 v[16] = vin.v;\n"
             "    float4 R[12]; [unroll] for (int k = 0; k < 12; k++) R[k] = 0;\n"
             "    float4 opos = 0; int a0 = 0;\n"
             "    float4 o[13]; [unroll] for (int k2 = 0; k2 < 13; k2++) o[k2] = 0;\n"
             "    o[3].w = 1; o[4].w = 1;\n"
             "    o[9].w = 1; o[10].w = 1; o[11].w = 1; o[12].w = 1;\n");

    for (s = 0; s < len; s++) {
        const uint32_t *ins = prog[s];
        uint32_t mac = field(ins, 1, 21, 4), ilu = field(ins, 1, 25, 3);
        uint32_t mac_mask = field(ins, 3, 24, 4), ilu_mask = field(ins, 3, 16, 4);
        uint32_t tdst = field(ins, 3, 20, 4);
        uint32_t omask = field(ins, 3, 12, 4), oaddr = field(ins, 3, 3, 8);

        emit(&b, "  { /* slot %u */\n", s);
        vsh_src(&b, ins, 0, "A");
        vsh_src(&b, ins, 1, "B");
        vsh_src(&b, ins, 2, "C");
        emit(&b, "    float4 M = 0, I = 0;\n");
        switch (mac) {                            /* run_mac */
        case 0:  break;
        case 1:  emit(&b, "    M = A;\n"); break;
        case 2:  emit(&b, "    M = A * B;\n"); break;
        case 3:  emit(&b, "    M = A + C;\n"); break;
        case 4:  emit(&b, "    M = A * B + C;\n"); break;
        case 5:  emit(&b, "    M = dot(A.xyz, B.xyz);\n"); break;
        case 6:  emit(&b, "    M = dot(A.xyz, B.xyz) + B.w;\n"); break;
        case 7:  emit(&b, "    M = dot(A, B);\n"); break;
        case 8:  emit(&b, "    M = float4(1.0, A.y * B.y, A.z, B.w);\n"); break;
        case 9:  emit(&b, "    M = float4(A.x < B.x ? A.x : B.x, A.y < B.y ? A.y : B.y,"
                          " A.z < B.z ? A.z : B.z, A.w < B.w ? A.w : B.w);\n"); break;
        case 10: emit(&b, "    M = float4(A.x >= B.x ? A.x : B.x, A.y >= B.y ? A.y : B.y,"
                          " A.z >= B.z ? A.z : B.z, A.w >= B.w ? A.w : B.w);\n"); break;
        case 11: emit(&b, "    M = float4(A.x < B.x, A.y < B.y, A.z < B.z, A.w < B.w);\n"); break;
        case 12: emit(&b, "    M = float4(A.x >= B.x, A.y >= B.y, A.z >= B.z, A.w >= B.w);\n"); break;
        case 13: emit(&b, "    M = A; a0 = (int)floor(A.x + 0.001);\n"); break;
        default: emit(&b, "    M = A;\n"); break;
        }
        switch (ilu) {                            /* run_ilu */
        case 0:  break;
        case 1:  emit(&b, "    I = C;\n"); break;
        case 2:  emit(&b, "    I = C.x == 0 ? asfloat(0x7f800000) : 1.0 / C.x;\n"); break;
        case 3:  emit(&b, "    { float f = 1.0 / C.x;\n"
                          "      if (abs(f) < 5.42101e-20) f = f < 0 ? -5.42101e-20 : 5.42101e-20;\n"
                          "      if (abs(f) > 1.884467e19) f = f < 0 ? -1.884467e19 : 1.884467e19;\n"
                          "      I = f; }\n"); break;
        case 4:  emit(&b, "    I = 1.0 / sqrt(abs(C.x));\n"); break;
        case 5:  emit(&b, "    { float fl = floor(C.x);"
                          " I = float4(exp2(fl), C.x - fl, exp2(C.x), 1.0); }\n"); break;
        case 6:  emit(&b, "    { float ax = abs(C.x);\n"
                          "      if (ax == 0) I = float4(asfloat(0xff800000), 1.0, asfloat(0xff800000), 1.0);\n"
                          "      else { float e = floor(log2(ax)); I = float4(e, ax / exp2(e), log2(ax), 1.0); } }\n");
                 break;
        case 7:  emit(&b, "    { float nl = C.x > 0 ? C.x : 0, nh = C.y > 0 ? C.y : 0;\n"
                          "      float p = clamp(C.w, -127.9961, 127.9961);\n"
                          "      I = float4(1.0, nl, C.x > 0 ? pow(nh, p) : 0.0, 1.0); }\n"); break;
        default: emit(&b, "    I = C;\n"); break;
        }
        if (mac && mac != 13 && mac_mask) {
            if (tdst == 12) vsh_write(&b, "opos", mac_mask, "M");
            else if (tdst < 12) { char d[16]; snprintf(d, sizeof d, "R[%u]", tdst); vsh_write(&b, d, mac_mask, "M"); }
        }
        if (ilu && ilu_mask) {
            /* Paired with any MAC op the ILU writes R1 (see nv2a_vsh_run). */
            uint32_t it = mac ? 1u : tdst;
            if (it == 12) vsh_write(&b, "opos", ilu_mask, "I");
            else if (it < 12) { char d[16]; snprintf(d, sizeof d, "R[%u]", it); vsh_write(&b, d, ilu_mask, "I"); }
        }
        if (omask && field(ins, 3, 11, 1)) {      /* writes to c[] are refused upstream */
            const char *src = field(ins, 3, 2, 1) ? "I" : "M";
            if (oaddr == 0) vsh_write(&b, "opos", omask, src);
            else if (oaddr < 13) { char d[16]; snprintf(d, sizeof d, "o[%u]", oaddr); vsh_write(&b, d, omask, src); }
        }
        emit(&b, "  }\n");
        if (field(ins, 3, 0, 1))
            break;
    }
    emit(&b,
        "    float4 p = opos;\n"
        /* oPos.w == +0: a program that never divided by w; draw at w = 1. */
        "    if (asuint(p.w) == 0u) p.w = 1.0;\n"
        "    p.x *= aa.x; p.y *= aa.y;\n"
        "    float4 t[4] = { o[9], o[10], o[11], o[12] };\n"
        "    VO r; finish(p, saturate(o[3]), saturate(o[4]), o[5].x, t, true, r);\n"
        "    return r;\n}\n");
    return b.overflow ? -1 : (int)b.n;
}

/* Already transformed (fixed function), already clipped: Nv2aVshOutput as
 * it is, eight float4s per vertex. */
int gpu_gen_vs_passthrough(char *out, size_t cap)
{
    Sb b = { out, 0, cap, 0 };
    emit(&b, "%s", k_xf_cb);
    emit(&b, "struct VI { float4 pos : POS; float4 d0 : D0; float4 d1 : D1; float4 fog : FOGC;\n"
             "  float4 t0 : T0; float4 t1 : T1; float4 t2 : T2; float4 t3 : T3; };\n"
             "VO main(VI i) {\n"
             "    float4 t[4] = { i.t0, i.t1, i.t2, i.t3 };\n"
             "    VO r; finish(i.pos, i.d0, i.d1, i.fog.x, t, false, r);\n"
             "    return r;\n}\n");
    return b.overflow ? -1 : (int)b.n;
}

/* ---- register combiners -------------------------------------------------- */

/* b0 for the pixel shader; must match GpPsConsts in gpu_proto.h. */
static const char k_ps_cb[] =
    "cbuffer PS : register(b0) {\n"
    "  float4 f0[8]; float4 f1[8]; float4 fc0; float4 fc1; float4 fogc;\n"
    "  float alpha_ref; float alpha_func; float alpha_on; float clip_mode;\n"
    "};\n"
    "struct VO { float4 pos : SV_Position; float4 d0 : COLOR0; float4 d1 : COLOR1;\n"
    "  float4 t0 : TEXCOORD0; float4 t1 : TEXCOORD1; float4 t2 : TEXCOORD2; float4 t3 : TEXCOORD3;\n"
    "  float fog : TEXCOORD4; };\n"
    /* alpha_test_pass(): on the 0..255 value, GL compare enums. */
    "bool alpha_pass(float a) {\n"
    "  if (alpha_on < 0.5) return true;\n"
    "  int v = (int)(a * 255.0 + 0.5), r = (int)alpha_ref, f = (int)alpha_func;\n"
    "  if (f == 0x200) return false; if (f == 0x201) return v < r; if (f == 0x202) return v == r;\n"
    "  if (f == 0x203) return v <= r; if (f == 0x204) return v > r; if (f == 0x205) return v != r;\n"
    "  if (f == 0x206) return v >= r; return true; }\n";

/* map_in(): an input byte's mapping applied to expression x. */
static void map_in(char *o, size_t n, const char *x, uint32_t byte)
{
    switch ((byte >> 5) & 7) {
    case 0:  snprintf(o, n, "max(%s, 0)", x); break;
    case 1:  snprintf(o, n, "(1.0 - saturate(%s))", x); break;
    case 2:  snprintf(o, n, "(2.0 * max(%s, 0) - 1.0)", x); break;
    case 3:  snprintf(o, n, "(-2.0 * max(%s, 0) + 1.0)", x); break;
    case 4:  snprintf(o, n, "(max(%s, 0) - 0.5)", x); break;
    case 5:  snprintf(o, n, "(-max(%s, 0) + 0.5)", x); break;
    case 6:  snprintf(o, n, "(%s)", x); break;
    default: snprintf(o, n, "(-(%s))", x); break;
    }
}

/* read_rgb(): float3; the alpha bit replicates .a. */
static void rd_rgb(char *o, size_t n, uint32_t byte)
{
    char x[32];
    snprintf(x, sizeof x, (byte & 0x10) ? "R[%u].aaa" : "R[%u].rgb", byte & 0xF);
    map_in(o, n, x, byte);
}

/* read_alpha(): the alpha bit picks .a over .b. */
static void rd_a(char *o, size_t n, uint32_t byte)
{
    char x[32];
    snprintf(x, sizeof x, (byte & 0x10) ? "R[%u].a" : "R[%u].b", byte & 0xF);
    map_in(o, n, x, byte);
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

static void emit_mapped(Sb *b, const char *decl, const char *expr, uint32_t mapping)
{
    char inner[160];
    snprintf(inner, sizeof inner, map_out(mapping), expr);
    emit(b, "    %s = clamp(%s, -1.0, 1.0);\n", decl, inner);
}

int gpu_gen_ps(const GpPsKey *k, char *out, size_t cap)
{
    Sb b = { out, 0, cap, 0 };
    int st;
    uint32_t n = k->control & 0xFF, flags = k->control >> 8, s;

    if (n > 8) n = 8;
    emit(&b, "%s", k_ps_cb);
    for (st = 0; st < 4; st++) {
        emit(&b, "%s tx%d : register(t%d); SamplerState sm%d : register(s%d);\n",
             (k->cube >> st) & 1 ? "TextureCube" : "Texture2D", st, st, st, st);
    }
    emit(&b, "float4 main(VO i) : SV_Target {\n"
             "    float4 tc[4] = { i.t0, i.t1, i.t2, i.t3 };\n"
             "    float4 T[4];\n");

    if (!k->rc_seen) {
        /* No combiners programmed: stage-0 texel * diffuse. */
        if (k->textured && (k->valid & 1))
            emit(&b, "    float4 col = i.d0 * tx0.Sample(sm0, tc[0].xy);\n");
        else
            emit(&b, "    float4 col = i.d0;\n");
        emit(&b, "    if (!alpha_pass(col.a)) discard;\n    return saturate(col);\n}\n");
        return b.overflow ? -1 : (int)b.n;
    }

    /* rc_stage_fetch(), per stage. */
    for (st = 0; st < 4; st++) {
        uint32_t mode = (k->stage_program >> (st * 5)) & 0x1F;
        int valid = (k->valid >> st) & 1;
        switch (mode) {
        case 0:
            emit(&b, "    T[%d] = float4(0, 0, 0, 1);\n", st);
            break;
        case 1: case 2:
            if (!valid) { emit(&b, "    T[%d] = 1;\n", st); break; }
            emit(&b, "    { float q = tc[%d].w != 0 ? tc[%d].w : 1.0;"
                     " T[%d] = tx%d.Sample(sm%d, tc[%d].xy / q); }\n",
                 st, st, st, st, st, st);
            break;
        case 3:
            if (!valid) { emit(&b, "    T[%d] = 1;\n", st); break; }
            if ((k->cube >> st) & 1)
                emit(&b, "    T[%d] = tx%d.Sample(sm%d, tc[%d].xyz);\n", st, st, st, st);
            else
                emit(&b, "    T[%d] = tx%d.Sample(sm%d, tc[%d].xy);\n", st, st, st, st);
            break;
        case 4:
            emit(&b, "    T[%d] = saturate(tc[%d]);\n", st, st);
            break;
        case 5: {
            int j;
            emit(&b, "    T[%d] = 0;\n", st);
            for (j = 0; j < 4; j++) {
                int ge = (k->clip_plane_mode >> (st * 4 + j)) & 1;
                emit(&b, "    if (tc[%d].%c %s 0) discard;\n", st, "xyzw"[j], ge ? ">=" : "<");
            }
            break;
        }
        default:
            emit(&b, "    T[%d] = 0;\n", st);   /* bump/dot modes: as the CPU */
            break;
        }
    }

    /* nv2a_rc_eval(). */
    emit(&b, "    float4 R[16]; [unroll] for (int k = 0; k < 16; k++) R[k] = 0;\n"
             "    R[3] = float4(fogc.rgb, i.fog);\n"
             "    R[4] = i.d0; R[5] = i.d1;\n"
             "    R[8] = T[0]; R[9] = T[1]; R[10] = T[2]; R[11] = T[3];\n"
             "    R[12].a = %s;\n", (k->stage_program & 0x1F) ? "T[0].a" : "1.0");

    for (s = 0; s < n; s++) {
        uint32_t icw = k->color_icw[s], ocw = k->color_ocw[s];
        uint32_t aicw = k->alpha_icw[s], aocw = k->alpha_ocw[s];
        uint32_t fl = ocw >> 12, afl = aocw >> 12;
        char A[96], B[96], C[96], D[96], aA[96], aB[96], aC[96], aD[96];

        emit(&b, "  { /* stage %u */\n", s);
        emit(&b, "    R[1] = f0[%u]; R[2] = f1[%u];\n",
             (flags & 0x010) ? s : 0, (flags & 0x100) ? s : 0);
        if (flags & 1)
            emit(&b, "    bool mux_cd = R[12].a >= 0.5;\n");
        else
            emit(&b, "    bool mux_cd = (((int)(R[12].a * 255.0)) & 1) != 0;\n");
        rd_rgb(A, sizeof A, icw >> 24); rd_rgb(B, sizeof B, icw >> 16);
        rd_rgb(C, sizeof C, icw >> 8);  rd_rgb(D, sizeof D, icw);
        rd_a(aA, sizeof aA, aicw >> 24); rd_a(aB, sizeof aB, aicw >> 16);
        rd_a(aC, sizeof aC, aicw >> 8);  rd_a(aD, sizeof aD, aicw);
        emit(&b, "    float3 A = %s, B = %s, C = %s, D = %s;\n", A, B, C, D);
        emit(&b, "    float aA = %s, aB = %s, aC = %s, aD = %s;\n", aA, aB, aC, aD);
        emit(&b, "    float3 pab = %s, pcd = %s;\n",
             (fl & 2) ? "dot(A, B).xxx" : "A * B", (fl & 1) ? "dot(C, D).xxx" : "C * D");
        emit(&b, "    float3 sum = %s;\n", (fl & 4) ? "mux_cd ? pcd : pab" : "pab + pcd");
        emit_mapped(&b, "float3 ab", "pab", fl & 0x38);
        emit_mapped(&b, "float3 cd", "pcd", fl & 0x38);
        emit_mapped(&b, "float3 ms", "sum", fl & 0x38);
        emit(&b, "    float apab = aA * aB, apcd = aC * aD;\n");
        emit(&b, "    float asum = %s;\n", (afl & 4) ? "mux_cd ? apcd : apab" : "apab + apcd");
        emit_mapped(&b, "float aab", "apab", afl & 0x38);
        emit_mapped(&b, "float acd", "apcd", afl & 0x38);
        emit_mapped(&b, "float ams", "asum", afl & 0x38);
        if ((ocw >> 4) & 0xF) {
            emit(&b, "    R[%u].rgb = ab;\n", (ocw >> 4) & 0xF);
            if (fl & 0x80) emit(&b, "    R[%u].a = ab.b;\n", (ocw >> 4) & 0xF);
        }
        if (ocw & 0xF) {
            emit(&b, "    R[%u].rgb = cd;\n", ocw & 0xF);
            if (fl & 0x40) emit(&b, "    R[%u].a = cd.b;\n", ocw & 0xF);
        }
        if ((ocw >> 8) & 0xF)  emit(&b, "    R[%u].rgb = ms;\n", (ocw >> 8) & 0xF);
        if ((aocw >> 4) & 0xF) emit(&b, "    R[%u].a = aab;\n", (aocw >> 4) & 0xF);
        if (aocw & 0xF)        emit(&b, "    R[%u].a = acd;\n", aocw & 0xF);
        if ((aocw >> 8) & 0xF) emit(&b, "    R[%u].a = ams;\n", (aocw >> 8) & 0xF);
        emit(&b, "    R[0] = 0;\n  }\n");
    }

    if (k->final0 || k->final1) {
        uint32_t f0 = k->final0, f1 = k->final1, ff = f1 & 0xFF;
        char A[96], B[96], C[96], D[96], E[96], F[96], G[96];
        emit(&b, "    R[1] = fc0; R[2] = fc1;\n");
        emit(&b, "    { float3 sa = %s, sb = %s; R[14] = float4(%s, 0); }\n",
             (ff & 0x40) ? "1.0 - R[5].rgb" : "R[5].rgb",
             (ff & 0x20) ? "1.0 - R[12].rgb" : "R[12].rgb",
             (ff & 0x80) ? "saturate(sa + sb)" : "sa + sb");
        rd_rgb(E, sizeof E, f1 >> 24); rd_rgb(F, sizeof F, f1 >> 16);
        emit(&b, "    R[15] = float4(%s * %s, 0);\n", E, F);
        rd_rgb(A, sizeof A, f0 >> 24); rd_rgb(B, sizeof B, f0 >> 16);
        rd_rgb(C, sizeof C, f0 >> 8);  rd_rgb(D, sizeof D, f0);
        rd_a(G, sizeof G, f1 >> 8);
        emit(&b, "    float3 fA = %s, fB = %s, fC = %s, fD = %s;\n", A, B, C, D);
        emit(&b, "    float4 col = float4(fD + fC * (1.0 - fA) + fB * fA, %s);\n", G);
    } else {
        emit(&b, "    float4 col = R[12];\n");
    }
    emit(&b, "    col = saturate(col);\n"
             "    if (!alpha_pass(col.a)) discard;\n"
             "    return col;\n}\n");
    return b.overflow ? -1 : (int)b.n;
}
