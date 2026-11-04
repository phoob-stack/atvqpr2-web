/*
 * roam.c -- multiplayer free roam for Free Ride (Freestyle, Unlimited Time,
 * Stadium: Main Event).
 *
 *   RECOMP_ROAM=host:port[,name=NAME][,room=ROOM][,slots=N][,collide=1][,ghost=SECS][,test=1|2]
 *
 * (',' or ';' between options; work\roam\ROAM-RE.md and work\roam2\ROAM2-RE.md
 * have the reverse engineering).
 *
 * Model (the nfsu2-web free-roam model):
 *   - each game simulates only its own quad and sends snapshots of it (30 Hz)
 *     to a hub over one WebSocket (native: src/roam_net.c, Winsock; browser:
 *     web/host/roam.js through a shared mailbox);
 *   - remote riders are drawn in extra rider slots the game creates itself:
 *     Freestyle's "set up participants" (state 0x1C04FC slot 1, 0x000B70D0)
 *     asks for 0 AI riders; with roam on it asks for N (BB4B0(N, settings)),
 *     so the stadium load spawns N more rider+ATV units;
 *   - each slot shows the remote player's own rider and ATV: the choice
 *     (participant +0x40 rider type, +0x38 vehicle type) comes once in the
 *     hello / "look" control messages; written into the slot's participant
 *     before the stadium load builds it, or -- for a player who joins or
 *     changes later -- the slot is respawned: the rider's and the ATV's
 *     packs loaded, the participant's own despawn/spawn (vt+0x50 / vt+0x4C),
 *     the packs unloaded (as the race load 0xA1D30 does);
 *   - those slots are puppets: their participant (AI controller) runs in
 *     control mode 0 (no AI input), and after the unit's own physics step the
 *     pose from the interpolated snapshot is written over the unit's body
 *     (position, quaternion, matrix, velocities), its controls (throttle,
 *     steer, brake, lean) and its engine state (rpm, load: what the engine
 *     sound 0xB1690 reads); a trick the remote starts is started on the
 *     puppet's rider with the game's own call (0x2A7E0);
 *   - unused slots are parked under the arena;
 *   - collisions between players are off (ghost) by default; with collide=1
 *     (or the hub's room setting) a rider is a ghost for `ghost` seconds after
 *     it appears or respots, and while it still overlaps the other rider,
 *     then solid against the local rider only (see "collisions" below).
 *
 * Network input is checked before it reaches the game: frame sizes (roam.h),
 * every float of a snapshot finite and in range, ids and enums in range.
 *
 * Game objects (default.xbe SHA-256 1E3C2FCE..., ATV Quad Power Racing 2, USA):
 *   settings 0x1D8620: +0x10 participants, +0x14[8] participant objects
 *                 (index 0 the local human, 1.. the puppet slots)
 *   participant P: vt 0x1B0128 human (update vt+0x30 = 0x28340),
 *                 vt 0x1B0098 AI (update vt+0x30 = 0x27470)
 *                 +0x20 control mode: 0 none, 1 human pad, 2 AI
 *                 +0x38 vehicle type (0..10: Bandit .. ATC), +0x3C unit U,
 *                 +0x40 rider type (0..23: Doug_Gust .. Troll), +0x44 rider R,
 *                 +0x60 last trick id
 *   racer table   0x1D752C + i*0x18 -> rider R (vt 0x1B03A8)
 *   R +0x488 trick anim, +0x48C trick phase (1 start .. 7 end), +0x490 flags,
 *                 +0x49C trick entry (trick table [0x1D8930] + 4 + id*0x30),
 *                 +0x4A0 rider state (0 ride, 2 preload, 4 trick, 8 land, 0x10 crash)
 *   U (vt 0x1AF3A8), body at U+0x4C:
 *                 +0x08 pos, +0x14 vel, +0x20 angular vel, +0x2C quat xyzw,
 *                 +0x3C 3x3 matrix (rows: right, up, forward)
 *   U+0x2C8.. controls written by SetControls (0x1C150): +0x2C8 throttle,
 *                 +0x2CC steer, +0x2D0 brake, +0x7EC lean
 *   U engine: +0x278 rpm (500 idle .. 11000), +0x27C rpm (sound), +0x26C max,
 *                 +0x2A8, +0x2BC (ints), +0x2B0, +0x2D4, +0x59C (0..1)
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

static void labels_update(void);

void sub_000BB4B0(void);   /* set participants (thiscall nAI, settings)           */
void sub_00027470(void);   /* participant update, AI / base                       */
void sub_00028340(void);   /* participant update, human                           */
void sub_0002A7E0(void);   /* rider R: start trick (thiscall id) -> 1 started     */
void sub_000F7410(void);   /* load a pack: cdecl (name, 1)                        */
void sub_000F6E60(void);   /* unload a pack: cdecl (name)                         */
void sub_000C9B9F(void);   /* wait for an object: stdcall (handle, ms)             */
void sub_000C9AE9(void);   /* release a mutex: stdcall (handle)                    */
void sub_000EDE40(void);   /* renderer: set flag (thiscall bits) -- loading mode   */

/* ---- addresses ------------------------------------------------------------ */

#define RT_TABLE        0x001D752Cu
#define RT_STRIDE       0x18u
#define RT_MAX          8
#define SETTINGS        0x001D8620u
#define NPARTS          (SETTINGS + 0x10)   /* participants                      */
#define PARTS           (SETTINGS + 0x14)   /* participant objects [8]            */
#define TRACK           (SETTINGS + 0x34)   /* track id (15 = Stadium1)           */
#define RACE            (SETTINGS + 0x38)   /* race / track object                */
#define GAMEMODE        (SETTINGS + 0x5C)   /* 4 = freestyle */
#define RACE_TIME       0x001DA05Cu
#define VT_RACER        0x001B03A8u
#define VT_UNIT         0x001AF3A8u
#define VT_PART_HUMAN   0x001B0128u
#define VT_PART_AI      0x001B0098u
#define FN_SETUP_FS     0x000B70D0u   /* freestyle: BB4B0(0, settings)          */
#define FN_PART_AI      0x00027470u   /* participant update (AI / base)         */
#define FN_PART_HUMAN   0x00028340u   /* participant update (human)             */
#define RIDER_DB        0x001DA114u   /* -> +4 + rider*0x60: +8 name ("Doug_Gust") */
#define ATV_DB          0x001DA128u   /* -> + atv*0x478: +0xC pack name            */
#define TRICK_TAB       0x001D8930u   /* -> + 4 + id*0x30: trick entries           */
#define NRIDERS         24
#define NATVS           11
#define TRICK_MAX       0x1D          /* 0..0x1B tricks, 0x1D the special        */

/* participant */
#define P_VEHICLE 0x38u
#define P_UNIT    0x3Cu
#define P_RIDER   0x40u
#define P_RACER   0x44u
/* participant virtuals */
#define PV_SPAWN   0x4Cu   /* (track id)          26010 AI / 26730 human        */
#define PV_DESPAWN 0x50u   /* ()                  26D20                         */
#define PV_PATHS   0x6Cu   /* (race +0x28)        260B0                         */
/* rider R */
#define R_ANIM    0x488u
#define R_PHASE   0x48Cu
#define R_TFLAGS  0x490u
#define R_TRICK   0x49Cu
#define R_STATE   0x4A0u
/* unit engine (read by the engine sound 0xB1690) */
#define U_RPM     0x278u
#define U_RPM2    0x27Cu
#define U_X2A8    0x2A8u
#define U_X2B0    0x2B0u
#define U_X2BC    0x2BCu
#define U_THRF    0x2D4u
#define U_LOAD    0x59Cu

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
static int  s_test_rider = -1, s_test_atv = -1;   /* testlook=R:A: the echo's look */
static char s_name[24] = "PLAYER";
static char s_room[24] = "freeride";
static char s_addr[64];
static int  s_collide_opt;        /* collide=1                           */
static int  s_collide_room;       /* the hub's room setting (welcome)    */
static double s_ghost_ms = 3000;  /* ghost=SECS                          */

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
static void wr32(uint32_t va, uint32_t u) { if (RAM_OK(va)) memcpy((void *)XBOX_PTR(va), &u, 4); }
static void wrf(uint32_t va, float f) { uint32_t u; memcpy(&u, &f, 4); wr32(va, u); }
static void rdv(uint32_t va, float *v, int n) { int i; for (i = 0; i < n; i++) v[i] = rdf(va + 4 * i); }
static void wrv(uint32_t va, const float *v, int n) { int i; for (i = 0; i < n; i++) wrf(va + 4 * i, v[i]); }
static int collide_on(void) { return s_collide_opt || s_collide_room; }


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

