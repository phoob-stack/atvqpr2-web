/*
 * NV2A vertex programs and register combiners -> WGSL (gpu_shadergen_wgsl.c),
 * the WebGPU twin of gpu_shadergen.h. Same inputs, same rules, same
 * constant-block layouts (gpu_proto.h); only the language differs.
 *
 * Bind-group layout shared by every module (one pipeline layout for all
 * draws; group 1's texture view dimensions follow the PS key's cube bits):
 *
 *   group 0, all uniform, dynamic offsets       D3D11 equivalent
 *     binding 0  GpXfConsts / GpTvConsts  VS+FS   VS b0 (and PS b0 for TVERT)
 *     binding 1  GpVsConsts               VS      VS b1
 *     binding 2  GpPsConsts               FS      PS b0
 *     binding 3  GpWgslSmp (below)        FS      sampler border colours
 *   group 1
 *     binding 0..3  texture_2d<f32> or texture_cube<f32>, stage 0..3   t0..t3
 *     binding 4..7  sampler, stage 0..3                                s0..s3
 *
 * Vertex inputs: program VS 16 x float32x4 at locations 0..15 (stride 256);
 * pass-through 8 x float32x4 (GpXfVertex, stride 128); TVERT float32x4,
 * unorm8x4 (BGRA bytes), float32x2 (GpTVertex, stride 28).
 *
 * Every module has one entry point, `main`.
 */
#ifndef ATV2_GPU_SHADERGEN_WGSL_H
#define ATV2_GPU_SHADERGEN_WGSL_H

#include <stddef.h>
#include <stdint.h>

#include "gpu_shadergen.h"

/* WebGPU has no clamp-to-border address mode: the PS emulates it from this
 * block, filled per draw from GpDraw.border[] / GpDraw.smp[] by the back end. */
typedef struct {
    float    border[4][4];      /* stage colour, r g b a in 0..1 */
    uint32_t flags[4];          /* bit 0: U is BORDER, bit 1: V is BORDER */
} GpWgslSmp;
_Static_assert(sizeof(GpWgslSmp) == 80, "GpWgslSmp layout");

/* Vertex shader variants. Without the optional `clip-distances` feature the
 * two NV2A clip distances (w > 1e-3, z >= near) travel as a varying and the
 * PS discards (exact per pixel: the distances are linear in clip space and
 * interpolated perspective-correctly). With it, the VS writes
 * @builtin(clip_distances) and the varying is constant (1, 1). */
#define GP_WGSL_CLIPDIST 1u

int gpu_gen_vs_program_wgsl(const uint32_t (*prog)[4], uint32_t len, uint32_t flags,
                            char *out, size_t cap);
int gpu_gen_vs_passthrough_wgsl(uint32_t flags, char *out, size_t cap);
int gpu_gen_vs_tvert_wgsl(char *out, size_t cap);
int gpu_gen_ps_tvert_wgsl(char *out, size_t cap);
int gpu_gen_ps_wgsl(const GpPsKey *k, char *out, size_t cap);

/* ---- the WebGPU tap (gpu_wgsl_tap.c) ------------------------------------- */
/* The recorder calls these when it creates a shader id, so WGSL exists for
 * every id the HLSL queue carries. All are no-ops unless one of
 * RECOMP_GPU_DUMP_WGSL, RECOMP_GPU_CAPTURE or RECOMP_GPU_BACKEND=wgpu is set. */
void gp_wgsl_note_vs(uint32_t id, const uint32_t (*prog)[4], uint32_t len);
void gp_wgsl_note_ps(uint32_t id, const GpPsKey *k);
/* WGSL text for a shader id (built-ins: GP_VS_PASSTHRU, GP_VS_TVERT with
 * is_ps 0; GP_PS_TVERT with is_ps 1), or NULL. */
const char *gp_wgsl_source(uint32_t id, int is_ps, uint32_t *len);

/* rec_flip()'s hand-over: picks the drawing back end (RECOMP_GPU_BACKEND=
 * wgpu when built with ATV2_WGPU, else D3D11) and takes frame captures
 * (RECOMP_GPU_CAPTURE) around it. */
#include "gpu_proto.h"
void gp_backend_flip(const GpFrame *f);

/* ---- frame capture files (RECOMP_GPU_CAPTURE=dir) ------------------------ */
/* cap_<frame>.gpf: a self-contained frame for web/replay.html. The queue is
 * prefixed with every resource live at the start of the frame (render
 * targets with the guest's current pixels, depth, textures, shaders) and
 * every shader payload is WGSL, i.e. it is exactly what the browser build's
 * recorder will hand the page. Sections follow the header, each padded to 16. */
typedef struct {
    char     magic[4];          /* "GPF1" */
    uint32_t version;           /* GP_VERSION */
    uint32_t layout;            /* GP_WG_LAYOUT */
    uint32_t frame;
    uint32_t queue_bytes, draw_count, vtx_bytes, idx_count, const_bytes;
    uint32_t ref_target;        /* render target the .ref file holds */
    uint32_t pad[2];
} GpCapHeader;
_Static_assert(sizeof(GpCapHeader) == 48, "GpCapHeader layout");
/* cap_<frame>.ref: what D3D11 drew into ref_target: "GPR1", id, w, h, then
 * w*h BGRA8 (from the guest memory the D3D11 back end wrote back). */

/* Struct sizes XOR the version, like nfsu2-web's GW_LAYOUT: a page built
 * against another layout refuses the file. */
#define GP_WG_LAYOUT ((uint32_t)(sizeof(GpDraw) | sizeof(GpCmd) << 10 | sizeof(GpPsConsts) << 16) \
                      ^ ((uint32_t)GP_VERSION << 28))

#endif
