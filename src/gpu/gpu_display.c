/*
 * Display options shared by the native GPU back ends: see gpu_display.h.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gpu_display.h"

#ifdef _WIN32
#include "fb_presenter.h"
#endif

static GpDisplay s_d;
static int s_init;

const GpDisplay *gp_display(void)
{
    const char *e;
    if (s_init) return &s_d;
    s_init = 1;
    s_d.scale = 1.0f;
    s_d.msaa = 1;
    if ((e = getenv("RECOMP_RES_SCALE")) && *e) {
        if (!strcmp(e, "window") || !strcmp(e, "w")) s_d.window = 1;
        else {
            float v = (float)atof(e);
            if (v >= 1.0f && v <= 8.0f) s_d.scale = v;
            else if (v != 0.0f) fprintf(stderr, "  [DISPLAY] RECOMP_RES_SCALE=%s: 1-8 or window; using 1\n", e);
        }
    }
    if ((e = getenv("RECOMP_MSAA")) && *e) {
        int n = atoi(e);
        s_d.msaa = n >= 8 ? 8 : n >= 4 ? 4 : n >= 2 ? 2 : 1;
    }
    e = getenv("RECOMP_WIDESCREEN");
    s_d.widescreen = e && *e && *e != '0';
    if (getenv("RECOMP_GPU_CHECK") && (s_d.window || s_d.scale != 1.0f || s_d.msaa > 1)) {
        fprintf(stderr, "  [DISPLAY] RECOMP_GPU_CHECK: resolution scale and MSAA off (the check"
                        " compares guest-sized pictures)\n");
        s_d.window = 0; s_d.scale = 1.0f; s_d.msaa = 1;
    }
    s_d.present = s_d.window || s_d.scale != 1.0f;
    s_d.active = s_d.present || s_d.msaa > 1;
    if (s_d.active || s_d.widescreen)
        fprintf(stderr, "  [DISPLAY] internal resolution %s %.2fx, MSAA %dx, %s\n",
                s_d.window ? "window-sized, starting at" : "fixed", s_d.scale, s_d.msaa,
                s_d.widescreen ? "widescreen 16:9" : "4:3");
    return &s_d;
}

void gp_display_scale_for(uint32_t cw, uint32_t ch, float *sx, float *sy)
{
    const GpDisplay *d = gp_display();
    float aw = d->widescreen ? 16.0f : 4.0f, ah = d->widescreen ? 9.0f : 3.0f;
    float h;
    if (!d->window) {
        h = 480.0f * d->scale;
        if (d->scale == 1.0f) { *sx = *sy = 1.0f; return; }
    } else if (!cw || !ch) {
        *sx = *sy = 1.0f;
        return;
    } else {
        /* The letterboxed picture: the largest aw:ah rectangle in the client. */
        h = (float)cw * ah / aw;
        if (h > (float)ch) h = (float)ch;
    }
    /* Height decides; the width follows the display aspect, so a 16:9
     * frame (anamorphic in 640 guest columns) gets square pixels. */
    *sy = h / 480.0f;
    *sx = h * aw / ah / 640.0f;
    if (*sy < 1.0f) *sy = 1.0f;
    if (*sx < 1.0f) *sx = 1.0f;
    if (*sy > 8.0f) *sy = 8.0f;
    if (*sx > 8.0f) *sx = 8.0f;
    /* "window": whole steps of 1/64, so that a few pixels of resize do not
     * rebuild every target. */
    if (d->window) {
        *sx = (float)(int)(*sx * 64.0f + 0.5f) / 64.0f;
        *sy = (float)(int)(*sy * 64.0f + 0.5f) / 64.0f;
    }
}

/* ---- presenting through the framebuffer window --------------------------- */

#ifdef _WIN32
static int pres_frame(void *hwnd, uint32_t fb_va, uint32_t pitch, uint32_t aw, uint32_t ah)
{
    (void)pitch;
#ifdef ATV2_WGPU
    if (gp_backend_is_wgpu()) return gp_wgpu_present_frame(hwnd, fb_va, aw, ah);
#endif
    return gp_d3d11_present_frame(hwnd, fb_va, aw, ah);
}

static int pres_pixels(void *hwnd, const uint32_t *px, uint32_t w, uint32_t h, uint32_t aw, uint32_t ah)
{
#ifdef ATV2_WGPU
    if (gp_backend_is_wgpu()) return gp_wgpu_present_pixels(hwnd, px, w, h, aw, ah);
#endif
    return gp_d3d11_present_pixels(hwnd, px, w, h, aw, ah);
}

static const XboxFbPresenter s_presenter = { pres_frame, pres_pixels };
#endif

void gp_display_install(void)
{
    const GpDisplay *d = gp_display();
#ifdef _WIN32
    if (d->present) {
        xbox_FramebufferWindowSetPresenter(&s_presenter);
        fprintf(stderr, "  [DISPLAY] the GPU back end presents the window (its full-size image)\n");
    }
#else
    (void)d;
#endif
}

/* ---- RECOMP_HIRES_DUMP ---------------------------------------------------- */

int gp_display_dump_due(void)
{
    static const char *path = (const char *)-1;
    static int every, n;
    if (path == (const char *)-1) {
        const char *e = getenv("RECOMP_HIRES_DUMP_EVERY");
        path = getenv("RECOMP_HIRES_DUMP");
        every = e ? atoi(e) : 60;
        if (every < 1) every = 1;
    }
    return path && *path && (++n % every) == 0;
}

void gp_display_dump_bgra(const uint8_t *px, uint32_t pitch, uint32_t w, uint32_t h)
{
    const char *path = getenv("RECOMP_HIRES_DUMP");
    uint32_t row = (w * 3 + 3) & ~3u, img = row * h, total = 54 + img, y, x;
    uint8_t hdr[54], *line;
    char tmp[600];
    FILE *f;
    if (!path || !*path) return;
    snprintf(tmp, sizeof tmp, "%s.tmp", path);
    if (!(f = fopen(tmp, "wb"))) return;
    memset(hdr, 0, sizeof hdr);
    hdr[0] = 'B'; hdr[1] = 'M';
    memcpy(hdr + 2, &total, 4);
    hdr[10] = 54; hdr[14] = 40;
    memcpy(hdr + 18, &w, 4);
    memcpy(hdr + 22, &h, 4);
    hdr[26] = 1; hdr[28] = 24;
    memcpy(hdr + 34, &img, 4);
    fwrite(hdr, 1, sizeof hdr, f);
    line = (uint8_t *)calloc(1, row);
    for (y = 0; line && y < h; y++) {
        const uint8_t *s = px + (size_t)(h - 1 - y) * pitch;
        for (x = 0; x < w; x++) { line[x * 3] = s[x * 4]; line[x * 3 + 1] = s[x * 4 + 1]; line[x * 3 + 2] = s[x * 4 + 2]; }
        fwrite(line, 1, row, f);
    }
    free(line);
    fclose(f);
    remove(path);
    rename(tmp, path);
}
