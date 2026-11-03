/*
 * roam.c -- multiplayer free roam for Free Ride (Freestyle, Unlimited Time,
 * Stadium: Main Event). RECOMP_ROAM=host:port[,name=NAME][,slots=N][,test=1]
 * (work\roam\ROAM-RE.md has the reverse engineering).
 *
 * Model (the nfsu2-web free-roam model):
 *   - each game simulates only its own quad and sends snapshots of it (30 Hz)
 *     to a hub over one WebSocket (native: src/roam_net.c, Winsock; browser:
 *     web/host/roam.js through a shared mailbox);
 *   - remote riders are drawn in extra rider slots the game creates itself:
 *     Freestyle's "set up participants" (state 0x1C04FC slot 1, 0x000B70D0)
 *     asks for 0 AI riders; with roam on it asks for N (BB4B0(N, settings)),
 *     so the stadium load spawns N more rider+ATV units;
 *   - those slots are puppets: their participant (AI controller) runs in
 *     control mode 0 (no AI input), and after the unit's own physics step the
 *     pose from the interpolated snapshot is written over the unit's body
 *     (position, quaternion, matrix, velocities) and its controls (throttle,
 *     steer, brake, lean) -- the racer object, rider animation and wheels
 *     follow the unit as for any rider;
 *   - unused slots are parked under the arena;
 *   - no collisions between players (ghost): the puppets' collision with
 *     other units is switched off (see roam_ghost below).
 *
 * Game objects (default.xbe SHA-256 1E3C2FCE..., ATV Quad Power Racing 2, USA):
 *   racer table   0x1D752C + i*0x18 -> racer R (vt 0x1B03A8), i = 0 local
 *   R+0x478       participant P: vt 0x1B0128 human (update vt+0x30 = 0x28340),
 *                 vt 0x1B0098 AI (update vt+0x30 = 0x27470)
 *   P+0x20        control mode: 0 none, 1 human pad, 2 AI
 *   P+0x3C        unit U (rider + ATV, vt 0x1AF3A8), body at U+0x4C:
 *                 +0x08 pos, +0x14 vel, +0x20 angular vel, +0x2C quat xyzw,
 *                 +0x3C 3x3 matrix (rows: right, up, forward)
 *   U+0x2C8.. controls written by SetControls (0x1C150): +0x2C8 throttle,
 *                 +0x2CC steer, +0x2D0 brake, +0x7EC lean
 *
 * Off (no RECOMP_ROAM): nothing here runs but one flag test per indirect call
 * and per flip.
 */
#if defined(_WIN32)
#include <windows.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <time.h>

#include "recomp/gen/recomp_types.h"
#include "roam.h"
#include "roam_font.h"

#if defined(_MSC_VER)
#define strtok_r strtok_s
#endif

void sub_000BB4B0(void);
static void labels_update(void);
static float s_dbg_xs, s_dbg_z; static int s_dbg_n;
void sub_00027470(void);
void sub_00028340(void);

/* ---- addresses ------------------------------------------------------------ */

#define RT_TABLE        0x001D752Cu
#define RT_STRIDE       0x18u
#define RT_MAX          8
#define SETTINGS        0x001D8620u
#define GAMEMODE        (SETTINGS + 0x5C)   /* 4 = freestyle */
#define RACE_TIME       0x001DA05Cu
#define VT_RACER        0x001B03A8u
#define VT_UNIT         0x001AF3A8u
#define VT_PART_HUMAN   0x001B0128u
#define VT_PART_AI      0x001B0098u
#define FN_SETUP_FS     0x000B70D0u   /* freestyle: BB4B0(0, settings)          */
#define FN_PART_AI      0x00027470u   /* participant update (AI / base)         */
#define FN_PART_HUMAN   0x00028340u   /* participant update (human)             */

#define B_POS   0x54u   /* U + 0x4C + 0x08 */
#define B_VEL   0x60u
#define B_AVEL  0x6Cu
#define B_QUAT  0x78u
#define B_MAT   0x88u

/* ---- state ---------------------------------------------------------------- */

volatile int atv2_roam_hook;      /* read by recomp_lookup_manual        */
volatile int atv2_roam_on;        /* read by rec_flip                    */
static int  s_checked;            /* 1 ok, -1 not this exe               */
static int  s_slots = 3;          /* puppet slots asked for              */
static int  s_test;               /* test=1: echo own snapshots as a remote */
static char s_name[24] = "PLAYER";
static char s_addr[64];

RoamMailbox atv2_roam_mb;

static double now_ms(void)
{
#if defined(_WIN32)
    static LARGE_INTEGER f, t0;
    LARGE_INTEGER t;
    if (!f.QuadPart) { QueryPerformanceFrequency(&f); QueryPerformanceCounter(&t0); }
    QueryPerformanceCounter(&t);
    return (double)(t.QuadPart - t0.QuadPart) * 1000.0 / (double)f.QuadPart;
#else
    static double t0 = -1;
    struct timespec ts;
    double v;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    v = ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
    if (t0 < 0) t0 = v;
    return v - t0;
#endif
}

#define RAM_OK(va) ((va) >= 0x10000u && (va) < 0x04000000u)
static uint32_t rd32(uint32_t va) { return RAM_OK(va) ? MEM32(va) : 0; }
static float rdf(uint32_t va) { uint32_t u = rd32(va); float f; memcpy(&f, &u, 4); return f; }
static void wrf(uint32_t va, float f) { uint32_t u; memcpy(&u, &f, 4); if (RAM_OK(va)) MEM32(va) = u; }
static void rdv(uint32_t va, float *v, int n) { int i; for (i = 0; i < n; i++) v[i] = rdf(va + 4 * i); }
static void wrv(uint32_t va, const float *v, int n) { int i; for (i = 0; i < n; i++) wrf(va + 4 * i, v[i]); }

