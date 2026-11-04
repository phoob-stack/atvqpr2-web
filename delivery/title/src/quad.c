/* quad.c - the placeholder title's simulation: a box "quad" driving on a flat
 * track. Our own code, no relation to any game's code or data.
 *
 * Built with wasi-sdk's clang for plain wasm32 (no libc, no WASI imports), so
 * the browser instantiates it with an empty import object:
 *   clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export-dynamic
 *
 * The page owns rendering (canvas 2D); this module owns the car physics, the
 * track (loaded from meshes/track.bin), lap timing and the mesh transform
 * used to draw every box (meshes/quad.bin).
 */
#include <stdint.h>

#define EXPORT __attribute__((visibility("default")))

/* ---- tiny math (no libm) --------------------------------------------------- */
static const float PI = 3.14159265358979f;
static float wrap_pi(float a) {
  while (a > PI) a -= 2 * PI;
  while (a < -PI) a += 2 * PI;
  return a;
}
static float fsin(float x) {          /* |error| < 2e-4 on [-pi, pi] */
  x = wrap_pi(x);
  float b = 4 / PI, c = -4 / (PI * PI);
  float y = b * x + c * x * (x < 0 ? -x : x);
  return 0.225f * (y * (y < 0 ? -y : y) - y) + y;
}
static float fcos(float x) { return fsin(x + PI / 2); }
static float fsqrt(float x) { return __builtin_sqrtf(x); }
static float fabs_(float x) { return x < 0 ? -x : x; }
static float clamp(float x, float lo, float hi) { return x < lo ? lo : x > hi ? hi : x; }

/* ---- heap: a bump allocator the page uses to pass asset bytes in ---------- */
extern unsigned char __heap_base;
static uintptr_t heap_top = 0;
EXPORT void *alloc(uint32_t n) {
  if (!heap_top) heap_top = (uintptr_t)&__heap_base;
  uintptr_t p = (heap_top + 15) & ~(uintptr_t)15;
  uintptr_t end = p + n;
  uintptr_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (end > have) {
    if (__builtin_wasm_memory_grow(0, (end - have + 65535) / 65536) == (uintptr_t)-1) return 0;
  }
  heap_top = end;
  return (void *)p;
}

/* ---- track: meshes/track.bin -----------------------------------------------
 *   u32 magic 'DTRK', u32 version 1, u32 n, f32 width, n x (f32 x, f32 y)
 * a closed centerline loop. */
#define MAX_PTS 4096
static float tx[MAX_PTS], ty[MAX_PTS], tlen[MAX_PTS + 1];
static int tn = 0;
static float twidth = 8;

EXPORT int track_load(const uint8_t *p, uint32_t len) {
  if (len < 16) return -1;
  const uint32_t *h = (const uint32_t *)p;
  if (h[0] != 0x4B525444u /* "DTRK" */ || h[1] != 1) return -2;
  uint32_t n = h[2];
  if (n < 3 || n > MAX_PTS || 16 + n * 8 > len) return -3;
  twidth = ((const float *)p)[3];
  const float *v = (const float *)(p + 16);
  tn = (int)n;
  tlen[0] = 0;
  for (int i = 0; i < tn; i++) {
    tx[i] = v[2 * i];
    ty[i] = v[2 * i + 1];
  }
  for (int i = 0; i < tn; i++) {
    int j = (i + 1) % tn;
    float dx = tx[j] - tx[i], dy = ty[j] - ty[i];
    tlen[i + 1] = tlen[i] + fsqrt(dx * dx + dy * dy);
  }
  return tn;
}
EXPORT float track_length(void) { return tn ? tlen[tn] : 0; }
EXPORT float track_width(void) { return twidth; }

/* Nearest point on the centerline: distance, and progress along the loop. */
static float nearest(float x, float y, float *progress) {
  float best = 1e30f, prog = 0;
  for (int i = 0; i < tn; i++) {
    int j = (i + 1) % tn;
    float ax = tx[i], ay = ty[i], dx = tx[j] - ax, dy = ty[j] - ay;
    float l2 = dx * dx + dy * dy;
    float t = l2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
    float px = ax + dx * t - x, py = ay + dy * t - y;
    float d2 = px * px + py * py;
    if (d2 < best) { best = d2; prog = tlen[i] + (tlen[i + 1] - tlen[i]) * t; }
  }
  *progress = prog;
  return fsqrt(best);
}