/* ---- snapshots --------------------------------------------------------------
 * One record per snapshot, 30 per second. Version 1 (52 bytes) is the pose and
 * the controls; version 2 (68 bytes) adds the engine and the rider's trick
 * state after it, so a v1 reader still decodes the first 52 bytes and a v2
 * reader takes a 52-byte record as "no engine / trick data". Byte 50 is the
 * record version (0 in v1), byte 51 the sender's flags. */

typedef struct {
    double t;              /* sender ms */
    float pos[3], q[4], vel[3], avel[3];
    float ctl[4];          /* throttle, steer, brake, lean */
    /* v2 */
    int     ext;           /* the fields below are valid                       */
    uint8_t flags;         /* SNAPF_*                                          */
    float   rpm, thrf, load, x2b0;
    uint8_t x2a8, x2bc;
    uint8_t rstate;        /* rider state R+0x4A0                              */
    int8_t  trick;         /* trick id (R+0x49C entry) or -1                   */
    uint8_t tseq;          /* +1 per trick started                             */
    uint8_t tphase, tflags;
    uint16_t tanim;        /* R+0x488 (0xFFFF none)                            */
    uint16_t tms;          /* ms since this trick started                      */
} Snap;

#define SNAP_V1    52
#define SNAP_V2    68
#define SNAP_BYTES SNAP_V2
#define SNAPF_GHOST   1    /* sender: in its own ghost period (spawn, respot)   */
#define SNAPF_COLLIDE 2    /* sender has collisions on                          */
/* v1: u32 seq, u32 t_ms, f32 pos[3], i16 q[4], f32 vel[3], i16 avel[3],
 *     i8 throttle, steer, brake, lean, u8 version, u8 flags -> 52
 * v2: + u16 rpm, u8 thrf, u8 load, u8 x2b0, u8 x2a8, u8 x2bc, u8 rstate,
 *     i8 trick, u8 tseq, u8 tphase, u8 tflags, u16 tanim, u16 tms -> 68 */

/* What the network may say about a rider (anything else: the record is dropped). */
#define LIM_POS   20000.0f /* m from the origin (the Stadium is ~400 m across) */
#define LIM_VEL   200.0f   /* m/s                                              */
#define LIM_RPM   30000.0f

static void put16(uint8_t *p, int v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void put32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }
static uint32_t get32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
static int get16s(const uint8_t *p) { return (int16_t)(p[0] | (p[1] << 8)); }
static int get16u(const uint8_t *p) { return p[0] | (p[1] << 8); }
static int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
static float getf(const uint8_t *p) { uint32_t u = get32(p); float f; memcpy(&f, &u, 4); return f; }
static void putf(uint8_t *p, float f) { uint32_t u; memcpy(&u, &f, 4); put32(p, u); }
static int finite_in(float v, float lim) { return v == v && v > -lim && v < lim; }
static int u8f(float v) { return v == v ? clampi((int)lrintf(v * 255.0f), 0, 255) : 0; }

static void snap_encode(uint8_t *o, uint32_t seq, const Snap *s)
{
    int i;
    put32(o, seq); put32(o + 4, (uint32_t)(int64_t)s->t);
    for (i = 0; i < 3; i++) putf(o + 8 + 4 * i, s->pos[i]);
    for (i = 0; i < 4; i++) put16(o + 20 + 2 * i, clampi((int)lrintf(s->q[i] * 32767.0f), -32767, 32767));
    for (i = 0; i < 3; i++) putf(o + 28 + 4 * i, s->vel[i]);
    for (i = 0; i < 3; i++) put16(o + 40 + 2 * i, clampi((int)lrintf(s->avel[i] * 1000.0f), -32767, 32767));
    for (i = 0; i < 4; i++) o[46 + i] = (uint8_t)(int8_t)clampi((int)lrintf(s->ctl[i] * 127.0f), -127, 127);
    o[50] = 2; o[51] = s->flags;
    put16(o + 52, clampi((int)lrintf(s->rpm), 0, 65535));
    o[54] = (uint8_t)u8f(s->thrf); o[55] = (uint8_t)u8f(s->load); o[56] = (uint8_t)u8f(s->x2b0);
    o[57] = s->x2a8; o[58] = s->x2bc; o[59] = s->rstate;
    o[60] = (uint8_t)s->trick; o[61] = s->tseq; o[62] = s->tphase; o[63] = s->tflags;
    put16(o + 64, s->tanim); put16(o + 66, s->tms);
}

/* 1 = a sane record, 0 = dropped (NaN / inf / out of range / short). */
static int snap_decode(const uint8_t *o, int len, uint32_t *seq, Snap *s)
{
    int i;
    float n = 0;
    if (len < SNAP_V1)
        return 0;
    memset(s, 0, sizeof *s);
    *seq = get32(o);
    s->t = (double)get32(o + 4);
    for (i = 0; i < 3; i++) { s->pos[i] = getf(o + 8 + 4 * i); if (!finite_in(s->pos[i], LIM_POS)) return 0; }
    for (i = 0; i < 4; i++) { s->q[i] = get16s(o + 20 + 2 * i) / 32767.0f; n += s->q[i] * s->q[i]; }
    if (n < 0.25f) return 0;                     /* not a rotation */
    n = 1.0f / sqrtf(n);
    for (i = 0; i < 4; i++) s->q[i] *= n;
    for (i = 0; i < 3; i++) { s->vel[i] = getf(o + 28 + 4 * i); if (!finite_in(s->vel[i], LIM_VEL)) return 0; }
    for (i = 0; i < 3; i++) s->avel[i] = get16s(o + 40 + 2 * i) / 1000.0f;   /* +-32.8 rad/s by construction */
    for (i = 0; i < 4; i++) s->ctl[i] = clampi((int8_t)o[46 + i], -127, 127) / 127.0f;
    s->trick = -1;
    s->tanim = 0xFFFF;
    if (len >= SNAP_V2 && o[50] >= 2) {
        s->ext = 1;
        s->flags = o[51];
        s->rpm = (float)get16u(o + 52);
        if (!(s->rpm < LIM_RPM)) return 0;
        s->thrf = o[54] / 255.0f; s->load = o[55] / 255.0f; s->x2b0 = o[56] / 255.0f;
        s->x2a8 = o[57] > 8 ? 0 : o[57];
        s->x2bc = o[58] > 8 ? 0 : o[58];
        s->rstate = o[59];
        s->trick = (int8_t)o[60];
        if (s->trick < -1 || s->trick > TRICK_MAX) return 0;
        s->tseq = o[61]; s->tphase = o[62]; s->tflags = o[63];
        s->tanim = (uint16_t)get16u(o + 64); s->tms = (uint16_t)get16u(o + 66);
    }
    return 1;
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
    int      used, id, slot;          /* slot: participant index 1..N, 0 none */
    char     name[24];
    int      rider, atv, skin;        /* look (hello / "look"); -1 unknown    */
    Snap     buf[JB];                 /* ring by arrival, ordered by t */
    int      n, head;
    uint32_t last_seq;
    double   off_min, jit;            /* recv_local - t_remote: min, spread EMA */
    double   off_t;                   /* when off_min was last lowered */
    double   last_recv;
    double   interval;                /* EMA of snapshot spacing (ms) */
    uint32_t got, lost, late, bad;
    uint32_t n_interp, n_extrap;      /* ticks shown interpolated / extrapolated */
    double   delay;
    int      shown;
    double   shown_at;                /* first shown (ghost period)            */
    int      kind;                    /* last sample: 1 interpolated, 2 extrapolated */
    Snap     cur;                     /* last shown sample                     */
    float    lastpos[3], prevpos[3];
    double   jerk_sum, jerk_max;      /* |p(t) - 2p(t-1) + p(t-2)| per tick */
    uint32_t jerk_n;
    double   snap_until;              /* a big correction: ghost until then    */
    int      ghost, ghost_hold;       /* collisions: ghost now / held by overlap */
    int      tseq_init;
    uint8_t  tseq_done;               /* last trick seq started on the puppet  */
    uint32_t tricks_seen, tricks_shown;
} Remote;