/* ---- mailbox (game side) ---------------------------------------------------
 * SPSC byte rings: [u16 len][u8 kind][payload]. out: game -> transport,
 * in: transport -> game. */

static int ring_put(volatile uint8_t *buf, uint32_t cap, volatile uint32_t *head,
                    volatile uint32_t *tail, int kind, const void *p, uint32_t n)
{
    uint32_t h = *head, t = *tail, used = h - t, i;
    uint8_t hdr[3];
    if (n > 0xFFFFu || used + 3 + n > cap)
        return 0;
    hdr[0] = (uint8_t)n; hdr[1] = (uint8_t)(n >> 8); hdr[2] = (uint8_t)kind;
    for (i = 0; i < 3; i++) buf[(h + i) % cap] = hdr[i];
    for (i = 0; i < n; i++) buf[(h + 3 + i) % cap] = ((const uint8_t *)p)[i];
#if defined(_WIN32)
    MemoryBarrier();
#else
    __sync_synchronize();
#endif
    *head = h + 3 + n;
    return 1;
}

static int ring_get(volatile uint8_t *buf, uint32_t cap, volatile uint32_t *head,
                    volatile uint32_t *tail, int *kind, uint8_t *p, uint32_t max)
{
    uint32_t h = *head, t = *tail, n, i;
    if (h == t)
        return -1;
#if defined(_WIN32)
    MemoryBarrier();
#else
    __sync_synchronize();
#endif
    n = buf[t % cap] | (buf[(t + 1) % cap] << 8);
    *kind = buf[(t + 2) % cap];
    for (i = 0; i < n && i < max; i++) p[i] = buf[(t + 3 + i) % cap];
    *tail = t + 3 + n;
    return (int)(n < max ? n : max);
}

int atv2_roam_out_put(int kind, const void *p, unsigned n)
{
    RoamMailbox *m = &atv2_roam_mb;
    return ring_put(m->out, ROAM_OUT_CAP, &m->out_head, &m->out_tail, kind, p, n);
}
int atv2_roam_out_get(int *kind, uint8_t *p, unsigned max)
{
    RoamMailbox *m = &atv2_roam_mb;
    return ring_get(m->out, ROAM_OUT_CAP, &m->out_head, &m->out_tail, kind, p, max);
}
int atv2_roam_in_put(int kind, const void *p, unsigned n)
{
    RoamMailbox *m = &atv2_roam_mb;
    return ring_put(m->in, ROAM_IN_CAP, &m->in_head, &m->in_tail, kind, p, n);
}
static int in_get(int *kind, uint8_t *p, unsigned max)
{
    RoamMailbox *m = &atv2_roam_mb;
    return ring_get(m->in, ROAM_IN_CAP, &m->in_head, &m->in_tail, kind, p, max);
}

/* ---- snapshots -------------------------------------------------------------- */

typedef struct {
    double t;              /* sender ms */
    float pos[3], q[4], vel[3], avel[3];
    float ctl[4];          /* throttle, steer, brake, lean */
} Snap;

#define SNAP_BYTES 52
/* wire: u32 seq, u32 t_ms, f32 pos[3], i16 q[4], f32 vel[3], i16 avel[3],
 * i8 throttle, steer, brake, lean, u8 flags, u8 pad -> 4+4+12+8+12+6+4+2 = 52 */

static void put16(uint8_t *p, int v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void put32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }
static uint32_t get32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
static int get16s(const uint8_t *p) { return (int16_t)(p[0] | (p[1] << 8)); }
static int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
static float getf(const uint8_t *p) { uint32_t u = get32(p); float f; memcpy(&f, &u, 4); return f; }
static void putf(uint8_t *p, float f) { uint32_t u; memcpy(&u, &f, 4); put32(p, u); }

static void snap_encode(uint8_t *o, uint32_t seq, const Snap *s)
{
    int i;
    put32(o, seq); put32(o + 4, (uint32_t)(int64_t)s->t);
    for (i = 0; i < 3; i++) putf(o + 8 + 4 * i, s->pos[i]);
    for (i = 0; i < 4; i++) put16(o + 20 + 2 * i, clampi((int)lrintf(s->q[i] * 32767.0f), -32767, 32767));
    for (i = 0; i < 3; i++) putf(o + 28 + 4 * i, s->vel[i]);
    for (i = 0; i < 3; i++) put16(o + 40 + 2 * i, clampi((int)lrintf(s->avel[i] * 1000.0f), -32767, 32767));
    for (i = 0; i < 4; i++) o[46 + i] = (uint8_t)(int8_t)clampi((int)lrintf(s->ctl[i] * 127.0f), -127, 127);
    o[50] = 0; o[51] = 0;
}

static void snap_decode(const uint8_t *o, uint32_t *seq, Snap *s)
{
    int i;
    float n = 0;
    *seq = get32(o);
    s->t = (double)get32(o + 4);
    for (i = 0; i < 3; i++) s->pos[i] = getf(o + 8 + 4 * i);
    for (i = 0; i < 4; i++) { s->q[i] = get16s(o + 20 + 2 * i) / 32767.0f; n += s->q[i] * s->q[i]; }
    n = n > 0 ? 1.0f / sqrtf(n) : 1.0f;
    for (i = 0; i < 4; i++) s->q[i] *= n;
    for (i = 0; i < 3; i++) s->vel[i] = getf(o + 28 + 4 * i);
    for (i = 0; i < 3; i++) s->avel[i] = get16s(o + 40 + 2 * i) / 1000.0f;
    for (i = 0; i < 4; i++) s->ctl[i] = (int8_t)o[46 + i] / 127.0f;
}

/* quaternion (x, y, z, w) -> the body's row matrix. The convention is checked
 * against the local body at the first capture (s_qconv). */
