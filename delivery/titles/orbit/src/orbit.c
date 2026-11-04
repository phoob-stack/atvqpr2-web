// orbit.c - the second test title ("Orbit"): bodies around a central mass,
// integrated with a fixed step. Ours, no libc (--target=wasm32 -nostdlib).
// The page (web/app/orbit.js) calls init() once and step() per frame, and
// reads the positions from bodies() (n x { x, y, vx, vy } as f32).
#define MAX_BODIES 256

typedef struct { float x, y, vx, vy; } Body;
static Body body[MAX_BODIES];
static int count;
static unsigned rng_state;
static int steps;

static float rnd(void) {                       // xorshift32 in [0, 1)
  rng_state ^= rng_state << 13; rng_state ^= rng_state >> 17; rng_state ^= rng_state << 5;
  return (float)(rng_state >> 8) / 16777216.0f;
}

__attribute__((export_name("init"))) int init(int n, unsigned seed) {
  count = n < 1 ? 1 : n > MAX_BODIES ? MAX_BODIES : n;
  rng_state = seed ? seed : 1u;
  steps = 0;
  for (int i = 0; i < count; i++) {
    float r = 0.2f + 0.75f * rnd();
    // a direction without libm: a random vector, normalised
    float cx = rnd() * 2.0f - 1.0f, cy = rnd() * 2.0f - 1.0f;
    float len = __builtin_sqrtf(cx * cx + cy * cy) + 1e-6f;
    cx /= len; cy /= len;
    body[i].x = cx * r; body[i].y = cy * r;
    float v = __builtin_sqrtf(1.0f / r);       // circular speed for GM = 1
    body[i].vx = -cy * v; body[i].vy = cx * v;
  }
  return count;
}

__attribute__((export_name("step"))) int step(float dt) {
  for (int i = 0; i < count; i++) {
    Body *b = &body[i];
    float r2 = b->x * b->x + b->y * b->y + 0.0025f;
    float inv = 1.0f / (r2 * __builtin_sqrtf(r2));
    b->vx -= b->x * inv * dt; b->vy -= b->y * inv * dt;
    b->x += b->vx * dt; b->y += b->vy * dt;
  }
  return ++steps;
}

__attribute__((export_name("bodies"))) Body *bodies(void) { return body; }
__attribute__((export_name("steps"))) int steps_done(void) { return steps; }