static Remote s_rem[MAXP];
static int    s_my_id = -1;
static char   s_resume[40];
static int    s_connected;
static int    s_hub_v = 1;            /* the hub's protocol version (welcome)  */
static uint32_t s_seq;
static int    s_tick;
static double s_sent_bytes, s_recv_bytes, s_stat_t0;
static uint32_t s_sent_snaps, s_recv_snaps, s_bad_recs;
static double s_delay_ms = 100;      /* reported */
static int    s_my_rider = -1, s_my_atv = -1;   /* the local player's look      */

/* per puppet slot: the look it was built with and the one wanted */
static struct { int want_rider, want_atv, pending; uint32_t respawns, fails; double next_try; } s_slot[RT_MAX];

static void slot_want(int slot, int rider, int atv);
void atv2_roam_stack_dump(void);

static Remote *rem_find(int id, int make)
{
    int i;
    if (id < 0 || id > 255)
        return NULL;
    for (i = 0; i < MAXP; i++)
        if (s_rem[i].used && s_rem[i].id == id)
            return &s_rem[i];
    if (!make)
        return NULL;
    for (i = 0; i < MAXP; i++)
        if (!s_rem[i].used) {
            memset(&s_rem[i], 0, sizeof s_rem[i]);
            s_rem[i].used = 1; s_rem[i].id = id; s_rem[i].off_min = 1e18; s_rem[i].interval = 33;
            s_rem[i].rider = s_rem[i].atv = s_rem[i].skin = -1;
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
    if (r->slot) {
        fprintf(stderr, "[ROAM]   slot %d\n", r->slot);
        if (r->rider >= 0 && r->atv >= 0)
            slot_want(r->slot, r->rider, r->atv);
    }
    fflush(stderr);
}

static void rem_drop(Remote *r, const char *why)
{
    fprintf(stderr, "[ROAM] %s (id %d) left (%s): %u snapshots, %u lost, %u late, %u bad\n",
            r->name, r->id, why, r->got, r->lost, r->late, r->bad);
    fflush(stderr);
    r->used = 0;
    r->slot = 0;
}

static void rem_look(Remote *r, int rider, int atv, int skin)
{
    if (rider < 0 || rider >= NRIDERS || atv < 0 || atv >= NATVS)
        return;                       /* unknown or out of range: keep */
    if (rider == r->rider && atv == r->atv)
        return;
    r->rider = rider; r->atv = atv; r->skin = skin;
    fprintf(stderr, "[ROAM] %s (id %d) rides rider %d, ATV %d\n", r->name, r->id, rider, atv);
    fflush(stderr);
    if (r->slot)
        slot_want(r->slot, rider, atv);
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

/* Pose at remote time T: interpolate, else extrapolate (<= 250 ms), else hold.
 * The discrete fields (engine ints, trick) come from the earlier record. */
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
        *o = *a;
        for (i = 0; i < 3; i++) {
            o->pos[i] = h00 * a->pos[i] + h10 * (float)dt * a->vel[i] + h01 * b->pos[i] + h11 * (float)dt * b->vel[i];
            o->vel[i] = a->vel[i] + (b->vel[i] - a->vel[i]) * u;
            o->avel[i] = a->avel[i] + (b->avel[i] - a->avel[i]) * u;
        }
        for (i = 0; i < 4; i++) o->ctl[i] = a->ctl[i] + (b->ctl[i] - a->ctl[i]) * u;
        if (a->ext && b->ext) {
            o->rpm = a->rpm + (b->rpm - a->rpm) * u;
            o->thrf = a->thrf + (b->thrf - a->thrf) * u;
            o->load = a->load + (b->load - a->load) * u;
        }
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
static uint32_t part(int i)
{
    uint32_t p;
    if (i < 0 || i >= RT_MAX || (uint32_t)i >= rd32(NPARTS)) return 0;
    p = rd32(PARTS + 4u * (uint32_t)i);
    return p && (rd32(p) == VT_PART_AI || rd32(p) == VT_PART_HUMAN) ? p : 0;
}
static uint32_t part_unit(uint32_t p) { uint32_t u = p ? rd32(p + P_UNIT) : 0; return u && rd32(u) == VT_UNIT ? u : 0; }
static uint32_t part_racer(uint32_t p) { uint32_t r = p ? rd32(p + P_RACER) : 0; return r && rd32(r) == VT_RACER ? r : 0; }

static int exe_ok(void)
{
    return rd32(0x001C04FCu + 4) == FN_SETUP_FS &&
           rd32(VT_PART_AI + 0x30) == FN_PART_AI &&
           rd32(VT_PART_HUMAN + 0x30) == FN_PART_HUMAN &&
           rd32(VT_UNIT) == 0x0001FD50u && rd32(VT_RACER) == 0x0002F170u &&
           rd32(0x001C0500u) == FN_SETUP_FS &&
           rd32(VT_PART_AI + PV_SPAWN) == 0x00026010u && rd32(VT_PART_AI + PV_DESPAWN) == 0x00026D20u &&
           rd32(VT_PART_AI + PV_PATHS) == 0x000260B0u;
}

/* The trick the rider R is doing (its trick table entry), or -1. */
static int racer_trick(uint32_t r)
{
    uint32_t e = rd32(r + R_TRICK), tab = rd32(TRICK_TAB), d;
    if (!e || !tab || e < tab + 4) return -1;
    d = e - (tab + 4);
    if (d % 0x30u || d / 0x30u > TRICK_MAX) return -1;
    return (int)(d / 0x30u);
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
    s->ext = 1;
    s->rpm = rdf(u + U_RPM);
    s->thrf = rdf(u + U_THRF);
    s->load = rdf(u + U_LOAD);
    s->x2b0 = rdf(u + U_X2B0);
    s->x2a8 = (uint8_t)clampi((int)rd32(u + U_X2A8), 0, 8);
    s->x2bc = (uint8_t)clampi((int)rd32(u + U_X2BC), 0, 8);
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
    if (s->ext) {                     /* the engine sound's inputs */
        wrf(u + U_RPM, s->rpm);
        wrf(u + U_RPM2, s->rpm);
        wrf(u + U_THRF, s->thrf);
        wrf(u + U_LOAD, s->load);
        wrf(u + U_X2B0, s->x2b0);
        wr32(u + U_X2A8, s->x2a8);
        wr32(u + U_X2BC, s->x2bc);
    }
}

/* Parked slot: below the arena floor, still, engine idle. */
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
    wrf(u + 0x2C8, 0);
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

/* ---- calling the game ---------------------------------------------------------------
 * Guest functions run on the guest stack: arguments pushed right to left, a
 * return address (never used: the C call returns), ecx for thiscall. A
 * thiscall / stdcall callee pops its arguments, a cdecl one does not. */
static void gcall(recomp_func_t fn, uint32_t ecx, int callee_pops, int n, uint32_t a0, uint32_t a1)
{
    if (n > 1) PUSH32(g_esp, a1);
    if (n > 0) PUSH32(g_esp, a0);
    PUSH32(g_esp, 0xDEAD0000u);
    g_ecx = ecx;
    fn();
    if (!callee_pops) g_esp += 4u * (uint32_t)n;
}
static recomp_func_t vfn(uint32_t obj, uint32_t off)
{
    uint32_t vt = rd32(obj), va = vt ? rd32(vt + off) : 0;
    return va ? recomp_lookup(va) : 0;
}

/* A C string at a guest address, if it is a short printable one. */
static int guest_str(uint32_t va, char *out, int max)
{
    int i;
    for (i = 0; i < max - 1; i++) {
        uint8_t c;
        if (!RAM_OK(va + (uint32_t)i)) return 0;
        c = MEM8(va + (uint32_t)i);
        if (!c) break;
        if (c < 32 || c > 126) return 0;
        out[i] = (char)c;
    }
    out[i] = 0;
    return i > 0 && i < max - 1;
}

/* ---- the remote's rider and ATV ------------------------------------------------------
 * Before the stadium is built (participants made by BB4B0, units not yet
 * spawned) the choice is written into the slot's participant and the race
 * load (0xA1D30) builds it like any rider. Afterwards the slot is respawned:
 * the rider's pack ("characters/<name>") and the ATV's pack loaded (0xF7410),
 * the participant's own despawn (vt+0x50: frees its rider R and unit U) and
 * spawn (vt+0x4C(track): rider R with the rider model, unit U with the ATV),
 * its path objects again (vt+0x6C), and the packs unloaded (0xF6E60) -- the
 * steps the race load does for each participant. The participant (and its
 * progress object +0x48) stays, so the slot keeps its index. */
static int slot_look_prespawn(int slot);
static int s_respawn_opt;         /* respawn=1: change a built slot in the ride (experimental) */

static void slot_want(int slot, int rider, int atv)
{
    uint32_t p;
    if (slot < 1 || slot >= RT_MAX || rider < 0 || rider >= NRIDERS || atv < 0 || atv >= NATVS)
        return;
    s_slot[slot].want_rider = rider;
    s_slot[slot].want_atv = atv;
    s_slot[slot].pending = 1;
    s_slot[slot].next_try = 0;
    if (slot_look_prespawn(slot))
        return;
    p = part(slot);
    if (p && rd32(p + P_UNIT) && rd32(GAMEMODE) == 4 && !s_respawn_opt &&
        ((int)rd32(p + P_RIDER) != rider || (int)rd32(p + P_VEHICLE) != atv)) {
        fprintf(stderr, "[ROAM] slot %d was built before this rider was known: shown on the slot's rider/ATV "
                "until Free Ride is entered again (pause, QUIT) -- or respawn=1\n", slot);
        fflush(stderr);
    }
}

/* Before the units exist (participants made, stadium not built yet): write
 * the look into the slot's participant; 1 if it was written. */
static int slot_look_prespawn(int slot)
{
    uint32_t p = part(slot);
    if (!p || !s_slot[slot].pending || rd32(p + P_UNIT) || rd32(p) != VT_PART_AI)
        return 0;
    wr32(p + P_RIDER, (uint32_t)s_slot[slot].want_rider);
    wr32(p + P_VEHICLE, (uint32_t)s_slot[slot].want_atv);
    s_slot[slot].pending = 0;
    fprintf(stderr, "[ROAM] slot %d will be built with rider %d, ATV %d\n", slot, s_slot[slot].want_rider, s_slot[slot].want_atv);
    fflush(stderr);
    return 1;
}

/* After a respawn: what the race built around the old rider R and unit U
 * still points at them -- the sound manager's vehicle list ([0x1DA878]
 * +0x1F0, stride 0xC), the engine sound and rider sound objects, the camera
 * and effect lists the race load set up -- and the despawn only freed them.
 * Every remaining reference in guest RAM is moved to the new R / U (the
 * freed blocks and the dead stack below esp are left alone). One pass over
 * the 64 MB, on a join or a change of rider / ATV only. */
static int repoint(uint32_t oldr, uint32_t oldu, uint32_t newr, uint32_t newu)
{
    uint32_t va, lo = g_esp > 0x10000u ? g_esp - 0x10000u : 0, n = 0;
    if (!oldr || !oldu || !newr || !newu)
        return 0;
    for (va = 0x10000u; va < 0x04000000u; va += 4) {
        uint32_t v = MEM32(va);
        if (v != oldr && v != oldu)
            continue;
        if ((va >= oldr && va < oldr + 0x9F0u) || (va >= oldu && va < oldu + 0x1144u) ||
            (va >= newr && va < newr + 0x9F0u) || (va >= newu && va < newu + 0x1144u) || (va >= lo && va < g_esp))
            continue;
        if (n < 12) fprintf(stderr, "[ROAM]   %08X: %s %08X -> %08X\n", va, v == oldr ? "R" : "U", v, v == oldr ? newr : newu);
        MEM32(va) = v == oldr ? newr : newu;
        n++;
    }
    return (int)n;
}

static int slot_respawn(int slot, uint32_t p)
{
    int rider = s_slot[slot].want_rider, atv = s_slot[slot].want_atv;
    uint32_t rdb = rd32(RIDER_DB), adb = rd32(ATV_DB), rname, aname, buf, race, mtx, dev, ldr;
    recomp_func_t despawn = vfn(p, PV_DESPAWN), spawn = vfn(p, PV_SPAWN), paths = vfn(p, PV_PATHS);
    char rn[48], an[64], path[64];
    int i, ok, nfix = 0;
    double t0 = now_ms();
    s_slot[slot].pending = 0;
    if ((int)rd32(p + P_RIDER) == rider && (int)rd32(p + P_VEHICLE) == atv)
        return 1;                     /* already that */
    rname = rdb ? rd32(rdb + 4 + (uint32_t)rider * 0x60u + 8) : 0;
    aname = adb ? rd32(adb + (uint32_t)atv * 0x478u + 0xC) : 0;
    race = rd32(RACE);
    if (!guest_str(rname, rn, sizeof rn) || !guest_str(aname, an, sizeof an) || !despawn || !spawn || !paths || !race) {
        fprintf(stderr, "[ROAM] slot %d: cannot respawn (rider %d, ATV %d: database not ready)\n", slot, rider, atv);
        s_slot[slot].fails++;
        return 0;
    }
    snprintf(path, sizeof path, "characters/%s", rn);
    g_esp -= 128;                     /* the pack name on the guest stack */
    buf = g_esp;
    for (i = 0; i <= (int)strlen(path); i++) MEM8(buf + (uint32_t)i) = (uint8_t)path[i];
    /* the sound thread (0x87CC0) walks its streams under the mutex [0x1D934C] */
    mtx = rd32(0x001D934Cu);
    if (mtx) gcall(sub_000C9B9F, 0, 1, 2, mtx, 0xFFFFFFFFu);
    gcall(sub_000F7410, 0, 0, 2, buf, 1);
    gcall(sub_000F7410, 0, 0, 2, aname, 1);
    dev = rd32(0x001DE464u); ldr = rd32(0x001DE460u);
    {
        uint32_t oldr = rd32(p + P_RACER), oldu = rd32(p + P_UNIT), nu, t, k;
        gcall(despawn, p, 1, 0, 0, 0);
        wr32(p + P_RIDER, (uint32_t)rider);
        wr32(p + P_VEHICLE, (uint32_t)atv);
        /* as the game's own mid-race spawn (0x27120) does: the renderer in
         * its loading mode around the spawn */
        if (dev && ldr) { gcall(sub_000EDE40, dev, 1, 1, 1, 0); wr32(ldr + 0x1B4, 2); }
        gcall(spawn, p, 1, 1, rd32(TRACK), 0);
        if (dev && ldr) { wr32(dev + 0x198, rd32(dev + 0x198) & ~1u); wr32(ldr + 0x1B4, 0); }
        gcall(paths, p, 1, 1, rd32(race + 0x28), 0);
        /* the unit's wheel-trail object (U+0xEF4, vt 0x1BF378, made by
         * 0xA6CF0) leaves its four trail handles (+0xC..+0x18) to the zeroed
         * heap of a race load; from reused memory they are garbage */
        nu = part_unit(p); t = nu ? rd32(nu + 0xEF4) : 0;
        if (t && rd32(t) == 0x001BF378u && rd32(t + 4) == nu)
            for (k = 0; k < 4; k++) wr32(t + 0xC + 4 * k, 0);
        nfix = repoint(oldr, oldu, part_racer(p), nu);
    }
    gcall(sub_000F6E60, 0, 0, 1, aname, 0);
    gcall(sub_000F6E60, 0, 0, 1, buf, 0);
    if (mtx) gcall(sub_000C9AE9, 0, 1, 1, mtx, 0);
    g_esp += 128;
    ok = part_unit(p) && part_racer(p);
    if (ok) s_slot[slot].respawns++; else s_slot[slot].fails++;
    fprintf(stderr, "[ROAM] slot %d respawned as %s on %s: %s (%.0f ms; %d references moved)\n", slot, rn, an,
            ok ? "ok" : "FAILED", now_ms() - t0, nfix);
    fflush(stderr);
    return ok;
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
        if ((unsigned char)*p >= 32 && *p != '"' && *p != '\\') out[n++] = *p;
        p++;
    }
    out[n] = 0;
    return 1;
}

static int json_int(const char *j, const char *key, int def)
{
    char pat[32];
    const char *p;
    long v;
    snprintf(pat, sizeof pat, "\"%s\":", key);
    p = strstr(j, pat);
    if (!p) return def;
    p += strlen(pat);
    if (!(*p == '-' || (*p >= '0' && *p <= '9'))) return def;
    v = strtol(p, NULL, 10);
    return v < -1000000 || v > 1000000 ? def : (int)v;
}

static const char *client_kind(void)
{
#if defined(__wasm__)
    return "wasm";
#else
    return "native";
#endif
}

static void send_hello(void)
{
    char msg[320];
    int n = snprintf(msg, sizeof msg,
                     "{\"t\":\"hello\",\"v\":2,\"room\":\"%s\",\"name\":\"%s\",\"resume\":\"%s\",\"client\":\"%s\","
                     "\"snap\":2,\"rider\":%d,\"atv\":%d,\"skin\":-1,\"collide\":%d}",
                     s_room, s_name, s_resume, client_kind(), s_my_rider, s_my_atv, s_collide_opt);
    atv2_roam_out_put(ROAM_KIND_TEXT, msg, (unsigned)n);
}

static void send_look(void)
{
    char msg[96];
    int n = snprintf(msg, sizeof msg, "{\"t\":\"look\",\"rider\":%d,\"atv\":%d,\"skin\":-1}", s_my_rider, s_my_atv);
    if (s_connected && s_my_id >= 0)
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
        s_hub_v = json_int(j, "v", 1);
        s_collide_room = json_int(j, "collide", 0) == 1;
        { int g = json_int(j, "ghost", -1); if (g >= 0 && g <= 60 && s_collide_room && !s_collide_opt) s_ghost_ms = g * 1000.0; }
        json_str(j, "resume", s_resume, sizeof s_resume);
        fprintf(stderr, "[ROAM] joined the hub as id %d (%s)%s; hub v%d, collisions %s\n", id, s_name,
                json_int(j, "resumed", 0) ? ", resumed" : "", s_hub_v, collide_on() ? "on" : "off (ghosts)");
    } else if (!strcmp(t, "join") && id >= 0 && id != s_my_id) {
        r = rem_find(id, 1);
        if (r) {
            if (json_str(j, "name", name, sizeof name)) snprintf(r->name, sizeof r->name, "%s", name);
            fprintf(stderr, "[ROAM] %s (id %d) joined\n", r->name, id);
            rem_look(r, json_int(j, "rider", -1), json_int(j, "atv", -1), json_int(j, "skin", -1));
            rem_assign(r);
        }
    } else if (!strcmp(t, "look") && id != s_my_id) {
        r = rem_find(id, 0);
        if (r) rem_look(r, json_int(j, "rider", -1), json_int(j, "atv", -1), json_int(j, "skin", -1));
    } else if (!strcmp(t, "leave")) {
        r = rem_find(id, 0);
        if (r) rem_drop(r, "hub");
    } else if (!strcmp(t, "name")) {
        r = rem_find(id, 0);
        if (r && json_str(j, "name", name, sizeof name)) snprintf(r->name, sizeof r->name, "%s", name);
    } else if (!strcmp(t, "error")) {
        char why[64] = "";
        json_str(j, "why", why, sizeof why);
        fprintf(stderr, "[ROAM] hub: %s\n", why);
    }
    fflush(stderr);
}