static int s_qconv = 0;   /* 0 = rows of R(q), 1 = transposed */
static void quat_to_mat(const float *q, float *m)
{
    float x = q[0], y = q[1], z = q[2], w = q[3];
    float r[9] = {
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z),     2 * (x * z + w * y),
        2 * (x * y + w * z),     1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y),     2 * (y * z + w * x),     1 - 2 * (x * x + y * y) };
    int i, j;
    for (i = 0; i < 3; i++)
        for (j = 0; j < 3; j++)
            m[i * 3 + j] = s_qconv ? r[j * 3 + i] : r[i * 3 + j];
}

static void slerp(const float *a, const float *b0, float t, float *o)
{
    float b[4], d = a[0] * b0[0] + a[1] * b0[1] + a[2] * b0[2] + a[3] * b0[3], s0, s1, n = 0;
    int i;
    for (i = 0; i < 4; i++) b[i] = d < 0 ? -b0[i] : b0[i];
    d = fabsf(d);
    if (d > 0.9995f) { s0 = 1 - t; s1 = t; }
    else {
        float th = acosf(d), sn = sinf(th);
        s0 = sinf((1 - t) * th) / sn; s1 = sinf(t * th) / sn;
    }
    for (i = 0; i < 4; i++) { o[i] = s0 * a[i] + s1 * b[i]; n += o[i] * o[i]; }
    n = 1.0f / sqrtf(n);
    for (i = 0; i < 4; i++) o[i] *= n;
}

/* q' = q + 0.5 * (0, w) * q * dt  (world angular velocity) */
static void quat_integrate(const float *q, const float *w, float dt, float *o)
{
    float x = q[0], y = q[1], z = q[2], qw = q[3], n = 0;
    int i;
    o[0] = x + 0.5f * dt * ( w[0] * qw + w[1] * z - w[2] * y);
    o[1] = y + 0.5f * dt * ( w[1] * qw + w[2] * x - w[0] * z);
    o[2] = z + 0.5f * dt * ( w[2] * qw + w[0] * y - w[1] * x);
    o[3] = qw + 0.5f * dt * (-w[0] * x - w[1] * y - w[2] * z);
    for (i = 0; i < 4; i++) n += o[i] * o[i];
    n = 1.0f / sqrtf(n);
    for (i = 0; i < 4; i++) o[i] *= n;
}

/* ---- remote players ----------------------------------------------------------- */

#define MAXP     16
#define JB       32
typedef struct {
    int      used, id, slot;          /* slot: racer index 1..N, 0 none */
    char     name[24];
    Snap     buf[JB];                 /* ring by arrival, ordered by t */
    int      n, head;
    uint32_t last_seq;
    double   off_min, jit;            /* recv_local - t_remote: min, spread EMA */
    double   off_t;                   /* when off_min was last lowered */
    double   last_recv;
    double   interval;                /* EMA of snapshot spacing (ms) */
    uint32_t got, lost, late;
    uint32_t n_interp, n_extrap;      /* ticks shown interpolated / extrapolated */
    double   delay;
    int      shown;
    float    lastpos[3];
} Remote;

static Remote s_rem[MAXP];
static int    s_my_id = -1;
static char   s_resume[40];
static int    s_connected;
static uint32_t s_seq;
static int    s_tick;
static double s_sent_bytes, s_recv_bytes, s_stat_t0;
static uint32_t s_sent_snaps, s_recv_snaps;
static double s_delay_ms = 100;      /* reported */

static Remote *rem_find(int id, int make)
{
    int i;
    for (i = 0; i < MAXP; i++)
        if (s_rem[i].used && s_rem[i].id == id)
            return &s_rem[i];
    if (!make)
        return NULL;
    for (i = 0; i < MAXP; i++)
        if (!s_rem[i].used) {
            memset(&s_rem[i], 0, sizeof s_rem[i]);
            s_rem[i].used = 1; s_rem[i].id = id; s_rem[i].off_min = 1e18; s_rem[i].interval = 33;
            snprintf(s_rem[i].name, sizeof s_rem[i].name, "P%d", id);
            return &s_rem[i];
        }
    return NULL;
}

static int slot_taken(int slot)
{
    int i;
    for (i = 0; i < MAXP; i++)
        if (s_rem[i].used && s_rem[i].slot == slot)
            return 1;
    return 0;
}

static void rem_assign(Remote *r)
{
    int s;
    if (r->slot)
        return;
    for (s = 1; s <= s_slots && s < RT_MAX; s++)
        if (!slot_taken(s)) { r->slot = s; break; }
    fprintf(stderr, "[ROAM] %s (id %d) -> %s\n", r->name, r->id,
            r->slot ? "rider slot" : "no free slot (more players than slots)");
    if (r->slot) fprintf(stderr, "[ROAM]   slot %d\n", r->slot);
    fflush(stderr);
}

static void rem_drop(Remote *r, const char *why)
{
    fprintf(stderr, "[ROAM] %s (id %d) left (%s): %u snapshots, %u lost, %u late\n",
            r->name, r->id, why, r->got, r->lost, r->late);
    fflush(stderr);
    r->used = 0;
    r->slot = 0;
}

static void rem_push(Remote *r, const Snap *s, uint32_t seq, double recv)
{
    double off = recv - s->t;
    int i, at;
    r->got++;
    if (r->got > 1 && seq != r->last_seq + 1 && (int32_t)(seq - r->last_seq) > 0)
        r->lost += seq - r->last_seq - 1;
    if (r->got > 1 && (int32_t)(seq - r->last_seq) <= 0) {   /* out of order: insert anyway */
        r->late++;
        if (r->lost) r->lost--;           /* counted as lost when the gap opened */
    } else {
        if (r->got > 1) {
            double gap = s->t - r->buf[(r->head + JB - 1) % JB].t;
            if (gap > 0 && gap < 500) r->interval += (gap - r->interval) * 0.1;
        }
        r->last_seq = seq;
    }
    /* clock offset: the lowest seen (fastest path), drifting up slowly so a
     * clock skew or route change is followed */
    if (off < r->off_min || recv - r->off_t > 4000) { r->off_min = off; r->off_t = recv; }
    r->jit += ((off - r->off_min) - r->jit) * 0.05;
    r->last_recv = recv;
    /* insert ordered by t */
    if (r->n < JB) r->n++;
    at = r->head;
    r->buf[at] = *s;
    r->head = (r->head + 1) % JB;
    for (i = 0; i < r->n - 1; i++) {
        int a = (at + JB - 1) % JB;
        if (r->buf[a].t <= r->buf[at].t) break;
        { Snap t = r->buf[a]; r->buf[a] = r->buf[at]; r->buf[at] = t; }
        at = a;
    }
}

