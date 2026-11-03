#ifndef ATV2_CONTROL_PNG_H
#define ATV2_CONTROL_PNG_H
#include <stdint.h>
/* rows top-down, 3 bytes per pixel in B G R order. 0 on success. */
int atv2_png_write_bgr(const char *path, const uint8_t *bgr, unsigned w,
                       unsigned h, unsigned stride);
#endif