/* binary: [u8 type=1][u8 src][u8 dst][u8 count] { [u8 src][u8 len][len bytes] } */
static void on_binary(const uint8_t *p, int n, double now)
{
    int i, count, at = 4;
    if (n < 4 || n > (int)ROAM_MAX_BINARY || p[0] != 1)
        return;
    count = p[3];
    for (i = 0; i < count && at + 2 <= n; i++) {
        int src = p[at], len = p[at + 1];
        if (at + 2 + len > n) break;
        if (len >= SNAP_V1 && src != s_my_id) {
            Remote *r = rem_find(src, 1);
            if (r) {
                Snap s;
                uint32_t seq;
                if (!snap_decode(p + at + 2, len, &seq, &s)) {
                    r->bad++; s_bad_recs++;
                    if (r->bad <= 3) { fprintf(stderr, "[ROAM] %s: record dropped (NaN / out of range)\n", r->name); fflush(stderr); }
                } else {
                    if (!r->slot) rem_assign(r);
                    rem_push(r, &s, seq, now);
                    s_recv_snaps++;
                }
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
            if (n > (int)ROAM_MAX_TEXT) continue;
            buf[n] = 0;
            on_text((char *)buf);
        } else if (kind == ROAM_KIND_BINARY) {
            on_binary(buf, n, now);
        }
    }
}

/* The mailbox is pumped by the game thread during the ride (local_tick) and
 * by the flip in the menus, so that hello / join / look are exchanged before
 * the stadium is built; one at a time. */
static volatile long s_pump_busy;
static double s_last_local_tick = -1e9;
static int pump_lock(void)
{
#if defined(_WIN32)
    return InterlockedCompareExchange(&s_pump_busy, 1, 0) == 0;
#else
    return __sync_bool_compare_and_swap(&s_pump_busy, 0, 1);
#endif
}
static void pump_unlock(void)
{
#if defined(_WIN32)
    InterlockedExchange(&s_pump_busy, 0);
#else
    __sync_lock_release(&s_pump_busy);
#endif
}

/* The local player's rider and ATV: the human participant's +0x40 / +0x38,
 * set by RIDER SELECT / ATV SELECT; sent when first known and on a change. */
static void poll_local_look(void)
{
    uint32_t p0 = rd32(PARTS);
    int rider, atv;
    if (!p0 || rd32(p0) != VT_PART_HUMAN)
        return;
    rider = (int)rd32(p0 + P_RIDER); atv = (int)rd32(p0 + P_VEHICLE);
    if (rider < 0 || rider >= NRIDERS || atv < 0 || atv >= NATVS || (rider == s_my_rider && atv == s_my_atv))
        return;
    s_my_rider = rider; s_my_atv = atv;
    fprintf(stderr, "[ROAM] local look: rider %d, ATV %d%s\n", rider, atv, rd32(RACE_TIME) ? "" : " (before the ride)");
    fflush(stderr);
    send_look();
}

/* ---- collisions ---------------------------------------------------------------------
 * The broadphase (0x709B0) calls a pair handler from the table at 0x1CBEF0
 * (cdecl handler(colliderA, colliderB) -> contacts) for every pair of active
 * objects whose boxes overlap; the call returns to 0x70B17. A puppet's
 * colliders are its rider R+0x1C and unit U+0x1C.
 *
 *   - collisions off (default): every pair with a puppet is skipped (ghost);
 *   - collisions on: a puppet is solid against the local rider only (never
 *     against the arena or another puppet: its pose is the remote's), and
 *     only when all of these hold:
 *       . it was shown more than `ghost` s ago, and the local rider spawned or
 *         respotted more than `ghost` s ago, and the remote is not in its own
 *         ghost period (its flag);
 *       . it no longer overlaps the local rider (an overlap when the ghost
 *         period ends keeps both ghosts until they are apart, 3 m);
 *       . its shown pose is interpolated (not an extrapolated guess) and had
 *         no big correction in the last 0.3 s (lag, loss);
 *   - and after a contact with a puppet the local rider's velocity change per
 *     tick is capped (6 m/s, 3 m/s upward; 5 rad/s spin), so a late, deep
 *     overlap cannot launch it. Each game resolves only its own rider: both
 *     see the other as an unmovable (kinematic) body moving at its speed. */
#define RET_PAIR    0x00070B17u
#define OVERLAP_M   3.0f
#define DV_MAX      6.0f
#define DVUP_MAX    3.0f
#define DW_MAX      5.0f
static uint32_t s_ghost[2 * RT_MAX], s_solid[2 * RT_MAX], s_local_col[2];
static int s_nghost, s_nsolid;
static double s_local_ghost_until;
static int s_contact_tick = -100;
static uint32_t s_ghost_skips, s_solid_pairs, s_solid_contacts, s_dv_clamps;
static uint32_t s_pair_va;

static Remote *slot_remote(int slot)
{
    int i;
    for (i = 0; i < MAXP; i++)
        if (s_rem[i].used && s_rem[i].slot == slot) return &s_rem[i];
    return NULL;
}

static void ghost_refresh(double now, const float *lpos)
{
    int s, ng = 0, ns = 0;
    for (s = 1; s <= s_slots && s < RT_MAX; s++) {
        uint32_t p = part(s), r = part_racer(p), u = part_unit(p);
        Remote *rm = slot_remote(s);
        int ghost = 1;
        if (!r || !u) continue;
        if (collide_on() && rm && rm->shown && lpos) {
            float d = 0;
            int k, g;
            for (k = 0; k < 3; k++) d += (rm->lastpos[k] - lpos[k]) * (rm->lastpos[k] - lpos[k]);
            d = sqrtf(d);
            g = now - rm->shown_at < s_ghost_ms || now < s_local_ghost_until ||
                (rm->cur.ext && (rm->cur.flags & SNAPF_GHOST)) || rm->kind != 1 || now < rm->snap_until;
            if (g) { rm->ghost_hold = d < OVERLAP_M; ghost = 1; }
            else if (rm->ghost_hold) { if (d >= OVERLAP_M) rm->ghost_hold = 0; ghost = rm->ghost_hold; }
            else ghost = 0;
        }
        if (rm) rm->ghost = ghost;
        if (ghost) { s_ghost[ng++] = rd32(r + 0x1C); s_ghost[ng++] = rd32(u + 0x1C); }
        else { s_solid[ns++] = rd32(r + 0x1C); s_solid[ns++] = rd32(u + 0x1C); }
    }
    s_nghost = ng;
    s_nsolid = ns;
}

static int in_list(const uint32_t *l, int n, uint32_t c)
{
    int i;
    if (!c) return 0;
    for (i = 0; i < n; i++)
        if (l[i] == c) return 1;
    return 0;
}

static void skip_pair(void)
{
    g_eax = 0;
    g_esp += 4;
    s_ghost_skips++;
}

/* A solid puppet against the local rider: the game's own handler, counted. */
static void solid_pair(void)
{
    recomp_func_t fn = recomp_lookup(s_pair_va);
    if (!fn) { skip_pair(); return; }
    fn();
    s_solid_pairs++;
    if ((int32_t)g_eax > 0) { s_solid_contacts++; s_contact_tick = s_tick; }
}

/* After the local rider's step: cap the velocity change a puppet contact made. */
static float s_prev_v[3], s_prev_w[3];
static int s_prev_ok;
static void contact_guard(uint32_t u)
{
    float v[3], w[3], dv[3], dw[3], m = 0, mw = 0;
    int i, touched = collide_on() && s_tick - s_contact_tick <= 3;
    rdv(u + B_VEL, v, 3);
    rdv(u + B_AVEL, w, 3);
    if (touched && s_prev_ok) {
        int fix = 0;
        for (i = 0; i < 3; i++) { dv[i] = v[i] - s_prev_v[i]; m += dv[i] * dv[i]; dw[i] = w[i] - s_prev_w[i]; mw += dw[i] * dw[i]; }
        m = sqrtf(m); mw = sqrtf(mw);
        if (m > DV_MAX) { for (i = 0; i < 3; i++) dv[i] *= DV_MAX / m; fix = 1; }
        if (dv[1] > DVUP_MAX) { dv[1] = DVUP_MAX; fix = 1; }
        if (mw > DW_MAX) { for (i = 0; i < 3; i++) dw[i] *= DW_MAX / mw; fix = 1; }
        if (fix) {
            for (i = 0; i < 3; i++) { v[i] = s_prev_v[i] + dv[i]; w[i] = s_prev_w[i] + dw[i]; }
            wrv(u + B_VEL, v, 3);
            wrv(u + B_AVEL, w, 3);
            s_dv_clamps++;
        }
    }
    memcpy(s_prev_v, v, sizeof v);
    memcpy(s_prev_w, w, sizeof w);
    s_prev_ok = 1;
}

/* ---- per tick (game thread) --------------------------------------------------------- */

/* The local rider's trick, tracked every tick: a new entry, or the phase
 * going back to the start, is a new trick (seq + 1). */
static uint32_t s_l_tentry, s_l_tphase;
static uint8_t  s_l_tseq;
static double   s_l_tstart;
static uint32_t s_l_tricks;
static float    s_l_lastpos[3];
static int      s_l_havepos;

static void local_trick(uint32_t r, double now)
{
    uint32_t st = rd32(r + R_STATE), e = rd32(r + R_TRICK), ph = rd32(r + R_PHASE);
    if (st == 4 && e && (e != s_l_tentry || ph < s_l_tphase)) {
        s_l_tseq++;
        s_l_tstart = now;
        s_l_tricks++;
        fprintf(stderr, "[ROAM] local trick %d started (seq %u)\n", racer_trick(r), s_l_tseq);
        fflush(stderr);
    }
    s_l_tentry = st == 4 ? e : 0;
    s_l_tphase = ph;
}

static void stats(double now)
{
    double dt = (now - s_stat_t0) / 1000.0;
    int i;
    fprintf(stderr, "[ROAM] ghost: %u puppet pairs skipped; collisions %s: %u solid pairs, %u with contacts, %u velocity caps; "
            "%u name tags (first at %.2f %.2f, %.0f m)\n",
            s_ghost_skips, collide_on() ? "on" : "off", s_solid_pairs, s_solid_contacts, s_dv_clamps,
            atv2_roam_mb.nlabels, atv2_roam_mb.labels[0].x, atv2_roam_mb.labels[0].y, atv2_roam_mb.labels[0].z);
    fprintf(stderr, "[ROAM] stats: sent %u snaps (%.1f/s, %.0f B/s payload), recv %u snaps (%.1f/s, %.0f B/s), %u bad records; local tricks %u\n",
            s_sent_snaps, s_sent_snaps / dt, s_sent_bytes / dt, s_recv_snaps, s_recv_snaps / dt, s_recv_bytes / dt,
            s_bad_recs, s_l_tricks);
    for (i = 0; i < MAXP; i++)
        if (s_rem[i].used)
            fprintf(stderr, "[ROAM]   %s id %d slot %d (rider %d, ATV %d): interval %.1f ms, jitter %.1f ms, delay %.0f ms, got %u lost %u late %u bad %u;"
                    " ticks interpolated %u extrapolated %u; shown-position jerk mean %.4f max %.3f m/tick^2; tricks seen %u shown %u; %s\n",
                    s_rem[i].name, s_rem[i].id, s_rem[i].slot, s_rem[i].rider, s_rem[i].atv, s_rem[i].interval, s_rem[i].jit,
                    s_rem[i].delay, s_rem[i].got, s_rem[i].lost, s_rem[i].late, s_rem[i].bad, s_rem[i].n_interp, s_rem[i].n_extrap,
                    s_rem[i].jerk_n ? s_rem[i].jerk_sum / s_rem[i].jerk_n : 0.0, s_rem[i].jerk_max,
                    s_rem[i].tricks_seen, s_rem[i].tricks_shown, s_rem[i].ghost ? "ghost" : "solid");
    for (i = 0; i < MAXP; i++) {
        s_rem[i].jerk_sum = s_rem[i].jerk_max = 0; s_rem[i].jerk_n = 0;
        s_rem[i].n_interp = s_rem[i].n_extrap = 0;
    }
    fflush(stderr);
    s_sent_snaps = s_recv_snaps = 0; s_sent_bytes = s_recv_bytes = 0; s_stat_t0 = now;
}

/* Local rider: after its own participant update (physics step), capture and
 * send at 30 Hz. In test mode the snapshot is also echoed as remote id 99. */
static void local_tick(uint32_t p0)
{
    uint32_t u = part_unit(p0), r = part_racer(p0);
    double now = now_ms();
    Snap s;
    uint8_t pkt[4 + 2 + SNAP_BYTES];
    float pos[3];

    s_last_local_tick = now;
    if (pump_lock()) { pump_in(now); poll_local_look(); pump_unlock(); }
    if (u) {
        int i;
        float d = 0;
        rdv(u + B_POS, pos, 3);
        for (i = 0; i < 3; i++) d += (pos[i] - s_l_lastpos[i]) * (pos[i] - s_l_lastpos[i]);
        if (!s_l_havepos || d > 4.0f * 4.0f)      /* spawn / respot: a ghost period */
            s_local_ghost_until = now + s_ghost_ms;
        memcpy(s_l_lastpos, pos, sizeof pos);
        s_l_havepos = 1;
        s_local_col[0] = r ? rd32(r + 0x1C) : 0;
        s_local_col[1] = rd32(u + 0x1C);
        contact_guard(u);
    }
    ghost_refresh(now, u ? pos : NULL);
    labels_update();
    if (!u)
        return;
    if (!s_qchecked)
        check_quat_convention(u);
    if (r) local_trick(r, now);
    if (++s_tick & 1)
        goto stat;                   /* 60 Hz ticks -> 30 Hz snapshots */
    memset(&s, 0, sizeof s);
    capture(u, &s);
    s.t = now;
    s.flags = (uint8_t)((now < s_local_ghost_until ? SNAPF_GHOST : 0) | (collide_on() ? SNAPF_COLLIDE : 0));
    s.rstate = r ? (uint8_t)clampi((int)rd32(r + R_STATE), 0, 255) : 0;
    s.trick = (int8_t)(r && rd32(r + R_STATE) == 4 ? racer_trick(r) : -1);
    s.tseq = s_l_tseq;
    s.tphase = r ? (uint8_t)clampi((int)rd32(r + R_PHASE), 0, 255) : 0;
    s.tflags = r ? (uint8_t)rd32(r + R_TFLAGS) : 0;
    s.tanim = r ? (uint16_t)rd32(r + R_ANIM) : 0xFFFF;
    s.tms = (uint16_t)clampi((int)(now - s_l_tstart), 0, 65535);
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
        Remote *rm = rem_find(99, 1);
        uint8_t raw[SNAP_BYTES];
        Snap e;
        uint32_t seq;
        float m[9];
        int i;
        if (rm && !rm->slot) {
            snprintf(rm->name, sizeof rm->name, "ECHO");
            rem_look(rm, s_test_rider >= 0 ? s_test_rider : s_my_rider, s_test_atv >= 0 ? s_test_atv : s_my_atv, -1);
            rem_assign(rm);
        }
        rdv(u + B_MAT, m, 9);
        for (i = 0; i < 3; i++) s.pos[i] += s_test == 2 ? 3.0f * m[i] + 9.0f * m[6 + i] : 5.0f * m[i];
        snap_encode(raw, s_seq, &s);
        if (snap_decode(raw, SNAP_BYTES, &seq, &e)) {
            e.t = now - 500;
            if (rm) rem_push(rm, &e, seq, now);
        }
    }
stat:
    if (now - s_stat_t0 >= 10000)
        stats(now);
}