/* Pose at remote time T: interpolate, else extrapolate (<= 250 ms), else hold. */
static int rem_sample(Remote *r, double T, Snap *o)
{
    int i, k;
    const Snap *a = NULL, *b = NULL, *newest, *oldest;
    if (!r->n)
        return 0;
    newest = &r->buf[(r->head + JB - 1) % JB];
    oldest = &r->buf[(r->head + JB - r->n) % JB];
    if (T <= oldest->t) { *o = *oldest; return 1; }
    for (k = 0; k < r->n - 1; k++) {
        const Snap *x = &r->buf[(r->head + JB - r->n + k) % JB];
        const Snap *y = &r->buf[(r->head + JB - r->n + k + 1) % JB];
        if (x->t <= T && T <= y->t) { a = x; b = y; break; }
    }
    if (a && b && b->t > a->t) {
        float u = (float)((T - a->t) / (b->t - a->t));
        double dt = (b->t - a->t) / 1000.0;
        /* position: cubic Hermite with the velocities (smooth through jumps) */
        float u2 = u * u, u3 = u2 * u;
        float h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
        for (i = 0; i < 3; i++) {
            o->pos[i] = h00 * a->pos[i] + h10 * (float)dt * a->vel[i] + h01 * b->pos[i] + h11 * (float)dt * b->vel[i];
            o->vel[i] = a->vel[i] + (b->vel[i] - a->vel[i]) * u;
            o->avel[i] = a->avel[i] + (b->avel[i] - a->avel[i]) * u;
        }
        for (i = 0; i < 4; i++) o->ctl[i] = a->ctl[i] + (b->ctl[i] - a->ctl[i]) * u;
        slerp(a->q, b->q, u, o->q);
        o->t = T;
        return 1;
    }
    /* past the newest: extrapolate for short gaps */
    {
        double ex = (T - newest->t) / 1000.0;
        if (ex > 0.25) ex = 0.25;
        *o = *newest;
        for (i = 0; i < 3; i++) o->pos[i] = newest->pos[i] + newest->vel[i] * (float)ex;
        quat_integrate(newest->q, newest->avel, (float)ex, o->q);
        o->t = T;
        return 2;
    }
}

/* ---- game objects --------------------------------------------------------------- */

static uint32_t racer(int i) { return rd32(RT_TABLE + (uint32_t)i * RT_STRIDE); }
static uint32_t racer_part(uint32_t r) { return r && rd32(r) == VT_RACER ? rd32(r + 0x478) : 0; }
static uint32_t part_unit(uint32_t p) { uint32_t u = p ? rd32(p + 0x3C) : 0; return u && rd32(u) == VT_UNIT ? u : 0; }

static int exe_ok(void)
{
    return rd32(0x001C04FCu + 4) == FN_SETUP_FS &&
           rd32(VT_PART_AI + 0x30) == FN_PART_AI &&
           rd32(VT_PART_HUMAN + 0x30) == FN_PART_HUMAN &&
           rd32(VT_UNIT) == 0x0001FD50u && rd32(VT_RACER) == 0x0002F170u &&
           rd32(0x001C0500u) == FN_SETUP_FS;
}

static void capture(uint32_t u, Snap *s)
{
    rdv(u + B_POS, s->pos, 3);
    rdv(u + B_QUAT, s->q, 4);
    rdv(u + B_VEL, s->vel, 3);
    rdv(u + B_AVEL, s->avel, 3);
    s->ctl[0] = rdf(u + 0x2C8);
    s->ctl[1] = rdf(u + 0x2CC);
    s->ctl[2] = rdf(u + 0x2D0);
    s->ctl[3] = rdf(u + 0x7EC);
}

static void apply(uint32_t u, const Snap *s)
{
    float m[9];
    quat_to_mat(s->q, m);
    wrv(u + B_POS, s->pos, 3);
    wrv(u + B_QUAT, s->q, 4);
    wrv(u + B_MAT, m, 9);
    wrv(u + B_VEL, s->vel, 3);
    wrv(u + B_AVEL, s->avel, 3);
    wrf(u + 0x2C8, s->ctl[0]);
    wrf(u + 0x2CC, s->ctl[1]);
    wrf(u + 0x2D0, s->ctl[2]);
    wrf(u + 0x7EC, s->ctl[3]);
}

/* Parked slot: below the arena floor, still. */
static void park(uint32_t u, int slot)
{
    static const float q[4] = {0, 0, 0, 1}, z[3] = {0, 0, 0};
    float p[3] = {40.0f + slot * 6.0f, -200.0f, -270.0f}, m[9];
    quat_to_mat(q, m);
    wrv(u + B_POS, p, 3);
    wrv(u + B_QUAT, q, 4);
    wrv(u + B_MAT, m, 9);
    wrv(u + B_VEL, z, 3);
    wrv(u + B_AVEL, z, 3);
}

static int s_qchecked;
static void check_quat_convention(uint32_t u)
{
    float q[4], m[9], g[9], e0 = 0, e1 = 0;
    int i;
    rdv(u + B_QUAT, q, 4);
    rdv(u + B_MAT, g, 9);
    s_qconv = 0; quat_to_mat(q, m);
    for (i = 0; i < 9; i++) e0 += fabsf(m[i] - g[i]);
    s_qconv = 1; quat_to_mat(q, m);
    for (i = 0; i < 9; i++) e1 += fabsf(m[i] - g[i]);
    s_qconv = e1 < e0;
    fprintf(stderr, "[ROAM] body quaternion -> matrix: error %.4f as rows, %.4f transposed: using %s\n",
            e0, e1, s_qconv ? "transposed" : "rows");
    fflush(stderr);
    s_qchecked = 1;
}