/* ---- the car ------------------------------------------------------------- */
typedef struct {
  float x, y, heading, speed;     /* world units (m), radians, m/s */
  float steer, lap_time, best_lap, progress;
  float off_track, dist_to_center, last_lap, pad;
  int32_t lap, checkpoints, laps_done, frames;
} Car;
static Car car;

EXPORT Car *state(void) { return &car; }

EXPORT void reset(void) {
  Car z = {0};
  car = z;
  car.best_lap = 0;
  if (tn >= 2) {
    car.x = tx[0];
    car.y = ty[0];
    float dx = tx[1] - tx[0], dy = ty[1] - ty[0];
    float l = fsqrt(dx * dx + dy * dy);
    float c = dx / l, s = dy / l, a = 0;
    /* coarse search then refine (no atan2 in a libc-free build) */
    float bestd = 1e9f;
    for (int i = 0; i < 360; i++) {
      float t = -PI + i * (2 * PI / 360);
      float d = (fcos(t) - c) * (fcos(t) - c) + (fsin(t) - s) * (fsin(t) - s);
      if (d < bestd) { bestd = d; a = t; }
    }
    car.heading = a;
  }
}

/* throttle -1..1 (negative = brake/reverse), steer -1..1 (positive = left) */
EXPORT void step(float dt, float throttle, float steer) {
  if (dt > 0.05f) dt = 0.05f;
  float prog;
  float d = tn ? nearest(car.x, car.y, &prog) : 0;
  car.dist_to_center = d;
  car.off_track = d > twidth * 0.5f ? 1.0f : 0.0f;
  float max_speed = car.off_track ? 9 : 26;
  float accel = throttle > 0 ? 14 * throttle : 22 * throttle;
  car.speed += accel * dt;
  car.speed -= car.speed * (car.off_track ? 1.6f : 0.35f) * dt;   /* drag */
  car.speed = clamp(car.speed, -6, max_speed);
  car.steer += (clamp(steer, -1, 1) - car.steer) * clamp(dt * 8, 0, 1);
  float turn = car.steer * 2.2f * clamp(fabs_(car.speed) / 6, 0, 1) / (1 + fabs_(car.speed) * 0.04f);
  car.heading = wrap_pi(car.heading + turn * dt * (car.speed < 0 ? -1 : 1));
  car.x += fcos(car.heading) * car.speed * dt;
  car.y += fsin(car.heading) * car.speed * dt;
  car.lap_time += dt;
  car.frames++;
  if (tn) {
    float L = tlen[tn];
    /* checkpoints at each quarter; a lap needs all four in order */
    int q = (int)(prog / L * 4);
    if (q == (car.checkpoints & 3) + 1 && q < 4) car.checkpoints++;
    if (car.checkpoints >= 3 && prog < L * 0.1f && car.progress > L * 0.9f) {
      car.laps_done++;
      car.last_lap = car.lap_time;
      if (car.best_lap == 0 || car.lap_time < car.best_lap) car.best_lap = car.lap_time;
      car.lap_time = 0;
      car.checkpoints = 0;
    }
    car.progress = prog;
  }
}

/* Teleport (test aid and respawn). */
EXPORT void place(float x, float y, float heading) {
  car.x = x; car.y = y; car.heading = heading; car.speed = 0;
}

/* ---- meshes/quad.bin transform ------------------------------------------
 * in: n vertices (f32 x, y, z) in the box's own frame (x forward, y left,
 * z up); out: n x (f32 sx, sy, depth) in camera pixels. The camera looks down
 * at the car with a tilt: z lifts a vertex towards the top of the screen. */
EXPORT void mesh_xform(const float *in, float *out, int n, float px, float py, float heading,
                       float camx, float camy, float camrot, float scale, float tilt) {
  float ch = fcos(heading), sh = fsin(heading), cr = fcos(camrot), sr = fsin(camrot);
  for (int i = 0; i < n; i++) {
    float lx = in[3 * i], ly = in[3 * i + 1], lz = in[3 * i + 2];
    float wx = px + lx * ch - ly * sh - camx;
    float wy = py + lx * sh + ly * ch - camy;
    /* rotate world into the camera (camera "up" on screen = -y) */
    float cx = wx * cr - wy * sr;
    float cy = wx * sr + wy * cr;
    out[3 * i] = cx * scale;
    out[3 * i + 1] = cy * scale - lz * scale * tilt;
    out[3 * i + 2] = cy + lz * 2.0f;
  }
}

EXPORT int version(void) { return 1; }