/* A remote's trick: started on the puppet's rider with the game's own call
 * when the remote starts it (its seq changes), if the puppet's rider can take
 * it now (riding / in the air, as for the local rider); retried each tick
 * while the remote is still early in that trick. */
static void puppet_trick(Remote *rm, uint32_t p, const Snap *s)
{
    uint32_t r = part_racer(p), st;
    if (!s->ext || !r)
        return;
    if (!rm->tseq_init) { rm->tseq_init = 1; rm->tseq_done = s->tseq; return; }
    if (s->tseq == rm->tseq_done)
        return;
    if (s->rstate != 4 || s->trick < 0 || s->tphase >= 7) {
        rm->tseq_done = s->tseq;      /* over before we got to it */
        return;
    }
    st = rd32(r + R_STATE);
    if (st == 0 || st == 0x20 || (st == 4 && rd32(r + R_PHASE) == 7)) {
        gcall(sub_0002A7E0, r, 1, 1, (uint32_t)(int32_t)s->trick, 0);
        if (rd32(r + R_STATE) == 4) {
            rm->tseq_done = s->tseq;
            rm->tricks_shown++;
            fprintf(stderr, "[ROAM] %s: trick %d shown on slot %d\n", rm->name, s->trick, rm->slot);
            fflush(stderr);
        }
    }
    if (s->tseq != rm->tseq_done && s->tms > 600)
        rm->tseq_done = s->tseq;      /* the puppet could not take it in time */
}