/* ---- control messages (JSON text, flat objects from our own hub) ---------------- */

static int json_str(const char *j, const char *key, char *out, int max)
{
    char pat[32];
    const char *p;
    int n = 0;
    snprintf(pat, sizeof pat, "\"%s\":\"", key);
    p = strstr(j, pat);
    if (!p) return 0;
    p += strlen(pat);
    while (*p && *p != '"' && n < max - 1) {
        if (*p == '\\' && p[1]) p++;
        out[n++] = *p++;
    }
    out[n] = 0;
    return 1;
}

static int json_int(const char *j, const char *key, int def)
{
    char pat[32];
    const char *p;
    snprintf(pat, sizeof pat, "\"%s\":", key);
    p = strstr(j, pat);
    return p ? atoi(p + strlen(pat)) : def;
}

static void send_hello(void)
{
    char msg[200];
    int n = snprintf(msg, sizeof msg, "{\"t\":\"hello\",\"v\":1,\"room\":\"freeride\",\"name\":\"%s\",\"resume\":\"%s\",\"client\":\"%s\"}",
                     s_name, s_resume,
#if defined(__wasm__)
                     "wasm"
#else
                     "native"
#endif
                     );
    atv2_roam_out_put(ROAM_KIND_TEXT, msg, (unsigned)n);
}

static void on_text(const char *j)
{
    char t[16] = "", name[24] = "";
    Remote *r;
    int id;
    json_str(j, "t", t, sizeof t);
    id = json_int(j, "id", -1);
    if (!strcmp(t, "welcome")) {
        s_my_id = id;
        json_str(j, "resume", s_resume, sizeof s_resume);
        fprintf(stderr, "[ROAM] joined the hub as id %d (%s)%s\n", id, s_name,
                json_int(j, "resumed", 0) ? ", resumed" : "");
    } else if (!strcmp(t, "join") && id >= 0 && id != s_my_id) {
        r = rem_find(id, 1);
        if (r) {
            if (json_str(j, "name", name, sizeof name)) snprintf(r->name, sizeof r->name, "%s", name);
            fprintf(stderr, "[ROAM] %s (id %d) joined\n", r->name, id);
            rem_assign(r);
        }
    } else if (!strcmp(t, "leave")) {
        r = rem_find(id, 0);
        if (r) rem_drop(r, "hub");
    } else if (!strcmp(t, "name")) {
        r = rem_find(id, 0);
        if (r && json_str(j, "name", name, sizeof name)) snprintf(r->name, sizeof r->name, "%s", name);
    }
    fflush(stderr);
}

/* binary: [u8 type=1][u8 src][u8 dst][u8 count] { [u8 src][u8 len][len bytes] } */
static void on_binary(const uint8_t *p, int n, double now)
{
    int i, count, at = 4;
    if (n < 4 || p[0] != 1)
        return;
    count = p[3];
    for (i = 0; i < count && at + 2 <= n; i++) {
        int src = p[at], len = p[at + 1];
        if (at + 2 + len > n) break;
        if (len >= SNAP_BYTES && src != s_my_id) {
            Remote *r = rem_find(src, 1);
            if (r) {
                Snap s;
                uint32_t seq;
                snap_decode(p + at + 2, &seq, &s);
                if (!r->slot) rem_assign(r);
                rem_push(r, &s, seq, now);
                s_recv_snaps++;
            }
        }
        at += 2 + len;
    }
}

static void pump_in(double now)
{
    static uint8_t buf[0x10000];
    int kind, n;
    while ((n = in_get(&kind, buf, sizeof buf - 1)) >= 0) {
        s_recv_bytes += n;
        if (kind == ROAM_KIND_EVENT) {
            buf[n] = 0;
            if (!strcmp((char *)buf, "open")) {
                s_connected = 1;
                fprintf(stderr, "[ROAM] connected to %s\n", s_addr);
                send_hello();
            } else if (!strcmp((char *)buf, "close")) {
                if (s_connected)
                    fprintf(stderr, "[ROAM] connection lost; reconnecting (resume token kept)\n");
                s_connected = 0;
            }
            fflush(stderr);
        } else if (kind == ROAM_KIND_TEXT) {
            buf[n] = 0;
            on_text((char *)buf);
        } else if (kind == ROAM_KIND_BINARY) {
            on_binary(buf, n, now);
        }
    }
}

/* ---- ghost: no collisions with the puppets -------------------------------------------
 * The broadphase (0x709B0) calls a pair handler from the table at 0x1CBEF0
 * (cdecl handler(colliderA, colliderB) -> contacts) for every pair of active
 * objects whose boxes overlap; the call returns to 0x70B17. Pairs where one
 * side is a puppet's racer or unit collider (object +0x1C) are skipped. */
#define RET_PAIR 0x00070B17u
static uint32_t s_ghost[2 * RT_MAX];
static int s_nghost;

static void ghost_refresh(void)
{
    int i, n = 0;
    for (i = 1; i <= s_slots && i < RT_MAX; i++) {
        uint32_t r = racer(i), u = part_unit(racer_part(r));
        if (!r || !u) break;
        s_ghost[n++] = rd32(r + 0x1C);
        s_ghost[n++] = rd32(u + 0x1C);
    }
    s_nghost = n;
}

static int is_ghost(uint32_t c)
{
    int i;
    for (i = 0; i < s_nghost; i++)
        if (s_ghost[i] == c && c) return 1;
    return 0;
}

static uint32_t s_ghost_skips;
static void skip_pair(void)
{
    g_eax = 0;
    g_esp += 4;
    s_ghost_skips++;
}

