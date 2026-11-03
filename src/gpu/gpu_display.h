/*
 * Display options for the native GPU back ends (gpu_d3d11.c, gpu_wgpu.c):
 * internal resolution, MSAA, widescreen, and presenting the back end's own
 * image in the framebuffer window. The browser has the same options as page
 * parameters (web/host/main.js, web/gpu/encoder.js).
 *
 *   RECOMP_RES_SCALE=1|2|3|4|<n>|window
 *       Render targets at n times the guest size (non-integer allowed, 1-8),
 *       or at the size the window shows the frame at ("window": the
 *       letterboxed picture's pixels; follows resizes and fullscreen). The
 *       guest still gets every linear target back at its own size (box
 *       filtered), and the window shows the full-size image through the back
 *       end's own swap chain (gp_display_present_*). 1 = off.
 *   RECOMP_MSAA=0|2|4|8
 *       Multisampled render targets and depth, resolved wherever a target is
 *       read: sampled, copied, written back, presented. 0/1 = off.
 *   RECOMP_WIDESCREEN=1
 *       The title is told the TV is 16:9 (kernel_xbox.c) and renders
 *       anamorphic; the frame is presented at 16:9. With a scale above 1
 *       the internal width also grows by 4/3, so pixels stay square.
 *
 * With RECOMP_RES_SCALE unset or 1 and RECOMP_MSAA unset or off, nothing
 * here changes what the back ends do. RECOMP_GPU_CHECK forces both off (the
 * check compares guest-sized pictures).
 */
#ifndef ATV2_GPU_DISPLAY_H
#define ATV2_GPU_DISPLAY_H
#include <stdint.h>

typedef struct {
    int   window;          /* scale follows the window */
    float scale;           /* fixed scale (vertical); 1 = off */
    int   msaa;            /* sample count, 1 = off */
    int   widescreen;      /* 16:9 display */
    int   active;          /* any of the above changes the back end's work */
    int   present;         /* the back end presents (scale != 1 or window) */
} GpDisplay;

const GpDisplay *gp_display(void);

/* Per-axis scale for a guest 640x480 frame: fixed, or for "window" the
 * letterboxed picture inside a cw x ch client area (cw = 0: not known yet,
 * scale 1). Clamped to 1..8. */
void gp_display_scale_for(uint32_t cw, uint32_t ch, float *sx, float *sy);

/* A target dimension at a scale: the guest size when the scale is 1. */
static inline uint32_t gp_scaled(uint32_t v, float s)
{
    return s == 1.0f ? v : (uint32_t)((float)v * s + 0.5f);
}

/* Registers the active back end as the window's presenter when scaled
 * (called from atv2_gpu_backend_install). */
void gp_display_install(void);

/* The back ends' presenters (gp_display_install picks one). */
int gp_d3d11_present_frame(void *hwnd, uint32_t fb_va, uint32_t aw, uint32_t ah);
int gp_d3d11_present_pixels(void *hwnd, const uint32_t *px, uint32_t w, uint32_t h,
                            uint32_t aw, uint32_t ah);
int gp_wgpu_present_frame(void *hwnd, uint32_t fb_va, uint32_t aw, uint32_t ah);
int gp_wgpu_present_pixels(void *hwnd, const uint32_t *px, uint32_t w, uint32_t h,
                           uint32_t aw, uint32_t ah);
int gp_backend_is_wgpu(void);   /* gpu_wgsl_tap.c: RECOMP_GPU_BACKEND=wgpu */

/* RECOMP_HIRES_DUMP=<file.bmp>: the presented image, every
 * RECOMP_HIRES_DUMP_EVERY presents (default 60), at its full size. */
void gp_display_dump_bgra(const uint8_t *px, uint32_t pitch, uint32_t w, uint32_t h);
int  gp_display_dump_due(void);

#endif