/* A puppet slot's participant update: the unit's own step (control mode 0:
 * no AI input), then the remote pose over it. */
static void puppet_tick(uint32_t p, int slot)
{
    uint32_t u = part_unit(p);
    double now = now_ms();
    Remote *r = slot_remote(slot);
    int i, k;
    if (!u)
        return;
    /* Silent: hidden (parked) after 1.5 s -- past the 250 ms of extrapolation
     * and a reconnect's usual gap -- and forgotten after 30 s; the hub's
     * "leave" (after its resume grace) drops it at once. A resumed player
     * keeps its slot and name. */
    if (r && r->n && now - r->last_recv > 30000) {
        rem_drop(r, "timeout");
        r = NULL;
    }
    if (r && r->n && now - r->last_recv > 1500) {
        if (r->shown) {
            fprintf(stderr, "[ROAM] %s silent: hidden\n", r->name);
            fflush(stderr);
        }
        r->shown = 0;
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
        r->kind = k;
        if (k == 1) r->n_interp++; else if (k == 2) r->n_extrap++;
        if (k) {
            apply(u, &s);
            if (s.ext && r->cur.ext && s.tseq != r->cur.tseq) r->tricks_seen++;
            r->cur = s;
            if (r->shown) {
                double j = 0;
                for (i = 0; i < 3; i++) { double a = s.pos[i] - 2.0 * r->lastpos[i] + r->prevpos[i]; j += a * a; }
                j = sqrt(j);
                r->jerk_sum += j; r->jerk_n++;
                if (j > r->jerk_max) r->jerk_max = j;
                if (j > 0.5) r->snap_until = now + 300;   /* a correction: not solid for a moment */
            }
            memcpy(r->prevpos, r->lastpos, sizeof r->prevpos);
            memcpy(r->lastpos, s.pos, sizeof r->lastpos);
            if (!r->shown) {
                fprintf(stderr, "[ROAM] %s shown in slot %d at %.1f %.1f %.1f\n", r->name, slot,
                        s.pos[0], s.pos[1], s.pos[2]);
                fflush(stderr);
                r->shown = 1;
                r->shown_at = now;
                r->ghost_hold = 1;
            }
            puppet_trick(r, p, &s);
            return;
        }
    }
    park(u, slot);
}