/* ---- per tick (game thread) --------------------------------------------------------- */

static double s_last_tick;

/* Local rider: after its own participant update (physics step), capture and
 * send at 30 Hz. In test mode the snapshot is also echoed as remote id 99. */
static void local_tick(uint32_t r0)
{
    uint32_t u = part_unit(racer_part(r0));
    double now = now_ms();
    Snap s;
    uint8_t pkt[4 + 2 + SNAP_BYTES];

    pump_in(now);
    ghost_refresh();
    labels_update();
    if (!u)
        return;
    if (!s_qchecked)
        check_quat_convention(u);
    if (++s_tick & 1)
        return;                      /* 60 Hz ticks -> 30 Hz snapshots */
    capture(u, &s);
    s.t = now;
    pkt[0] = 1; pkt[1] = 0; pkt[2] = 255; pkt[3] = 1;
    pkt[4] = 0; pkt[5] = SNAP_BYTES;
    snap_encode(pkt + 6, ++s_seq, &s);
    if (s_connected && s_my_id >= 0) {
        if (atv2_roam_out_put(ROAM_KIND_BINARY, pkt, sizeof pkt)) {
            s_sent_bytes += sizeof pkt;
            s_sent_snaps++;
        }
    }
    if (s_test) {
        /* echo: 5 m to the right of where we were 0.5 s ago */
        Remote *r = rem_find(99, 1);
        uint8_t raw[SNAP_BYTES];
        Snap e;
        uint32_t seq;
        float m[9];
        int i;
        if (r && !r->slot) { snprintf(r->name, sizeof r->name, "ECHO"); rem_assign(r); }
        rdv(u + B_MAT, m, 9);
        for (i = 0; i < 3; i++) s.pos[i] += s_test == 2 ? 3.0f * m[i] + 9.0f * m[6 + i] : 5.0f * m[i];
        snap_encode(raw, s_seq, &s);
        snap_decode(raw, &seq, &e);
        e.t = now - 500;
        if (r) rem_push(r, &e, seq, now);
    }
    if (now - s_stat_t0 >= 10000) {
        double dt = (now - s_stat_t0) / 1000.0;
        int i;
        fprintf(stderr, "[ROAM] ghost: %u puppet pairs skipped; %u name tags (first at %.2f %.2f, %.0f m)\n",
                s_ghost_skips, atv2_roam_mb.nlabels, atv2_roam_mb.labels[0].x, atv2_roam_mb.labels[0].y,
                atv2_roam_mb.labels[0].z);
        fprintf(stderr, "[ROAM] label dbg: xs %.3f z %.2f n %d\n", s_dbg_xs, s_dbg_z, s_dbg_n);
        fprintf(stderr, "[ROAM] stats: sent %u snaps (%.1f/s, %.0f B/s payload), recv %u snaps (%.1f/s, %.0f B/s)\n",
                s_sent_snaps, s_sent_snaps / dt, s_sent_bytes / dt, s_recv_snaps, s_recv_snaps / dt, s_recv_bytes / dt);
        for (i = 0; i < MAXP; i++)
            if (s_rem[i].used)
                fprintf(stderr, "[ROAM]   %s id %d slot %d: interval %.1f ms, jitter %.1f ms, delay %.0f ms, got %u lost %u late %u\n",
                        s_rem[i].name, s_rem[i].id, s_rem[i].slot, s_rem[i].interval, s_rem[i].jit,
                        s_rem[i].delay, s_rem[i].got, s_rem[i].lost, s_rem[i].late, s_rem[i].n_interp, s_rem[i].n_extrap);
        fflush(stderr);
        s_sent_snaps = s_recv_snaps = 0; s_sent_bytes = s_recv_bytes = 0; s_stat_t0 = now;
    }
}

/* A puppet slot's participant update: the unit's own step (control mode 0:
 * no AI input), then the remote pose over it. */
static void puppet_tick(uint32_t p, int slot)
{
    uint32_t u = part_unit(p);
    double now = now_ms();
    Remote *r = NULL;
    int i, k;
    if (!u)
        return;
    for (i = 0; i < MAXP; i++)
        if (s_rem[i].used && s_rem[i].slot == slot) { r = &s_rem[i]; break; }
    if (r && r->n && now - r->last_recv > 5000) {     /* silent for 5 s */
        rem_drop(r, "timeout");
        r = NULL;
    }
    if (r && r->n) {
        Snap s;
        double delay = 1.5 * r->interval + 2.5 * r->jit + 10;
        if (delay < 50) delay = 50;
        if (delay > 300) delay = 300;
        s_delay_ms = delay;
        /* remote clock now = now - off_min; show it `delay` ms behind */
        r->delay = delay;
        k = rem_sample(r, now - r->off_min - delay, &s);
        if (k == 1) r->n_interp++; else if (k == 2) r->n_extrap++;
        if (k) {
            apply(u, &s);
            memcpy(r->lastpos, s.pos, sizeof r->lastpos);
            if (!r->shown) {
                fprintf(stderr, "[ROAM] %s shown in slot %d at %.1f %.1f %.1f\n", r->name, slot,
                        s.pos[0], s.pos[1], s.pos[2]);
                fflush(stderr);
                r->shown = 1;
            }
            return;
        }
    }
    park(u, slot);
}

static int puppet_slot(uint32_t p)
{
    int i;
    for (i = 1; i <= s_slots && i < RT_MAX; i++) {
        uint32_t r = racer(i);
        if (!r) return 0;
        if (racer_part(r) == p) return i;
    }
    return 0;
}

static void hook_part_ai(void)
{
    uint32_t p = g_ecx;
    int slot = rd32(GAMEMODE) == 4 ? puppet_slot(p) : 0;
    if (slot)
        MEM32(p + 0x20) = 0;          /* no AI input */
    sub_00027470();
    if (slot)
        puppet_tick(p, slot);
}

