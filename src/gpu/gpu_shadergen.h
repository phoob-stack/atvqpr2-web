/* NV2A vertex programs and register combiners -> HLSL (gpu_shadergen.c). */
#ifndef ATV2_GPU_SHADERGEN_H
#define ATV2_GPU_SHADERGEN_H

#include <stddef.h>
#include <stdint.h>

/* Everything that decides a pixel shader's code. Constants that change per
 * draw (combiner factors, fog colour, alpha ref) are cbuffer values instead,
 * so they do not multiply shaders. Zero it before filling: it is hashed. */
typedef struct {
    uint32_t color_icw[8], alpha_icw[8], color_ocw[8], alpha_ocw[8];
    uint32_t final0, final1, control, stage_program, clip_plane_mode;
    uint32_t cube;          /* bit per stage: a cube texture is bound */
    uint32_t valid;         /* bit per stage: a usable texture is bound */
    uint32_t rc_seen, textured;
} GpPsKey;

/* Return the HLSL length, or -1 if `cap` was too small. */
int gpu_gen_vs_program(const uint32_t (*prog)[4], uint32_t len, char *out, size_t cap);
int gpu_gen_vs_passthrough(char *out, size_t cap);
int gpu_gen_ps(const GpPsKey *k, char *out, size_t cap);

#endif