static int puppet_slot(uint32_t p)
{
    int i;
    for (i = 1; i <= s_slots && i < RT_MAX; i++) {
        uint32_t q = part(i);
        if (!q) return 0;
        if (q == p) return i;
    }
    return 0;
}

static void hook_part_ai(void)
{
    uint32_t p = g_ecx;
    int slot = rd32(GAMEMODE) == 4 ? puppet_slot(p) : 0;
    if (slot) {
        if (s_respawn_opt && s_slot[slot].pending && now_ms() >= s_slot[slot].next_try && rd32(RACE_TIME) != 0) {
            uint32_t esp0 = g_esp;
            if (!slot_respawn(slot, p) && s_slot[slot].fails < 3) {
                s_slot[slot].pending = 1;
                s_slot[slot].next_try = now_ms() + 2000;
            }
            g_esp = esp0;
            g_ecx = p;
        }
        wr32(p + 0x20, 0);            /* no AI input */
    }
    sub_00027470();
    if (slot)
        puppet_tick(p, slot);
}

static void hook_part_human(void)
{
    uint32_t p = g_ecx;
    sub_00028340();
    if (rd32(GAMEMODE) == 4 && part(0) == p)
        local_tick(p);
}

/* Freestyle's participants: N AI riders (the puppet slots) instead of none,
 * each with its remote's rider and ATV when they are known already. */
static void hook_setup_fs(void)
{
    int s;
    fprintf(stderr, "[ROAM] freestyle: %d rider slots for other players\n", s_slots);
    fflush(stderr);
    PUSH32(g_esp, SETTINGS);
    PUSH32(g_esp, (uint32_t)s_slots);
    PUSH32(g_esp, 0xDEAD0000u);
    sub_000BB4B0();
    g_esp += 8;
    for (s = 1; s <= s_slots && s < RT_MAX; s++) {    /* the participants are new: every known look again */
        Remote *rm = slot_remote(s);
        if (rm && rm->rider >= 0 && rm->atv >= 0)
            slot_want(s, rm->rider, rm->atv);
    }
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
        u0 = part_unit(part(0));
        u1 = part_unit(part(1));
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
    if ((s_nghost || s_nsolid) && MEM32(g_esp) == RET_PAIR) {
        uint32_t a = MEM32(g_esp + 4), b = MEM32(g_esp + 8);
        int ga = in_list(s_ghost, s_nghost, a), gb = in_list(s_ghost, s_nghost, b);
        int sa = in_list(s_solid, s_nsolid, a), sb = in_list(s_solid, s_nsolid, b);
        if (ga || gb)
            return skip_pair;                       /* a ghost puppet                   */
        if (sa || sb) {
            uint32_t other = sa ? b : a;
            if ((sa && sb) || !(other == s_local_col[0] || other == s_local_col[1]))
                return skip_pair;                   /* puppet vs puppet / arena / others */
            s_pair_va = va;
            return solid_pair;                      /* solid puppet vs the local rider   */
        }
    }
    if (va == FN_PART_AI) return hook_part_ai;
    if (va == FN_PART_HUMAN) return hook_part_human;
    if (va == FN_SETUP_FS) return hook_setup_fs;
    return 0;
}