static void hook_part_human(void)
{
    uint32_t p = g_ecx;
    sub_00028340();
    if (rd32(GAMEMODE) == 4 && racer_part(racer(0)) == p)
        local_tick(racer(0));
}

/* Freestyle's participants: N AI riders (the puppet slots) instead of none. */
static void guest_call2(void (*fn)(void), uint32_t a1, uint32_t a2)
{
    PUSH32(g_esp, a2);
    PUSH32(g_esp, a1);
    PUSH32(g_esp, 0xDEAD0000u);
    fn();
    g_esp += 8;
}

static void hook_setup_fs(void)
{
    fprintf(stderr, "[ROAM] freestyle: %d rider slots for other players\n", s_slots);
    fflush(stderr);
    guest_call2(sub_000BB4B0, (uint32_t)s_slots, SETTINGS);
    g_esp += 4;
}

typedef void (*roam_func_t)(void);

/* RE aid (RECOMP_ROAM_TRACE=1): indirect calls on the local unit or puppet 1,
 * counted apart while the two are near (< 2.2 m) and far (> 4 m). */
static int s_trace;
#define TRN 1024
static struct { uint32_t va, ret, who; uint32_t n[2]; } s_tr[TRN];
static int s_trn, s_tr_frames[2];
static void trace_call(uint32_t va)
{
    static uint32_t u0, u1, cnt;
    static int near_;
    uint32_t e = g_ecx, who = 0, ret, k;
    if ((cnt++ & 1023) == 0) {
        float a[3], b[3], d = 0;
        int i;
        u0 = part_unit(racer_part(racer(0)));
        u1 = part_unit(racer_part(racer(1)));
        if (!u0 || !u1) return;
        rdv(u0 + B_POS, a, 3); rdv(u1 + B_POS, b, 3);
        for (i = 0; i < 3; i++) d += (a[i] - b[i]) * (a[i] - b[i]);
        near_ = d < 2.2f * 2.2f ? 1 : d > 16.0f ? 0 : -1;
        if (near_ >= 0) s_tr_frames[near_]++;
    }
    if (near_ < 0 || !u0) return;
    if (e >= u0 && e < u0 + 0x1200) who = 1 | ((e - u0) << 4);
    else if (e >= u1 && e < u1 + 0x1200) who = 2 | ((e - u1) << 4);
    else return;
    ret = MEM32(g_esp);
    for (k = 0; k < (uint32_t)s_trn; k++)
        if (s_tr[k].va == va && s_tr[k].ret == ret && s_tr[k].who == who) break;
    if (k == (uint32_t)s_trn) { if (s_trn == TRN) return; s_tr[k].va = va; s_tr[k].ret = ret; s_tr[k].who = who; s_trn++; }
    s_tr[k].n[near_]++;
}
static void trace_dump(void)
{
    int k;
    fprintf(stderr, "[ROAM] trace: samples far %d near %d\n", s_tr_frames[0], s_tr_frames[1]);
    for (k = 0; k < s_trn; k++)
        fprintf(stderr, "[ROAM] tr %05X ret %05X %s+%X far %u near %u\n", s_tr[k].va, s_tr[k].ret,
                (s_tr[k].who & 15) == 1 ? "local" : "puppet", s_tr[k].who >> 4, s_tr[k].n[0], s_tr[k].n[1]);
    fflush(stderr);
}

roam_func_t atv2_roam_lookup(uint32_t va)
{
    if (s_checked <= 0)
        return 0;
    if (s_trace) {
        trace_call(va);
        if (s_tr_frames[1] > 200 && s_tr_frames[0] > 200 && s_trace == 1) { s_trace = 2; trace_dump(); }
    }
    if (s_nghost && MEM32(g_esp) == RET_PAIR &&
        (is_ghost(MEM32(g_esp + 4)) || is_ghost(MEM32(g_esp + 8))))
        return skip_pair;
    if (va == FN_PART_AI) return hook_part_ai;
    if (va == FN_PART_HUMAN) return hook_part_human;
    if (va == FN_SETUP_FS) return hook_setup_fs;
    return 0;
}

/* Every flip (gpu thread): the exe check, once the XBE is loaded. */
void atv2_roam_flip(void)
{
    if (s_checked)
        return;
    if (!rd32(0x001D8608u))
        return;                       /* not booted far enough */
    s_checked = exe_ok() ? 1 : -1;
    if (s_checked < 0) {
        fprintf(stderr, "[ROAM] not this game's default.xbe (1E3C2FCE...): off\n");
        atv2_roam_hook = 0;
    } else {
        fprintf(stderr, "[ROAM] exe checked: hooks on\n");
    }
    fflush(stderr);
}

/* Names over the riders: world positions for the overlay (any thread). */
/* ---- name tags --------------------------------------------------------------------
 * Each tick the shown riders are projected with the game's view-projection
 * matrix (0x1DE768: 4x4, row vectors, D3D clip space; the render camera's pose
 * is at 0x1DE70C) into the mailbox's labels: x, y in 0..1 of the screen, z the
 * distance. Natively gpu_d3d11.c draws them; in the browser web/host/roam.js. */
#define CAM_VP   0x001DE768u
#define CAM_POS  0x001DE70Cu

