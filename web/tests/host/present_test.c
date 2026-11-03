/*
 * End-to-end check of the browser present path without the game: a small
 * wasm32-wasip1-threads program that loads a frame capture (cap_<n>.gpf,
 * RECOMP_GPU_CAPTURE; WGSL payloads already) through the page's WASI
 * filesystem, hands it over with src/web/web_present.c exactly as the
 * recorder's flip does (GpFrame mailbox, gp_seq, wait for the page's claim),
 * then names the captured reference target as the displayed framebuffer.
 * The page (web/host) draws it with web/gpu/encoder.js on the canvas.
 *
 *   web/tests/host/present-test.sh <captures dir> [cap_<n>.gpf]
 */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <time.h>

#include "gpu_proto.h"
#include "gpu_shadergen_wgsl.h"
#include "web_host.h"

static WebHost s_host = { .magic = WEB_HOST_MAGIC, .version = WEB_HOST_VERSION, .size = sizeof(WebHost) };
WebHost *web_host(void) { return &s_host; }
ptrdiff_t xbox_GetMemoryOffset(void) { return 0; }
const char *gp_wgsl_source(uint32_t id, int is_ps, uint32_t *len) { (void)id; (void)is_ps; (void)len; return NULL; }

__attribute__((import_module("env"), import_name("web_host_ready")))
void web_host_ready(WebHost *h);

void gp_web_consume(const GpFrame *f);
void web_fb_present(uint32_t fb_va, uint32_t pitch, uint32_t aa);

static void sleep_ms(int ms)
{
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

int main(int argc, char **argv)
{
    char path[512] = "";
    FILE *f;
    long n;
    uint8_t *buf;
    const GpCapHeader *h;
    GpFrame fr;
    size_t at;
    uint32_t off, va = 0, pitch = 0, w = 0;
    int i;

    setvbuf(stdout, NULL, _IOLBF, 0);
    web_host_ready(&s_host);
    if (argc > 1)
        snprintf(path, sizeof path, "/game/%s", argv[1]);
    else {
        DIR *d = opendir("/game");
        struct dirent *e;
        while (d && (e = readdir(d)))
            if (strstr(e->d_name, ".gpf")) { snprintf(path, sizeof path, "/game/%s", e->d_name); break; }
        if (d) closedir(d);
    }
    if (!*path || !(f = fopen(path, "rb"))) { printf("present_test: no capture (%s)\n", path); return 1; }
    fseek(f, 0, SEEK_END); n = ftell(f); fseek(f, 0, SEEK_SET);
    buf = (uint8_t *)malloc((size_t)n);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) { printf("present_test: read failed\n"); return 1; }
    fclose(f);
    h = (const GpCapHeader *)buf;
    if (memcmp(&h->magic, "GPF1", 4) || h->layout != GP_WG_LAYOUT) { printf("present_test: not a capture of this layout\n"); return 1; }

#define TAKE(n_) (at += ((size_t)(n_) + 15) & ~(size_t)15, buf + at - (((size_t)(n_) + 15) & ~(size_t)15))
    at = sizeof *h;
    fr.queue = TAKE(h->queue_bytes); fr.queue_bytes = h->queue_bytes;
    fr.draws = (const GpDraw *)TAKE(h->draw_count * sizeof(GpDraw)); fr.draw_count = h->draw_count;
    fr.vtx = TAKE(h->vtx_bytes); fr.vtx_bytes = h->vtx_bytes;
    fr.idx = (const uint32_t *)TAKE(h->idx_count * 4); fr.idx_count = h->idx_count;
    fr.consts = TAKE(h->const_bytes); fr.const_bytes = h->const_bytes;
    fr.frame = h->frame;

    for (off = 0; off + sizeof(GpCmd) <= fr.queue_bytes;) {
        const GpCmd *c = (const GpCmd *)(fr.queue + off);
        if (c->op == GP_RT_CREATE && c->id == h->ref_target) { va = c->a; w = c->b; pitch = c->e; }
        off += (uint32_t)sizeof(GpCmd) + ((c->bytes + 15u) & ~15u);
    }
    printf("present_test: %s frame %u, %u records, queue %u bytes, ref target %u (va %08X, %u wide, pitch %u)\n",
           path, fr.frame, fr.draw_count, fr.queue_bytes, h->ref_target, va, w, pitch);

    for (i = 0; i < 1000 && !__atomic_load_n(&s_host.page_attached, __ATOMIC_SEQ_CST); i++)
        sleep_ms(10);
    printf("present_test: page %s\n", s_host.page_attached ? "attached" : "NOT attached (handing over anyway)");

    gp_web_consume(&fr);                       /* waits for the page's claim */
    printf("present_test: frame claimed: gp_seq %u, gp_claimed %u, dropped %u\n",
           s_host.gp_seq, s_host.gp_claimed, s_host.gp_dropped);
    web_fb_present(va, pitch ? pitch : 640 * 4, 1);
    for (i = 0; i < 120; i++) {                 /* keep showing it for ~2 s */
        sleep_ms(16);
        web_fb_present(va, pitch ? pitch : 640 * 4, 1);
    }
    printf("present_test: done, %u flips\n", s_host.flips);
    return 0;
}