/* Every flip (gpu thread): the exe check, once the XBE is loaded. */
void atv2_roam_flip(void)
{
    if (s_checked > 0) {
        double now = now_ms();
        if (now - s_last_local_tick > 500 && pump_lock()) {   /* menus, loading */
            pump_in(now);
            poll_local_look();
            pump_unlock();
        }
        return;
    }
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

/* ---- name tags --------------------------------------------------------------------
 * Each tick the shown riders are projected with the game's view-projection
 * matrix (0x1DE768: 4x4, row vectors, D3D clip space; the render camera's pose
 * is at 0x1DE70C) into the mailbox's labels: x, y in 0..1 of the screen, z the
 * distance, flags the ghost cue. Natively gpu_d3d11.c draws them; in the
 * browser web/host/roam.js. */
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

    if (!(xs > 0.2f && xs < 10.0f)) { m->nlabels = 0; return; }
    for (i = 0; i < MAXP && n < 8; i++) {
        Remote *r = &s_rem[i];
        float d[3], x = 0, y = 0, z = 0;
        size_t len;
        if (!r->used || !r->slot || !r->shown) continue;
        d[0] = r->lastpos[0] - cam[0]; d[1] = r->lastpos[1] + 1.45f - cam[1]; d[2] = r->lastpos[2] - cam[2];
        for (k = 0; k < 3; k++) { x += d[k] * cam[3 + k]; y += d[k] * cam[6 + k]; z += d[k] * cam[9 + k]; }

        if (z < 0.5f || z > 120.0f) continue;
        m->labels[n].x = 0.5f + 0.5f * xs * x / z;
        m->labels[n].y = 0.5f - 0.5f * xs * (4.0f / 3.0f) * y / z;
        m->labels[n].z = z;
        if (m->labels[n].x < -0.1f || m->labels[n].x > 1.1f || m->labels[n].y < -0.1f || m->labels[n].y > 1.1f) continue;
        memset((void *)m->labels[n].name, 0, sizeof m->labels[n].name);
        len = strlen(r->name);
        memcpy((void *)m->labels[n].name, r->name, len < 18 ? len : 18);
        m->labels[n].flags = (uint8_t)(collide_on() ? (r->ghost ? ROAM_LABEL_GHOST : ROAM_LABEL_SOLID) : 0);
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

/* The name tags into the guest's presented frame (32-bit, w x h): white,
 * or with collisions on light blue for a ghost and yellow for a solid rider. */
void atv2_roam_draw_guest(uint32_t va, uint32_t w, uint32_t h, uint32_t pitch)
{
    RoamMailbox *m = &atv2_roam_mb;
    uint32_t i, n = m->nlabels, black = 0xFF000000u;
    if (!n || !va || pitch < w * 4 || w > 4096 || h > 4096)
        return;
    s_g_va = va; s_g_w = w; s_g_pitch = pitch;
    for (i = 0; i < n && i < 8; i++) {
        char name[20];
        int len, x, y;
        uint8_t fl = m->labels[i].flags;
        uint32_t fg = fl & ROAM_LABEL_GHOST ? 0xFF8CC8FFu : fl & ROAM_LABEL_SOLID ? 0xFFFFD040u : 0xFFFFFFFFu;
        memcpy(name, (const void *)m->labels[i].name, 19); name[19] = 0;
        len = (int)strlen(name);
        int px = m->labels[i].z < 30.0f ? 2 : 1;      /* 5x7 font: 10x14 near, 5x7 far */
        x = (int)(m->labels[i].x * w) - len * 3 * px;
        y = (int)(m->labels[i].y * h) - 7 * px;
        if (y < 1 || y + 8 * px > (int)h) continue;
        roam_text_rects(name, x, y, px, 1, guest_px, &black);
        roam_text_rects(name, x, y, px, 0, guest_px, &fg);
    }
}

void atv2_roam_init(void)
{
    const char *e = getenv("RECOMP_ROAM");
    char buf[200], *tok, *ctx = NULL;
    if (!e || !*e || !strcmp(e, "0"))
        return;
    snprintf(buf, sizeof buf, "%s", e);
    for (tok = strtok_r(buf, ",;", &ctx); tok; tok = strtok_r(NULL, ",;", &ctx)) {
        if (!strncmp(tok, "name=", 5)) snprintf(s_name, sizeof s_name, "%s", tok + 5);
        else if (!strncmp(tok, "room=", 5)) snprintf(s_room, sizeof s_room, "%s", tok + 5);
        else if (!strncmp(tok, "slots=", 6)) s_slots = atoi(tok + 6);
        else if (!strncmp(tok, "test=", 5)) s_test = atoi(tok + 5);
        else if (!strncmp(tok, "collide=", 8)) s_collide_opt = atoi(tok + 8) == 1;
        else if (!strncmp(tok, "ghost=", 6)) { double g = atof(tok + 6); if (g >= 0 && g <= 60) s_ghost_ms = g * 1000.0; }
        else if (!strncmp(tok, "respawn=", 8)) s_respawn_opt = atoi(tok + 8) == 1;
        else if (!strncmp(tok, "testlook=", 9)) sscanf(tok + 9, "%d:%d", &s_test_rider, &s_test_atv);
        else if (!strchr(tok, '=') && !s_addr[0]) snprintf(s_addr, sizeof s_addr, "%s", tok);
    }
    if (getenv("RECOMP_ROAM_TRACE")) s_trace = 1;
    if (getenv("RECOMP_ROAM_NAME")) snprintf(s_name, sizeof s_name, "%s", getenv("RECOMP_ROAM_NAME"));
    if (s_slots < 1) s_slots = 1;
    if (s_slots > RT_MAX - 1) s_slots = RT_MAX - 1;
    { char *c; for (c = s_name; *c; c++) if (*c == '"' || *c == '\\' || (unsigned char)*c < 32 || (unsigned char)*c > 126) *c = '_'; }
    { char *c; for (c = s_room; *c; c++) if (!((*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') || (*c >= '0' && *c <= '9') || *c == '-' || *c == '_')) *c = '_'; }
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
    fprintf(stderr, "[ROAM] on: hub %s, room %s, name %s, %d rider slots, collisions %s (ghost %.1f s)%s\n",
            s_addr[0] ? s_addr : "(none)", s_room, s_name, s_slots, s_collide_opt ? "on" : "off unless the room has them",
            s_ghost_ms / 1000.0, s_test ? ", test echo" : "");
    fflush(stderr);
    if (s_test && s_test_rider >= 0 && s_test_atv >= 0) {   /* the echo's look, known before the stadium */
        Remote *rm = rem_find(99, 1);
        if (rm) {
            snprintf(rm->name, sizeof rm->name, "ECHO");
            rem_look(rm, s_test_rider, s_test_atv, -1);
            rem_assign(rm);
        }
    }
    if (s_addr[0])
        atv2_roam_net_start(s_addr);
}

/* RE aid (RECOMP_ICALL_STACK=1, called from recomp_manual.c on the first call
 * through a null pointer): the guest return addresses on the stack. */
void atv2_roam_stack_dump(void)
{
    uint32_t k, sp = g_esp;
    fprintf(stderr, "[ICALL]   ecx=%08X esi=%08X edi=%08X; stack:", g_ecx, g_esi, g_edi);
    for (k = 0; k < 96; k++) {
        uint32_t v = rd32(sp + 4 * k);
        if (v >= 0x00011000u && v < 0x00190000u) fprintf(stderr, " +%X:%08X", 4 * k, v);
    }
    fprintf(stderr, "\n");
    fflush(stderr);
}