static void labels_update(void)
{
    RoamMailbox *m = &atv2_roam_mb;
    float vp[16], cam[12], xs;
    uint32_t n = 0;
    int i, k;
    /* The render camera: position and rows (right, up, forward) at 0x1DE70C;
     * the horizontal scale (1 / tan(fov/2), it changes with speed) from the
     * view-projection's first column. Square pixels on a 4:3 picture. */
    rdv(CAM_VP, vp, 16);
    {   /* the human camera controller (settings+0x58 [0] +0xB4): pose at +0x78, rows at +0x84;
         * the render camera global (CAM_POS) holds whatever drew last at update time */
        uint32_t pl0 = rd32(rd32(SETTINGS + 0x58)), ctl = pl0 ? rd32(pl0 + 0xB4) : 0;
        if (!ctl) { m->nlabels = 0; return; }
        rdv(ctl + 0x78, cam, 12);
    }
    xs = sqrtf(vp[0] * vp[0] + vp[4] * vp[4] + vp[8] * vp[8]);
    s_dbg_xs = xs;
    if (!(xs > 0.2f && xs < 10.0f)) { m->nlabels = 0; return; }
    for (i = 0; i < MAXP && n < 8; i++) {
        Remote *r = &s_rem[i];
        float d[3], x = 0, y = 0, z = 0;
        if (!r->used || !r->slot || !r->shown) continue;
        d[0] = r->lastpos[0] - cam[0]; d[1] = r->lastpos[1] + 1.45f - cam[1]; d[2] = r->lastpos[2] - cam[2];
        for (k = 0; k < 3; k++) { x += d[k] * cam[3 + k]; y += d[k] * cam[6 + k]; z += d[k] * cam[9 + k]; }
        s_dbg_z = z; s_dbg_n++;
        if (z < 0.5f || z > 120.0f) continue;
        m->labels[n].x = 0.5f + 0.5f * xs * x / z;
        m->labels[n].y = 0.5f - 0.5f * xs * (4.0f / 3.0f) * y / z;
        m->labels[n].z = z;
        if (m->labels[n].x < -0.1f || m->labels[n].x > 1.1f || m->labels[n].y < -0.1f || m->labels[n].y > 1.1f) continue;
        memset((void *)m->labels[n].name, 0, sizeof m->labels[n].name);
        memcpy((void *)m->labels[n].name, r->name, strlen(r->name) < 19 ? strlen(r->name) : 19);
        n++;
    }
    m->nlabels = n;
}

static uint32_t s_g_va, s_g_w, s_g_pitch;
static void guest_px(int l, int t, int r, int b, void *ctx)
{
    uint32_t color = *(uint32_t *)ctx;
    int x, y;
    if (l < 0) l = 0;
    if (t < 0) t = 0;
    if (r > (int)s_g_w) r = (int)s_g_w;
    for (y = t; y < b; y++)
        for (x = l; x < r; x++) {
            uint32_t va = s_g_va + (uint32_t)y * s_g_pitch + (uint32_t)x * 4u;
            *(volatile uint32_t *)XBOX_PTR(va) = color;
        }
}

/* The name tags into the guest's presented frame (32-bit, w x h). */
void atv2_roam_draw_guest(uint32_t va, uint32_t w, uint32_t h, uint32_t pitch)
{
    RoamMailbox *m = &atv2_roam_mb;
    uint32_t i, n = m->nlabels, black = 0xFF000000u, white = 0xFFFFFFFFu;
    if (!n || !va || pitch < w * 4 || w > 4096 || h > 4096)
        return;
    s_g_va = va; s_g_w = w; s_g_pitch = pitch;
    for (i = 0; i < n && i < 8; i++) {
        char name[21];
        int len, x, y;
        memcpy(name, (const void *)m->labels[i].name, 20); name[20] = 0;
        len = (int)strlen(name);
        int px = m->labels[i].z < 30.0f ? 2 : 1;      /* 5x7 font: 10x14 near, 5x7 far */
        x = (int)(m->labels[i].x * w) - len * 3 * px;
        y = (int)(m->labels[i].y * h) - 7 * px;
        if (y < 1 || y + 8 * px > (int)h) continue;
        roam_text_rects(name, x, y, px, 1, guest_px, &black);
        roam_text_rects(name, x, y, px, 0, guest_px, &white);
    }
}

void atv2_roam_init(void)
{
    const char *e = getenv("RECOMP_ROAM");
    char buf[160], *tok, *ctx = NULL;
    if (!e || !*e || !strcmp(e, "0"))
        return;
    snprintf(buf, sizeof buf, "%s", e);
    for (tok = strtok_r(buf, ",;", &ctx); tok; tok = strtok_r(NULL, ",;", &ctx)) {
        if (!strncmp(tok, "name=", 5)) snprintf(s_name, sizeof s_name, "%s", tok + 5);
        else if (!strncmp(tok, "slots=", 6)) s_slots = atoi(tok + 6);
        else if (!strncmp(tok, "test=", 5)) s_test = atoi(tok + 5);
        else if (!s_addr[0]) snprintf(s_addr, sizeof s_addr, "%s", tok);
    }
    if (getenv("RECOMP_ROAM_TRACE")) s_trace = 1;
    if (getenv("RECOMP_ROAM_NAME")) snprintf(s_name, sizeof s_name, "%s", getenv("RECOMP_ROAM_NAME"));
    if (s_slots < 1) s_slots = 1;
    if (s_slots > RT_MAX - 1) s_slots = RT_MAX - 1;
    { char *c; for (c = s_name; *c; c++) if (*c == '"' || *c == '\\' || (unsigned char)*c < 32) *c = '_'; }
    memset(&atv2_roam_mb, 0, sizeof atv2_roam_mb);
    atv2_roam_mb.magic = ROAM_MB_MAGIC;
    atv2_roam_mb.version = ROAM_MB_VERSION;
    atv2_roam_mb.size = sizeof atv2_roam_mb;
    atv2_roam_mb.out_cap = ROAM_OUT_CAP;
    atv2_roam_mb.in_cap = ROAM_IN_CAP;
    snprintf((char *)atv2_roam_mb.addr, sizeof atv2_roam_mb.addr, "%s", s_addr);
    atv2_roam_hook = 1;
    atv2_roam_on = 1;
    s_stat_t0 = now_ms();
    fprintf(stderr, "[ROAM] on: hub %s, name %s, %d rider slots%s\n", s_addr[0] ? s_addr : "(none)",
            s_name, s_slots, s_test ? ", test echo" : "");
    fflush(stderr);
    if (s_addr[0])
        atv2_roam_net_start(s_addr);
}
