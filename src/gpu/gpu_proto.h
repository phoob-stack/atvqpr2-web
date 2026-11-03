/*
 * Frame packets: what the recorder (gpu_rec.c) hands a drawing back end.
 *
 * The shape follows nfsu2-web's runtime/web/gpu_proto.h: per frame, an
 * ordered resource queue (render targets, textures, shaders) and a list of
 * fixed-size draw records pointing into arenas (vertices, indices, constant
 * blocks). The back end drains the queue, then draws the records in order.
 * Everything a record refers to is already in the frame -- the recorder
 * snapshots textures and vertices when the pushbuffer walk reaches the draw,
 * because the title is free to overwrite them as soon as the walk moves on.
 *
 * One layout for every back end: D3D11 now, WebGPU later, where these structs
 * are read straight out of wasm memory. Hence fixed-width fields only and the
 * size asserts at the bottom; a TypeScript mirror must match them.
 */
#ifndef ATV2_GPU_PROTO_H
#define ATV2_GPU_PROTO_H

#include <stdint.h>

#define GP_VERSION 1

/* ---- draw records -------------------------------------------------------- */

enum { GP_DRAW = 0, GP_CLEAR = 1 };

/* Vertex shader ids below GP_VS_FIRST_PROGRAM are built in. */
enum {
    GP_VS_PASSTHRU = 1,     /* GpXfVertex: transformed and clipped on the CPU */
    GP_VS_TVERT = 2,        /* GpTVertex: screen-space quads (menus, HUD)      */
    GP_VS_FIRST_PROGRAM = 16
};
/* Pixel shader 1 is the built-in one for GP_VS_TVERT. */
enum { GP_PS_TVERT = 1, GP_PS_FIRST = 16 };

#define GP_TEX_RT 0x80000000u   /* tex[] names a render target, not a texture */

typedef struct {
    uint32_t blend_en, blend_src, blend_dst, blend_eq, blend_color;
    uint32_t color_mask;
    uint32_t depth_test, depth_func, depth_write;
    uint32_t stencil_en, stencil_func, stencil_ref, stencil_fmask, stencil_wmask;
    uint32_t stencil_fail, stencil_zfail, stencil_zpass;
} GpState;                       /* NV2A (OpenGL) enum values throughout */

typedef struct {
    uint32_t kind;
    uint32_t target;             /* render target id */
    uint32_t target_swz;         /* this use stores the target swizzled: the
                                    target is written back only if its last
                                    use in the frame was linear */
    uint32_t zeta;               /* depth id, 0 = none */
    uint32_t zeta_format;        /* 1 Z16, 2 Z24S8: the unit z arrives in */
    uint32_t vs, ps;
    uint32_t tex[4];             /* texture id, GP_TEX_RT | target id, or 0 */
    uint32_t smp[4];             /* GP_SMP_* bits */
    uint32_t border[4];          /* border colour, 0xAARRGGBB */
    GpState  st;
    uint32_t vtx_off, vtx_count, vtx_stride;    /* bytes into the vertex arena */
    uint32_t idx_off, idx_count;                /* uint32s into the index arena */
    uint32_t vsc_off;            /* GpVsConsts in the constant arena, or ~0 */
    uint32_t xfc_off;            /* GpXfConsts or GpTvConsts */
    uint32_t psc_off;            /* GpPsConsts, or ~0 */
    uint32_t clr_flags, clr_argb, clr_zs;       /* GP_CLEAR */
    /* Target pixels a draw may touch, or a clear covers: x0 | y0 << 16,
     * x1 | y1 << 16, [x0, x1) x [y0, y1), within the target. The window clip
     * (D3D's viewport) for a draw, the clear rect for a clear: split screen
     * draws each player's view into its own part of one target. */
    uint32_t rect[2];
} GpDraw;

#define GP_SMP_LINEAR   0x1
#define GP_SMP_U(a)     (((a) & 0xF) << 4)       /* NV2A wrap: 1 wrap 2 mirror 3 clamp 4 border */
#define GP_SMP_V(a)     (((a) & 0xF) << 8)
#define GP_SMP_BORDER   0x1000                   /* BORDER reads border[] */
/* GP_SMP_FILTER: the key carries SET_TEXTURE_FILTER's MIN (bits 16-19) and
 * MAG (20-23) and the LOD bias in 1/16 levels, signed (24-31); the texture
 * has mip levels to select from. Without it, GP_SMP_LINEAR alone decides and
 * level 0 is sampled. */
#define GP_SMP_FILTER   0x2000
#define GP_SMP_MIN(m)   (((m) & 0xF) << 16)
#define GP_SMP_MAG(m)   (((m) & 0xF) << 20)
#define GP_SMP_BIAS(b)  (((uint32_t)(b) & 0xFF) << 24)
#define GP_SMP_MIN_OF(k)  (((k) >> 16) & 0xF)
#define GP_SMP_MAG_OF(k)  (((k) >> 20) & 0xF)
#define GP_SMP_BIAS_OF(k) ((int)(int8_t)((k) >> 24) * 16)   /* in 1/256 levels */

