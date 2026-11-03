/*
 * Coverage for the WGSL emitter beyond what one game run generates: random
 * vertex-program microcode (every MAC and ILU opcode, operand mux, swizzle,
 * negate, relative addressing, masks, output registers) and random combiner
 * keys (every stage mode, input mapping, output mapping, mux, dot, final
 * combiner bits, cube stages), written as .wgsl for validate-wgsl.mjs.
 * Compile validity only; it says nothing about the math.
 *
 *   cl /std:c11 /I src/gpu web/tools/wgsl_fuzz.c src/gpu/gpu_shadergen_wgsl.c src/gpu/gpu_shadergen.c
 *   wgsl_fuzz <out dir> [count]
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gpu_shadergen_wgsl.h"

static uint64_t s_rng = 0x9E3779B97F4A7C15ull;
static uint32_t rnd(void)
{
    s_rng ^= s_rng << 13; s_rng ^= s_rng >> 7; s_rng ^= s_rng << 17;
    return (uint32_t)(s_rng >> 16);
}

static char s_buf[512 * 1024];

static void put(const char *dir, const char *name, int n)
{
    char path[512];
    FILE *f;
    if (n < 0) { fprintf(stderr, "%s: overflow\n", name); exit(1); }
    snprintf(path, sizeof path, "%s/%s", dir, name);
    if (!(f = fopen(path, "wb"))) { perror(path); exit(1); }
    fwrite(s_buf, 1, (size_t)n, f);
    fclose(f);
}

int main(int argc, char **argv)
{
    const char *dir = argc > 1 ? argv[1] : ".";
    int count = argc > 2 ? atoi(argv[2]) : 64, i, s;
    char name[64];
    /* The built-ins: the validator pairs PS modules with these. */
    put(dir, "vs_1_passthru.wgsl", gpu_gen_vs_passthrough_wgsl(0, s_buf, sizeof s_buf));
    put(dir, "vs_1_passthru.cd.wgsl", gpu_gen_vs_passthrough_wgsl(GP_WGSL_CLIPDIST, s_buf, sizeof s_buf));
    put(dir, "vs_2_tvert.wgsl", gpu_gen_vs_tvert_wgsl(s_buf, sizeof s_buf));
    put(dir, "ps_1_tvert.wgsl", gpu_gen_ps_tvert_wgsl(s_buf, sizeof s_buf));
    for (i = 0; i < count; i++) {
        uint32_t prog[136][4], len = 1 + rnd() % 40;
        GpPsKey k;
        memset(prog, 0, sizeof prog);
        for (s = 0; s < (int)len; s++) {
            prog[s][0] = rnd(); prog[s][1] = rnd(); prog[s][2] = rnd(); prog[s][3] = rnd() & ~1u;
            /* Opcodes cycle so every one appears at least once per program set. */
            prog[s][1] = (prog[s][1] & ~(0xFu << 21) & ~(0x7u << 25))
                       | (((uint32_t)(s + i) % 14) << 21) | (((uint32_t)(s * 3 + i) % 8) << 25);
        }
        prog[len - 1][3] |= 1;                       /* end flag */
        snprintf(name, sizeof name, "vs_fuzz%03d.wgsl", i);
        put(dir, name, gpu_gen_vs_program_wgsl((const uint32_t (*)[4])prog, len, 0, s_buf, sizeof s_buf));
        if (i % 4 == 0) {
            snprintf(name, sizeof name, "vs_fuzz%03d.cd.wgsl", i);
            put(dir, name, gpu_gen_vs_program_wgsl((const uint32_t (*)[4])prog, len, GP_WGSL_CLIPDIST,
                                                   s_buf, sizeof s_buf));
        }

        memset(&k, 0, sizeof k);
        for (s = 0; s < 8; s++) {
            k.color_icw[s] = rnd(); k.alpha_icw[s] = rnd();
            k.color_ocw[s] = rnd() & 0xFFFFF; k.alpha_ocw[s] = rnd() & 0xFFFFF;
        }
        k.final0 = rnd(); k.final1 = rnd();
        k.control = (1 + rnd() % 8) | ((rnd() & 0x111) << 8);
        k.stage_program = (uint32_t)(i % 6) | ((rnd() % 18) << 5) | ((rnd() % 18) << 10) | ((rnd() % 18) << 15);
        k.clip_plane_mode = rnd() & 0xFFFF;
        k.valid = rnd() & 15;
        for (s = 0; s < 4; s++)
            if (((k.stage_program >> (s * 5)) & 0x1F) == 3 && (rnd() & 1)) k.cube |= 1u << s;
        k.rc_seen = (i % 8) != 7;
        k.textured = rnd() & 1;
        snprintf(name, sizeof name, "ps_fuzz%03d.wgsl", i);
        put(dir, name, gpu_gen_ps_wgsl(&k, s_buf, sizeof s_buf));
    }
    printf("%d vertex programs, %d combiner shaders -> %s\n", count, count, dir);
    return 0;
}