/* ---- vertices ------------------------------------------------------------ */

typedef struct { float v[16][4]; } GpProgVertex;      /* program input registers */
typedef struct {                                       /* Nv2aVshOutput */
    float pos[4], d0[4], d1[4], fog[4], tex[4][4];
} GpXfVertex;
typedef struct { float x, y, z, rhw; uint32_t diffuse; float u, v; } GpTVertex;

/* ---- constant blocks (layouts are the HLSL cbuffers) --------------------- */

typedef struct { float c[192][4]; } GpVsConsts;

typedef struct {
    float surf[2], zscale, near_z;
    float aa[2], fog_on, fog_mode;
    float fog_p0, fog_p1, pad0[2];
    float uvscale[4][4];
} GpXfConsts;

typedef struct {
    float surf[2], zscale, textured;
    float texsize[2], alpha_ref, alpha_func;
} GpTvConsts;

typedef struct {
    float f0[8][4], f1[8][4], fc0[4], fc1[4], fogc[4];
    float alpha_ref, alpha_func, alpha_on, clip_mode;
} GpPsConsts;

/* ---- resource queue ------------------------------------------------------ */

enum {
    GP_RT_CREATE = 1,   /* id, a=guest va, b=w, c=h, d=bpp|colour fmt<<8|swizzled<<16,
                           e=pitch; payload: initial BGRA8 rows, or none */
    GP_DS_CREATE,       /* id, b=w, c=h */
    GP_TEX_CREATE,      /* id, a=mip levels (0 = 1), b=w, c=h, d=GP_FMT_*, e=faces (1 or 6); payload:
                           per face its levels, each tightly packed */
    GP_TEX_FREE,        /* id */
    GP_SHADER_VS,       /* id; payload: HLSL */
    GP_SHADER_PS,       /* id; payload: HLSL */
    GP_RT_NO_WRITEBACK, /* unused (superseded by GpDraw.target_swz) */
    GP_SUB_CREATE       /* id, a=source render target id, b=w, c=h, d=x0 | y0<<16:
                           a texture that is a tile of a render target, copied
                           out of it before every draw that samples it */
};
enum { GP_FMT_BGRA8 = 1, GP_FMT_BC1, GP_FMT_BC2, GP_FMT_BC3 };

typedef struct {
    uint32_t op, id, a, b, c, d, e, bytes;    /* payload of `bytes` follows,
                                                 padded to 16 */
} GpCmd;

/* ---- a frame ------------------------------------------------------------- */

typedef struct {
    const uint8_t  *queue;   uint32_t queue_bytes;
    const GpDraw   *draws;   uint32_t draw_count;
    const uint8_t  *vtx;     uint32_t vtx_bytes;
    const uint32_t *idx;     uint32_t idx_count;
    const uint8_t  *consts;  uint32_t const_bytes;
    uint32_t frame;
} GpFrame;

_Static_assert(sizeof(GpState) == 17 * 4, "GpState layout");
_Static_assert(sizeof(GpDraw) == 32 * 4 + sizeof(GpState), "GpDraw layout");
_Static_assert(sizeof(GpXfVertex) == 128, "GpXfVertex layout");
_Static_assert(sizeof(GpTVertex) == 28, "GpTVertex layout");
_Static_assert(sizeof(GpXfConsts) == 112, "GpXfConsts layout");
_Static_assert(sizeof(GpTvConsts) == 32, "GpTvConsts layout");
_Static_assert(sizeof(GpPsConsts) == 320, "GpPsConsts layout");
_Static_assert(sizeof(GpCmd) == 32, "GpCmd layout");

/* The drawing side (gpu_d3d11.c). Called at every flip with that frame. */
void gp_d3d11_consume(const GpFrame *f);
int  gp_d3d11_ready(void);
/* GPU-vs-CPU check (RECOMP_GPU_CHECK): draw a partial frame now, sampling
 * level 0 only (as the CPU reference does), and write every target it drew
 * back to guest memory, swizzled targets swizzled. */
void gp_d3d11_sync(const GpFrame *f);
void gp_d3d11_writeback_swizzled(void);
/* Run vertex shader `vs` on n program input vertices with the given XF and
 * VS constants and return what it outputs, through stream output: per vertex
 * GP_PROBE_FLOATS floats -- SV_Position, COLOR0, COLOR1, TEXCOORD0-3 (4
 * each), fog factor. Returns the vertex count read back, 0 on failure. */
#define GP_PROBE_FLOATS 29
#define GP_PROBE_MAX    64
uint32_t gp_d3d11_vs_probe(uint32_t vs, const GpXfConsts *xc, const GpVsConsts *vc,
                           const GpProgVertex *in, uint32_t n, float *out);

#endif
