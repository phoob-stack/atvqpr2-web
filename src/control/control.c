/*
 * control.c -- the RECOMP_CONTROL test channel.
 *
 * A loopback TCP listener that lets a harness (tools\atv-mcp) drive and
 * observe the title: pad input through usb_gamepad's queue, waits on frames or
 * on memory, screenshots, guest memory reads/writes and scans, and holding the
 * title at the flip (pause / step / resume). Text commands, one per line; one
 * JSON object per line back. `help` lists them; CONTROL.md documents them.
 *
 * Threads: the listener serves one connection at a time on its own thread.
 * atv2_control_frame() runs on the pushbuffer thread at every flip; it counts
 * frames, wakes waiters, and blocks there while paused. Nothing here touches
 * guest state from the frame hook, so pausing only stops the "GPU": the game
 * thread then stalls on its own flip/fence wait within a frame or two.
 */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <ctype.h>
#include <math.h>

#include "control.h"
#include "control_png.h"
#include "game_values.h"
#include "usb_gamepad.h"

extern ptrdiff_t xbox_GetMemoryOffset(void);
extern int xbox_FramebufferDumpBmp(const char *path);

#define GUEST_LO 0x00010000u
#define GUEST_HI 0x04000000u          /* 64 MB of RAM */

/* ---- frame clock and pause -------------------------------------------- */

static volatile LONG       s_on;
static SRWLOCK             s_lock;
static CONDITION_VARIABLE  s_cv;
static uint64_t            s_frame;          /* flips seen                 */
static unsigned            s_draws;          /* draws in the last frame    */
static double              s_fps;            /* over the last ~0.5 s       */
static uint64_t            s_fps_frame0;
static LARGE_INTEGER       s_fps_t0, s_qpf;
static int                 s_paused;         /* hold at the next flip      */
static uint64_t            s_step_budget;    /* flips to let through       */
static int                 s_held;           /* blocked in the frame hook  */
static SRWLOCK             s_cmd_lock;       /* serialises commands         */
static uint64_t            s_held_frame;

void atv2_control_frame(unsigned draws)
{
    LARGE_INTEGER now;

    usb_gamepad_frame_tick();
    if (!s_on)
        return;
    QueryPerformanceCounter(&now);
    AcquireSRWLockExclusive(&s_lock);
    s_frame++;
    s_draws = draws;
    if (!s_fps_t0.QuadPart) {
        s_fps_t0 = now;
        s_fps_frame0 = s_frame;
    } else {
        double dt = (double)(now.QuadPart - s_fps_t0.QuadPart) / (double)s_qpf.QuadPart;
        if (dt >= 0.5) {
            s_fps = (double)(s_frame - s_fps_frame0) / dt;
            s_fps_t0 = now;
            s_fps_frame0 = s_frame;
        }
    }
    WakeAllConditionVariable(&s_cv);
    if (s_paused && s_step_budget == 0) {
        s_held = 1;
        s_held_frame = s_frame;
        WakeAllConditionVariable(&s_cv);
        while (s_paused && s_step_budget == 0)
            SleepConditionVariableSRW(&s_cv, &s_lock, INFINITE, 0);
        s_held = 0;
        /* the time spent held is not frame time */
        QueryPerformanceCounter(&s_fps_t0);
        s_fps_frame0 = s_frame;
    }
    if (s_paused && s_step_budget > 0)
        s_step_budget--;
    ReleaseSRWLockExclusive(&s_lock);
}

/* Sleep until the next frame or `ms`, whichever comes first. */
static void wait_tick(DWORD ms)
{
    AcquireSRWLockExclusive(&s_lock);
    SleepConditionVariableSRW(&s_cv, &s_lock, ms, 0);
    ReleaseSRWLockExclusive(&s_lock);
}

static void snapshot_clock(uint64_t *frame, double *fps, unsigned *draws,
                           int *paused, int *held)
{
    AcquireSRWLockShared(&s_lock);
    if (frame) *frame = s_frame;
    if (fps) *fps = s_fps;
    if (draws) *draws = s_draws;
    if (paused) *paused = s_paused;
    if (held) *held = s_held;
    ReleaseSRWLockShared(&s_lock);
}

/* ---- output ------------------------------------------------------------- */

typedef struct { char *p; size_t n, cap; } Buf;

static void bput(Buf *b, const char *fmt, ...)
{
    va_list ap;
    int need;
    va_start(ap, fmt);
    need = _vscprintf(fmt, ap);
    va_end(ap);
    if (need < 0) return;
    if (b->n + (size_t)need + 1 > b->cap) {
        size_t c = b->cap ? b->cap : 256;
        char *np;
        while (c < b->n + (size_t)need + 1) c *= 2;
        if (!(np = (char *)realloc(b->p, c))) return;
        b->p = np; b->cap = c;
    }
    va_start(ap, fmt);
    vsnprintf(b->p + b->n, b->cap - b->n, fmt, ap);
    va_end(ap);
    b->n += (size_t)need;
}

static void bstr(Buf *b, const char *s)    /* JSON string */
{
    bput(b, "\"");
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') bput(b, "\\%c", c);
        else if (c < 0x20) bput(b, "\\u%04x", c);
        else bput(b, "%c", c);
    }
    bput(b, "\"");
}

static void berr(Buf *b, const char *fmt, ...)
{
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    b->n = 0;
    bput(b, "{\"ok\":false,\"error\":");
    bstr(b, msg);
    bput(b, "}");
}

static void bnum(Buf *b, double v)
{
    if (v == floor(v) && fabs(v) < 9e15) bput(b, "%.0f", v);
    else if (isnan(v) || isinf(v)) bput(b, "null");
    else bput(b, "%.9g", v);
}

/* ---- guest memory ------------------------------------------------------- */

static uint8_t *g2h(uint32_t va)
{
    return (uint8_t *)((uintptr_t)xbox_GetMemoryOffset() + va);
}

/* Is [va, va+len) committed (and writable if asked) host memory? */
static int mem_ok(uint32_t va, uint32_t len, int write)
{
    uint64_t a = va, end = (uint64_t)va + len;
    if (!len) return 1;
    if (end > 0x100000000ull) return 0;
    while (a < end) {
        MEMORY_BASIC_INFORMATION mi;
        uint8_t *h = g2h((uint32_t)a);
        DWORD pr;
        uint64_t region_end;
        if (!VirtualQuery(h, &mi, sizeof mi) || mi.State != MEM_COMMIT)
            return 0;
        pr = mi.Protect & 0xFF;
        if ((mi.Protect & PAGE_GUARD) || pr == PAGE_NOACCESS)
            return 0;
        if (write && !(pr == PAGE_READWRITE || pr == PAGE_WRITECOPY ||
                       pr == PAGE_EXECUTE_READWRITE || pr == PAGE_EXECUTE_WRITECOPY))
            return 0;
        region_end = a + ((uint8_t *)mi.BaseAddress + mi.RegionSize - h);
        a = region_end;
    }
    return 1;
}

static int type_size(char t)
{
    switch (t) {
    case 'b': case 'c': return 1;
    case 'h': case 's': return 2;
    case 'w': case 'i': case 'f': return 4;
    default: return 0;
    }
}

/* u8 u16 u32 i8 i16 i32 f32 -> b h w c s i f */
static char parse_type(const char *s)
{
    if (!s) return 0;
    if (!_stricmp(s, "u8") || !_stricmp(s, "byte")) return 'b';
    if (!_stricmp(s, "i8")) return 'c';
    if (!_stricmp(s, "u16")) return 'h';
    if (!_stricmp(s, "i16")) return 's';
    if (!_stricmp(s, "u32") || !_stricmp(s, "dword")) return 'w';
    if (!_stricmp(s, "i32") || !_stricmp(s, "int")) return 'i';
    if (!_stricmp(s, "f32") || !_stricmp(s, "float")) return 'f';
    return 0;
}

static const char *type_name(char t)
{
    switch (t) {
    case 'b': return "u8"; case 'c': return "i8"; case 'h': return "u16";
    case 's': return "i16"; case 'w': return "u32"; case 'i': return "i32";
    case 'f': return "f32"; case 'v': return "vec3 f32";
    case 'm': return "|vec3 f32|"; default: return "?";
    }
}

static double decode(const uint8_t *p, char t)
{
    uint16_t h; uint32_t w; float f;
    switch (t) {
    case 'b': return p[0];
    case 'c': return (int8_t)p[0];
    case 'h': memcpy(&h, p, 2); return h;
    case 's': memcpy(&h, p, 2); return (int16_t)h;
    case 'w': memcpy(&w, p, 4); return w;
    case 'i': memcpy(&w, p, 4); return (int32_t)w;
    case 'f': memcpy(&f, p, 4); return f;
    }
    return 0;
}

static void encode(uint8_t *p, char t, double v)
{
    uint16_t h; uint32_t w; float f;
    switch (t) {
    case 'b': case 'c': p[0] = (uint8_t)(int64_t)v; break;
    case 'h': case 's': h = (uint16_t)(int64_t)v; memcpy(p, &h, 2); break;
    case 'w': case 'i': w = (uint32_t)(int64_t)v; memcpy(p, &w, 4); break;
    case 'f': f = (float)v; memcpy(p, &f, 4); break;
    }
}

static int read_typed(uint32_t va, char t, double *out)
{
    int n = type_size(t);
    uint8_t tmp[4];
    if (!n || !mem_ok(va, (uint32_t)n, 0)) return 0;
    memcpy(tmp, g2h(va), (size_t)n);
    *out = decode(tmp, t);
    return 1;
}

static int parse_u32(const char *s, uint32_t *out)
{
    char *end;
    unsigned long long v;
    if (!s || !*s) return 0;
    v = strtoull(s, &end, 0);
    if (*end || v > 0xFFFFFFFFull) return 0;
    *out = (uint32_t)v;
    return 1;
}

static int parse_num(const char *s, double *out)
{
    char *end;
    if (!s || !*s) return 0;
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
        *out = (double)strtoull(s, &end, 16);
    else if (s[0] == '-' && s[1] == '0' && (s[2] == 'x' || s[2] == 'X'))
        *out = -(double)strtoull(s + 1, &end, 16);
    else
        *out = strtod(s, &end);
    return *end == 0;
}

/* ---- named values -------------------------------------------------------- */

static int value_count(void)
{
    int n = 0;
    while (k_atv2_values[n].name) n++;
    return n;
}

static const Atv2Value *value_find(const char *name)
{
    int i;
    for (i = 0; k_atv2_values[i].name; i++)
        if (!_stricmp(k_atv2_values[i].name, name))
            return &k_atv2_values[i];
    return NULL;
}

static int value_addr(const Atv2Value *v, uint32_t *va)
{
    uint32_t a = v->base;
    int i;
    for (i = 0; i < v->nptr; i++) {
        uint32_t p;
        if (!mem_ok(a, 4, 0)) return 0;
        memcpy(&p, g2h(a), 4);
        if (p < GUEST_LO) return 0;
        if (p >= 0x80000000u) p -= 0x80000000u;   /* RAM mirror */
        a = p + v->off[i];
    }
    *va = a;
    return 1;
}

/* Scalar value: the field itself, or for 'm' the length of the f32 vec3
 * there; times `scale` when set. 'v' (a vec3) has no scalar value. */
static int value_read(const Atv2Value *v, double *out, uint32_t *va)
{
    uint32_t a;
    double x, y, z;
    if (!value_addr(v, &a)) return 0;
    if (va) *va = a;
    if (v->type == 'v') return 0;
    if (v->type == 'm') {
        if (!read_typed(a, 'f', &x) || !read_typed(a + 4, 'f', &y) ||
            !read_typed(a + 8, 'f', &z)) return 0;
        *out = sqrt(x * x + y * y + z * z);
    } else if (!read_typed(a, v->type, out)) {
        return 0;
    }
    if (v->scale != 0) *out *= v->scale;
    *out += v->bias;
    return 1;
}

/* ---- conditions ------------------------------------------------------------ */

static int parse_op(const char *s)
{
    static const char *const ops[][2] = {
        {"eq", "=="}, {"ne", "!="}, {"lt", "<"}, {"le", "<="}, {"gt", ">"},
        {"ge", ">="}, {"changed", "changed"}, {"same", "same"},
        {"inc", "inc"}, {"dec", "dec"},
    };
    int i;
    if (!s) return -1;
    for (i = 0; i < (int)(sizeof ops / sizeof ops[0]); i++)
        if (!_stricmp(s, ops[i][0]) || !strcmp(s, ops[i][1]) ||
            (i == 0 && !strcmp(s, "=")))
            return i;
    return -1;
}

static int op_needs_value(int op) { return op >= 0 && op <= 5; }

static int compare(int op, double cur, double v, double prev)
{
    switch (op) {
    case 0: return cur == v;
    case 1: return cur != v;
    case 2: return cur < v;
    case 3: return cur <= v;
    case 4: return cur > v;
    case 5: return cur >= v;
    case 6: return cur != prev;
    case 7: return cur == prev;
    case 8: return cur > prev;
    case 9: return cur < prev;
    }
    return 0;
}

/* ---- memory scan ------------------------------------------------------------ */

static struct {
    int      active;
    char     type;
    int      size;
    uint32_t lo, hi;
    size_t   nelem, count;
    uint8_t *snap;           /* last seen bytes, (hi - lo) */
    uint64_t *cand;          /* bitmap, one bit per element */
} s_scan;

static void scan_free(void)
{
    free(s_scan.snap);
    free(s_scan.cand);
    memset(&s_scan, 0, sizeof s_scan);
}

static void scan_new(Buf *b, char t, uint32_t lo, uint32_t hi)
{
    uint32_t a;
    size_t i;
    scan_free();
    s_scan.type = t;
    s_scan.size = type_size(t);
    lo = (lo + (uint32_t)s_scan.size - 1) & ~(uint32_t)(s_scan.size - 1);
    s_scan.lo = lo; s_scan.hi = hi;
    s_scan.nelem = (hi - lo) / (uint32_t)s_scan.size;
    s_scan.snap = (uint8_t *)malloc(hi - lo);
    s_scan.cand = (uint64_t *)calloc((s_scan.nelem + 63) / 64, 8);
    if (!s_scan.snap || !s_scan.cand) {
        scan_free();
        berr(b, "out of memory");
        return;
    }
    /* 64 KB chunks; unmapped chunks are left out of the candidates */
    for (a = lo; a < hi; ) {
        uint32_t chunk_end = (a & ~0xFFFFu) + 0x10000u;
        uint32_t n;
        if (chunk_end > hi || chunk_end < a) chunk_end = hi;
        n = chunk_end - a;
        if (mem_ok(a, n, 0)) {
            size_t e0 = (a - lo) / (uint32_t)s_scan.size;
            size_t e1 = (chunk_end - lo) / (uint32_t)s_scan.size;
            memcpy(s_scan.snap + (a - lo), g2h(a), n);
            for (i = e0; i < e1; i++)
                s_scan.cand[i >> 6] |= 1ull << (i & 63);
            s_scan.count += e1 - e0;
        }
        a = chunk_end;
    }
    s_scan.active = 1;
    bput(b, "{\"ok\":true,\"type\":\"%s\",\"lo\":\"0x%08X\",\"hi\":\"0x%08X\",\"count\":%zu}",
         type_name(t), lo, hi, s_scan.count);
}

static void scan_filter(Buf *b, int op, double v)
{
    size_t w, nw = (s_scan.nelem + 63) / 64, count = 0;
    uint32_t last_bad_page = 0xFFFFFFFFu;
    for (w = 0; w < nw; w++) {
        uint64_t bits = s_scan.cand[w];
        while (bits) {
            unsigned long bit;
            size_t i;
            uint32_t va;
            uint8_t *snap;
            double cur, prev;
            _BitScanForward64(&bit, bits);
            bits &= bits - 1;
            i = w * 64 + bit;
            va = s_scan.lo + (uint32_t)(i * (size_t)s_scan.size);
            snap = s_scan.snap + (va - s_scan.lo);
            if ((va >> 12) == last_bad_page) {
                s_scan.cand[w] &= ~(1ull << bit);
                continue;
            }
            /* the page was readable at snapshot time; it normally stays so */
            cur = decode(g2h(va), s_scan.type);
            prev = decode(snap, s_scan.type);
            if (compare(op, cur, v, prev)) {
                count++;
            } else {
                s_scan.cand[w] &= ~(1ull << bit);
            }
            memcpy(snap, g2h(va), (size_t)s_scan.size);
        }
    }
    s_scan.count = count;
    bput(b, "{\"ok\":true,\"count\":%zu}", count);
}

static void scan_list(Buf *b, size_t max)
{
    size_t w, nw = (s_scan.nelem + 63) / 64, shown = 0;
    bput(b, "{\"ok\":true,\"count\":%zu,\"type\":\"%s\",\"items\":[", s_scan.count,
         type_name(s_scan.type));
    for (w = 0; w < nw && shown < max; w++) {
        uint64_t bits = s_scan.cand[w];
        while (bits && shown < max) {
            unsigned long bit;
            uint32_t va;
            _BitScanForward64(&bit, bits);
            bits &= bits - 1;
            va = s_scan.lo + (uint32_t)((w * 64 + bit) * (size_t)s_scan.size);
            bput(b, "%s[\"0x%08X\",", shown ? "," : "", va);
            bnum(b, decode(g2h(va), s_scan.type));
            bput(b, "]");
            shown++;
        }
    }
    bput(b, "]}");
}

/* ---- screenshot ---------------------------------------------------------------- */

/* The presented frame, top-down B G R rows of `*stride` bytes (malloc'd).
 * Taken through the framebuffer window's own dump, so it is exactly what the
 * window shows, the movie overlay included. */
static uint8_t *grab_frame(unsigned *ow, unsigned *oh, unsigned *ostride, int *err)
{
    char tmp[MAX_PATH];
    FILE *f;
    uint8_t hdr[54], *raw = NULL, *top = NULL;
    int32_t w, h;
    uint32_t off, row;
    uint16_t bpp;
    int y;
    long fsize;

    *err = -1;
    GetTempPathA(sizeof tmp - 40, tmp);
    snprintf(tmp + strlen(tmp), 40, "atv2_ctl_%lu.bmp", GetCurrentProcessId());
    if (xbox_FramebufferDumpBmp(tmp) != 0) {
        *err = -2;                         /* no framebuffer window */
        return NULL;
    }
    if (!(f = fopen(tmp, "rb")))
        return NULL;
    fseek(f, 0, SEEK_END);
    fsize = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (fsize < 54 || fread(hdr, 1, 54, f) != 54 || hdr[0] != 'B' || hdr[1] != 'M')
        goto out;
    memcpy(&off, hdr + 10, 4);
    memcpy(&w, hdr + 18, 4);
    memcpy(&h, hdr + 22, 4);
    memcpy(&bpp, hdr + 28, 2);
    if (bpp != 24 || w <= 0 || w > 8192 || h <= 0 || h > 8192)
        goto out;
    row = ((uint32_t)w * 3u + 3u) & ~3u;
    if ((long)(off + row * (uint32_t)h) > fsize)
        goto out;
    raw = (uint8_t *)malloc((size_t)row * (size_t)h);
    top = (uint8_t *)malloc((size_t)row * (size_t)h);
    if (!raw || !top) goto out;
    fseek(f, (long)off, SEEK_SET);
    if (fread(raw, 1, (size_t)row * (size_t)h, f) != (size_t)row * (size_t)h)
        goto out;
    for (y = 0; y < h; y++)                /* BMP is bottom-up */
        memcpy(top + (size_t)y * row, raw + (size_t)(h - 1 - y) * row, row);
    *ow = (unsigned)w; *oh = (unsigned)h; *ostride = row;
    *err = 0;
out:
    fclose(f);
    DeleteFileA(tmp);
    free(raw);
    if (*err) { free(top); top = NULL; }
    return top;
}

static int screenshot(const char *path, unsigned *ow, unsigned *oh)
{
    unsigned stride;
    int err, rc;
    uint8_t *px = grab_frame(ow, oh, &stride, &err);
    if (!px) return err;
    rc = atv2_png_write_bgr(path, px, *ow, *oh, stride);
    free(px);
    return rc;
}

/* ---- command handling ---------------------------------------------------------- */

#define MAXTOK 24

typedef struct {
    int n;
    char *t[MAXTOK];
    DWORD timeout;          /* timeout=<ms> */
} Args;

static void tokenize(char *line, Args *a)
{
    char *p = line;
    a->n = 0;
    a->timeout = 10000;
    while (*p && a->n < MAXTOK) {
        while (*p && isspace((unsigned char)*p)) p++;
        if (!*p) break;
        a->t[a->n] = p;
        while (*p && !isspace((unsigned char)*p)) p++;
        if (*p) *p++ = 0;
        if (!_strnicmp(a->t[a->n], "timeout=", 8)) {
            double v = atof(a->t[a->n] + 8);
            if (v < 0) v = 0;
            if (v > 600000) v = 600000;
            a->timeout = (DWORD)v;
            continue;
        }
        a->n++;
    }
}

/* "p1".."p4" -> 0..3, else -1 */
static int pad_token(const char *s)
{
    if (s && (s[0] == 'p' || s[0] == 'P') && s[1] >= '1' && s[1] <= '4' && !s[2])
        return s[1] - '1';
    return -1;
}

/* "6", "6f" -> 6 frames; "200ms" -> 200 ms. Returns 0 on a bad token. */
static int parse_dur(const char *s, unsigned *v, int *frames)
{
    char *end;
    unsigned long x;
    if (!s || !isdigit((unsigned char)*s)) return 0;
    x = strtoul(s, &end, 10);
    if (!*end || !_stricmp(end, "f")) *frames = 1;
    else if (!_stricmp(end, "ms")) *frames = 0;
    else if (!_stricmp(end, "s")) { *frames = 0; x *= 1000; }
    else return 0;
    *v = (unsigned)x;
    return 1;
}

static void pause_wait_held(DWORD timeout_ms, int *held, uint64_t *frame)
{
    DWORD t0 = GetTickCount();
    AcquireSRWLockExclusive(&s_lock);
    while (!s_held && GetTickCount() - t0 < timeout_ms)
        SleepConditionVariableSRW(&s_cv, &s_lock, 20, 0);
    *held = s_held;
    *frame = s_held ? s_held_frame : s_frame;
    ReleaseSRWLockExclusive(&s_lock);
}

static void cmd_info(Buf *b)
{
    uint64_t fr; double fps; unsigned draws; int paused, held, p;
    snapshot_clock(&fr, &fps, &draws, &paused, &held);
    bput(b, "{\"ok\":true,\"frame\":%llu,\"fps\":%.1f,\"draws\":%u,\"paused\":%s,"
            "\"held\":%s,\"mem_offset\":\"0x%llX\",\"pad_pending\":[",
         (unsigned long long)fr, fps, draws, paused ? "true" : "false",
         held ? "true" : "false", (unsigned long long)xbox_GetMemoryOffset());
    for (p = 0; p < USB_GAMEPAD_MAX; p++)
        bput(b, "%s%d", p ? "," : "", usb_gamepad_queue_pending(p));
    /* whether the title has enumerated and configured each pad: input is
     * only seen once it has */
    bput(b, "],\"pad_configured\":[");
    for (p = 0; p < USB_GAMEPAD_MAX; p++)
        bput(b, "%s%s", p ? "," : "", usb_gamepad_configured(p) ? "true" : "false");
    bput(b, "],\"pad_reports\":[");
    for (p = 0; p < USB_GAMEPAD_MAX; p++)
        bput(b, "%s%u", p ? "," : "", usb_gamepad_reports(p));
    /* whether a pad is plugged into each port (hot-plug, see "pads") */
    bput(b, "],\"pad_present\":[");
    for (p = 0; p < USB_GAMEPAD_MAX; p++)
        bput(b, "%s%s", p ? "," : "", usb_gamepad_present(p) ? "true" : "false");
    bput(b, "]}");
}

/* pads | pad N | pad N plug|unplug|auto: what is plugged into each port and
 * why (usb_gamepad_wanted), and the per-port plug mode. */
static void cmd_pads(Buf *b, Args *a)
{
    static const char *const mode_name[3] = { "auto", "plug", "unplug" };
    int p, lo = 0, hi = USB_GAMEPAD_MAX;
    if (a->n >= 2) {
        if (a->t[1][0] < '1' || a->t[1][0] > '4' || a->t[1][1]) {
            berr(b, "pad <1-4> [plug|unplug|auto | <command ...>]");
            return;
        }
        lo = a->t[1][0] - '1';
        hi = lo + 1;
        if (a->n >= 3) {
            const char *m = a->t[2];
            if (!_stricmp(m, "plug")) usb_gamepad_set_plug(lo, USB_PAD_ON);
            else if (!_stricmp(m, "unplug")) usb_gamepad_set_plug(lo, USB_PAD_OFF);
            else if (!_stricmp(m, "auto")) usb_gamepad_set_plug(lo, USB_PAD_AUTO);
            else { berr(b, "pad <1-4> plug|unplug|auto"); return; }
        }
    }
    bput(b, "{\"ok\":true,\"pads\":[");
    for (p = lo; p < hi; p++) {
        const char *why = "";
        int want = usb_gamepad_wanted(p, &why), mode = usb_gamepad_plug_mode(p);
        bput(b, "%s{\"port\":%d,\"present\":%s,\"wanted\":%s,\"why\":\"%s\",\"mode\":\"%s\","
                "\"configured\":%s,\"reports\":%u,\"pending\":%d}",
             p > lo ? "," : "", p + 1, usb_gamepad_present(p) ? "true" : "false",
             want ? "true" : "false", why, mode_name[mode >= 0 && mode < 3 ? mode : 0],
             usb_gamepad_configured(p) ? "true" : "false", usb_gamepad_reports(p),
             usb_gamepad_queue_pending(p));
    }
    bput(b, "]}");
}

static void cmd_state(Buf *b)
{
    uint64_t fr; double fps; int paused, i;
    snapshot_clock(&fr, &fps, NULL, &paused, NULL);
    bput(b, "{\"ok\":true,\"frame\":%llu,\"fps\":%.1f,\"paused\":%s,\"values\":{",
         (unsigned long long)fr, fps, paused ? "true" : "false");
    for (i = 0; i < value_count(); i++) {
        const Atv2Value *v = &k_atv2_values[i];
        double d;
        uint32_t va = 0;
        bput(b, "%s", i ? "," : "");
        bstr(b, v->name);
        bput(b, ":{\"value\":");
        if (v->type == 'v') {
            double x, y, z;
            if (value_addr(v, &va) && read_typed(va, 'f', &x) &&
                read_typed(va + 4, 'f', &y) && read_typed(va + 8, 'f', &z)) {
                bput(b, "[");
                bnum(b, x); bput(b, ","); bnum(b, y); bput(b, ","); bnum(b, z);
                bput(b, "]");
            } else {
                bput(b, "null");
            }
        } else if (value_read(v, &d, &va)) bnum(b, d); else bput(b, "null");
        bput(b, ",\"va\":\"0x%08X\",\"type\":\"%s\",\"verified\":%s", va,
             type_name(v->type), v->verified ? "true" : "false");
        if (v->note) { bput(b, ",\"note\":"); bstr(b, v->note); }
        bput(b, "}");
    }
    bput(b, "}}");
}

static void cmd_wait(Buf *b, Args *a)
{
    DWORD t0 = GetTickCount();
    uint64_t f0, fr;
    double fps, prev = 0, cur = 0, val = 0;
    unsigned draws;
    const char *kind = a->n > 1 ? a->t[1] : "";
    int op = -1, pad = -1, have_prev = 0;
    uint32_t va = 0, n = 0;
    char ty = 0;
    const Atv2Value *nv = NULL;

    snapshot_clock(&f0, NULL, NULL, NULL, NULL);
    if (!_stricmp(kind, "frames")) {
        if (a->n < 3 || !parse_u32(a->t[2], &n)) { berr(b, "wait frames <n>"); return; }
    } else if (!_stricmp(kind, "ms")) {
        if (a->n < 3 || !parse_u32(a->t[2], &n)) { berr(b, "wait ms <n>"); return; }
        if (a->timeout < n + 1000) a->timeout = n + 1000;
    } else if (!_stricmp(kind, "input")) {
        pad = a->n > 2 ? pad_token(a->t[2]) : -1;
    } else if (!_stricmp(kind, "pad")) {
        /* wait pad N: until port N has a pad the title has configured and
         * is reading (plug it first: "pad N plug", or press on it) */
        if (a->n < 3 || ((pad = pad_token(a->t[2])) < 0
                         && (a->t[2][0] < '1' || a->t[2][0] > '4' || a->t[2][1]))) {
            berr(b, "wait pad <1-4>");
            return;
        }
        if (pad < 0) pad = a->t[2][0] - '1';
        n = usb_gamepad_reports(pad);
    } else if (!_stricmp(kind, "mem")) {
        /* wait mem <va> <type> <op> [value] */
        if (a->n < 5 || !parse_u32(a->t[2], &va) || !(ty = parse_type(a->t[3])) ||
            (op = parse_op(a->t[4])) < 0 ||
            (op_needs_value(op) && (a->n < 6 || !parse_num(a->t[5], &val)))) {
            berr(b, "wait mem <va> <u8|u16|u32|i8|i16|i32|f32> <eq|ne|lt|le|gt|ge|changed|inc|dec> [value]");
            return;
        }
    } else if (!_stricmp(kind, "value")) {
        if (a->n < 4 || !(nv = value_find(a->t[2])) || (op = parse_op(a->t[3])) < 0 ||
            (op_needs_value(op) && (a->n < 5 || !parse_num(a->t[4], &val)))) {
            berr(b, "wait value <name> <op> [value]  (names: see state)");
            return;
        }
    } else if (!_stricmp(kind, "fps") || !_stricmp(kind, "draws")) {
        if (a->n < 4 || (op = parse_op(a->t[2])) < 0 || !op_needs_value(op) ||
            !parse_num(a->t[3], &val)) {
            berr(b, "wait %s <op> <value>", kind);
            return;
        }
    } else if (!_stricmp(kind, "held")) {
        /* until the frame hook is holding a paused title */
    } else {
        berr(b, "wait frames|ms|input|pad|mem|value|fps|draws|held ... [timeout=ms]");
        return;
    }

    for (;;) {
        int done = 0, held;
        snapshot_clock(&fr, &fps, &draws, NULL, &held);
        if (!_stricmp(kind, "frames")) done = fr - f0 >= n;
        else if (!_stricmp(kind, "ms")) done = GetTickCount() - t0 >= n;
        else if (!_stricmp(kind, "input")) {
            int p;
            done = 1;
            for (p = 0; p < USB_GAMEPAD_MAX; p++)
                if ((pad < 0 || pad == p) && usb_gamepad_queue_pending(p))
                    done = 0;
        } else if (!_stricmp(kind, "held")) done = held;
        else if (!_stricmp(kind, "pad"))
            done = usb_gamepad_present(pad) && usb_gamepad_configured(pad)
                && usb_gamepad_reports(pad) != n;
        else {
            int ok = 1;
            if (!_stricmp(kind, "mem")) ok = read_typed(va, ty, &cur);
            else if (nv) ok = value_read(nv, &cur, NULL);
            else if (!_stricmp(kind, "fps")) cur = fps;
            else cur = draws;
            if (ok) {
                if (!have_prev) { prev = cur; have_prev = 1; }
                done = (op >= 6) ? (cur != prev && compare(op, cur, val, prev))
                                 : compare(op, cur, val, prev);
                if (op == 7) done = 1;  /* "same" is trivially true at once */
            }
        }
        if (done) {
            bput(b, "{\"ok\":true,\"frame\":%llu,\"frames\":%llu,\"ms\":%lu",
                 (unsigned long long)fr, (unsigned long long)(fr - f0),
                 (unsigned long)(GetTickCount() - t0));
            if (have_prev) { bput(b, ",\"value\":"); bnum(b, cur); }
            bput(b, "}");
            return;
        }
        if (GetTickCount() - t0 >= a->timeout) {
            bput(b, "{\"ok\":false,\"error\":\"timeout\",\"frame\":%llu,\"frames\":%llu,\"ms\":%lu",
                 (unsigned long long)fr, (unsigned long long)(fr - f0),
                 (unsigned long)(GetTickCount() - t0));
            if (have_prev) { bput(b, ",\"value\":"); bnum(b, cur); }
            bput(b, "}");
            return;
        }
        wait_tick(20);
    }
}

static void cmd_input(Buf *b, Args *a)
{
    const char *verb = a->t[0];
    int i = 1, pad = 0, p;
    UsbPadInput in;

    if (a->n > i && pad_token(a->t[i]) >= 0)
        pad = pad_token(a->t[i++]);

    if (!_stricmp(verb, "press")) {
        /* press [pN] <spec> [hold] [gap] */
        unsigned hold = 6, gap = 6;
        int fr = 1, fr2 = 1, q;
        if (a->n <= i || usb_gamepad_parse_input(a->t[i], &in) != 0) {
            berr(b, "press [p1-p4] <a|b|x|y|black|white|lt|rt|up|down|left|right|start|back|"
                    "lthumb|rthumb|lleft|lright|lup|ldown|rleft|...|lx=<v>|rt=<0-255>>[+...] "
                    "[hold: N frames | Nms] [gap]");
            return;
        }
        if (a->n > i + 1 && !parse_dur(a->t[i + 1], &hold, &fr)) { berr(b, "bad hold"); return; }
        gap = fr ? 6 : 100;
        fr2 = fr;
        if (a->n > i + 2 && !parse_dur(a->t[i + 2], &gap, &fr2)) { berr(b, "bad gap"); return; }
        if (fr2 != fr) { berr(b, "hold and gap must use the same unit"); return; }
        q = usb_gamepad_queue(pad, &in, hold, gap, fr);
        if (q < 0) { berr(b, "pad queue full"); return; }
        bput(b, "{\"ok\":true,\"pad\":%d,\"queued\":%d}", pad + 1, q);
    } else if (!_stricmp(verb, "hold")) {
        if (a->n <= i || usb_gamepad_parse_input(a->t[i], &in) != 0) {
            berr(b, "hold [pN] <spec>");
            return;
        }
        usb_gamepad_hold(pad, &in);
        bput(b, "{\"ok\":true,\"pad\":%d}", pad + 1);
    } else if (!_stricmp(verb, "release")) {
        if (a->n > i) {
            if (usb_gamepad_parse_input(a->t[i], &in) != 0) { berr(b, "release [pN] [spec]"); return; }
            usb_gamepad_release(pad, &in);
        } else {
            usb_gamepad_release(pad, NULL);
        }
        bput(b, "{\"ok\":true,\"pad\":%d}", pad + 1);
    } else {   /* clear */
        if (a->n > 1 && pad_token(a->t[1]) >= 0)
            usb_gamepad_clear(pad);
        else
            for (p = 0; p < USB_GAMEPAD_MAX; p++) usb_gamepad_clear(p);
        bput(b, "{\"ok\":true}");
    }
}

static const char *k_help =
    "commands: ping | info | help | quit | "
    "press [pN] <spec> [hold] [gap] | hold [pN] <spec> | release [pN] [spec] | clear [pN] | "
    "pads | pad N [plug|unplug|auto] | key VK 1|0 | pad N <press|hold|release|clear|wait input ...> (= pN) | "
    "wait frames N | wait ms N | wait input [pN] | wait pad N | wait mem VA TYPE OP [V] | "
    "wait value NAME OP [V] | wait fps OP V | wait draws OP V | wait held  (all take timeout=MS) | "
    "screenshot PATH | color X Y [W H] | read VA LEN | write VA HEX | dump VA LEN PATH | peek VA TYPE [COUNT] | poke VA TYPE V | "
    "scan new TYPE [LO HI] | scan OP [V] | scan list [MAX] | scan count | scan free | "
    "frame | fps | pause | step [N] | resume | state";

static int handle(char *line, Buf *b)
{
    Args a;
    const char *c;
    char ptok[4];
    tokenize(line, &a);
    if (!a.n) { bput(b, "{\"ok\":true}"); return 0; }
    c = a.t[0];

    /* "pad N <command ...>" is the command for port N: "pad 2 press a" =
     * "press p2 a", "pad 3 wait input" = "wait input p3". Commands without
     * it keep meaning port 1 (or every port, for clear and wait input). */
    if (!_stricmp(c, "pad") && a.n >= 3 && a.t[1][0] >= '1' && a.t[1][0] <= '4'
        && !a.t[1][1] && _stricmp(a.t[2], "plug") && _stricmp(a.t[2], "unplug")
        && _stricmp(a.t[2], "auto")) {
        int k, at;
        snprintf(ptok, sizeof ptok, "p%c", a.t[1][0]);
        for (k = 2; k < a.n; k++) a.t[k - 2] = a.t[k];
        a.n -= 2;
        at = (!_stricmp(a.t[0], "wait") && a.n >= 2) ? 2 : 1;   /* wait input pN */
        if (a.n < MAXTOK) {
            for (k = a.n; k > at; k--) a.t[k] = a.t[k - 1];
            a.t[at] = ptok;
            a.n++;
        }
        c = a.t[0];
    }
    if (!_stricmp(c, "pads") || !_stricmp(c, "pad")) {
        cmd_pads(b, &a);
        return 0;
    }
    if (!_stricmp(c, "key")) {
        /* key <vk> <1|0>: the host keyboard's key table (xbox_InputKeySet),
         * as if the window had the key down -- tests the keyboard player
         * (needs RECOMP_KEYBOARD=1) without sending the window anything. */
        extern void xbox_InputKeySet(int vk, int down);
        uint32_t vk, down;
        if (a.n < 3 || !parse_u32(a.t[1], &vk) || vk > 255 || !parse_u32(a.t[2], &down)) {
            berr(b, "key <vk 0-255> <1|0>");
            return 0;
        }
        xbox_InputKeySet((int)vk, down != 0);
        bput(b, "{\"ok\":true}");
        return 0;
    }

    if (!_stricmp(c, "ping")) {
        uint64_t fr;
        snapshot_clock(&fr, NULL, NULL, NULL, NULL);
        bput(b, "{\"ok\":true,\"pong\":true,\"frame\":%llu,\"pid\":%lu}",
             (unsigned long long)fr, GetCurrentProcessId());
    } else if (!_stricmp(c, "help")) {
        bput(b, "{\"ok\":true,\"help\":");
        bstr(b, k_help);
        bput(b, "}");
    } else if (!_stricmp(c, "info")) {
        cmd_info(b);
    } else if (!_stricmp(c, "frame") || !_stricmp(c, "fps")) {
        uint64_t fr; double fps; unsigned draws;
        snapshot_clock(&fr, &fps, &draws, NULL, NULL);
        bput(b, "{\"ok\":true,\"frame\":%llu,\"fps\":%.1f,\"draws\":%u}",
             (unsigned long long)fr, fps, draws);
    } else if (!_stricmp(c, "state")) {
        cmd_state(b);
    } else if (!_stricmp(c, "press") || !_stricmp(c, "hold") ||
               !_stricmp(c, "release") || !_stricmp(c, "clear")) {
        cmd_input(b, &a);
    } else if (!_stricmp(c, "wait")) {
        cmd_wait(b, &a);
    } else if (!_stricmp(c, "screenshot") || !_stricmp(c, "shot")) {
        unsigned w = 0, h = 0;
        uint64_t fr;
        int rc;
        if (a.n < 2) { berr(b, "screenshot <path.png>"); return 0; }
        /* the path may contain spaces: take the rest of the line */
        {
            int k;
            for (k = 2; k < a.n; k++) a.t[k][-1] = ' ';
        }
        snapshot_clock(&fr, NULL, NULL, NULL, NULL);
        rc = screenshot(a.t[1], &w, &h);
        if (rc == -2) berr(b, "no framebuffer window (RECOMP_FB_WINDOW=1 needed)");
        else if (rc) berr(b, "screenshot failed");
        else {
            bput(b, "{\"ok\":true,\"path\":");
            bstr(b, a.t[1]);
            bput(b, ",\"width\":%u,\"height\":%u,\"frame\":%llu}", w, h,
                 (unsigned long long)fr);
        }
    } else if (!_stricmp(c, "color")) {
        /* color x y [w h]: mean R G B of a rectangle of the presented frame */
        uint32_t x, y, w = 1, h = 1, i, j;
        unsigned fw, fh, stride;
        int err;
        double sr = 0, sg = 0, sb = 0;
        uint8_t *px;
        if (a.n < 3 || !parse_u32(a.t[1], &x) || !parse_u32(a.t[2], &y) ||
            (a.n > 3 && !parse_u32(a.t[3], &w)) || (a.n > 4 && !parse_u32(a.t[4], &h)) ||
            !w || !h) { berr(b, "color x y [w h]"); return 0; }
        if (!(px = grab_frame(&fw, &fh, &stride, &err))) { berr(b, "no frame"); return 0; }
        if (x + w > fw || y + h > fh) { free(px); berr(b, "outside the %ux%u frame", fw, fh); return 0; }
        for (j = y; j < y + h; j++)
            for (i = x; i < x + w; i++) {
                const uint8_t *q = px + (size_t)j * stride + (size_t)i * 3;
                sb += q[0]; sg += q[1]; sr += q[2];
            }
        free(px);
        bput(b, "{\"ok\":true,\"r\":%.1f,\"g\":%.1f,\"b\":%.1f}",
             sr / (w * h), sg / (w * h), sb / (w * h));
    } else if (!_stricmp(c, "read")) {
        uint32_t va, len, i;
        const uint8_t *p;
        if (a.n < 3 || !parse_u32(a.t[1], &va) || !parse_u32(a.t[2], &len) ||
            len > (1u << 20)) { berr(b, "read <va> <len <= 1048576>"); return 0; }
        if (!mem_ok(va, len, 0)) { berr(b, "0x%08X+%u is not mapped", va, len); return 0; }
        p = g2h(va);
        bput(b, "{\"ok\":true,\"va\":\"0x%08X\",\"len\":%u,\"hex\":\"", va, len);
        for (i = 0; i < len; i++) bput(b, "%02x", p[i]);
        bput(b, "\"}");
    } else if (!_stricmp(c, "dump")) {
        /* dump <va> <len> <path>: raw bytes to a local file (unmapped pages
         * as zeros), for offline analysis */
        uint32_t va, len, at;
        FILE *f;
        if (a.n < 4 || !parse_u32(a.t[1], &va) || !parse_u32(a.t[2], &len) ||
            (uint64_t)va + len > GUEST_HI) { berr(b, "dump <va> <len> <path> (below 0x4000000)"); return 0; }
        {
            int k;
            for (k = 4; k < a.n; k++) a.t[k][-1] = ' ';
        }
        if (!(f = fopen(a.t[3], "wb"))) { berr(b, "cannot open %s", a.t[3]); return 0; }
        for (at = va; at < va + len; ) {
            static const uint8_t zero[4096];
            uint32_t n = 4096 - (at & 4095);
            if (n > va + len - at) n = va + len - at;
            fwrite(mem_ok(at, n, 0) ? g2h(at) : zero, 1, n, f);
            at += n;
        }
        fclose(f);
        bput(b, "{\"ok\":true,\"va\":\"0x%08X\",\"len\":%u}", va, len);
    } else if (!_stricmp(c, "write")) {
        uint32_t va, len, i;
        const char *hx;
        uint8_t *tmp;
        if (a.n < 3 || !parse_u32(a.t[1], &va)) { berr(b, "write <va> <hex bytes>"); return 0; }
        hx = a.t[2];
        len = (uint32_t)strlen(hx) / 2;
        if (!len || strlen(hx) % 2) { berr(b, "hex must have an even length"); return 0; }
        if (!mem_ok(va, len, 1)) { berr(b, "0x%08X+%u is not writable", va, len); return 0; }
        tmp = (uint8_t *)malloc(len);
        for (i = 0; i < len; i++) {
            unsigned v;
            if (sscanf(hx + 2 * i, "%2x", &v) != 1 || !isxdigit((unsigned char)hx[2*i+1])) {
                free(tmp); berr(b, "bad hex"); return 0;
            }
            tmp[i] = (uint8_t)v;
        }
        memcpy(g2h(va), tmp, len);
        free(tmp);
        bput(b, "{\"ok\":true,\"va\":\"0x%08X\",\"len\":%u}", va, len);
    } else if (!_stricmp(c, "peek")) {
        uint32_t va, cnt = 1, i;
        char t;
        if (a.n < 3 || !parse_u32(a.t[1], &va) || !(t = parse_type(a.t[2])) ||
            (a.n > 3 && (!parse_u32(a.t[3], &cnt) || cnt < 1 || cnt > 4096))) {
            berr(b, "peek <va> <u8|u16|u32|i8|i16|i32|f32> [count]"); return 0;
        }
        if (!mem_ok(va, cnt * (uint32_t)type_size(t), 0)) { berr(b, "not mapped"); return 0; }
        bput(b, "{\"ok\":true,\"va\":\"0x%08X\",\"type\":\"%s\",\"values\":[", va, type_name(t));
        for (i = 0; i < cnt; i++) {
            bput(b, "%s", i ? "," : "");
            bnum(b, decode(g2h(va + i * (uint32_t)type_size(t)), t));
        }
        bput(b, "]}");
    } else if (!_stricmp(c, "poke")) {
        uint32_t va;
        char t;
        double v;
        if (a.n < 4 || !parse_u32(a.t[1], &va) || !(t = parse_type(a.t[2])) ||
            !parse_num(a.t[3], &v)) { berr(b, "poke <va> <type> <value>"); return 0; }
        if (!mem_ok(va, (uint32_t)type_size(t), 1)) { berr(b, "not writable"); return 0; }
        encode(g2h(va), t, v);
        bput(b, "{\"ok\":true}");
    } else if (!_stricmp(c, "scan")) {
        const char *s = a.n > 1 ? a.t[1] : "";
        if (!_stricmp(s, "new")) {
            char t = a.n > 2 ? parse_type(a.t[2]) : 0;
            uint32_t lo = GUEST_LO, hi = GUEST_HI;
            if (!t || (a.n > 3 && !parse_u32(a.t[3], &lo)) ||
                (a.n > 4 && !parse_u32(a.t[4], &hi)) || hi <= lo || hi > GUEST_HI) {
                berr(b, "scan new <type> [lo hi]  (within 0x10000..0x4000000)"); return 0;
            }
            scan_new(b, t, lo, hi);
        } else if (!s_scan.active) {
            berr(b, "no scan: scan new <type> first");
        } else if (!_stricmp(s, "list")) {
            uint32_t mx = 50;
            if (a.n > 2) parse_u32(a.t[2], &mx);
            scan_list(b, mx);
        } else if (!_stricmp(s, "count")) {
            bput(b, "{\"ok\":true,\"count\":%zu}", s_scan.count);
        } else if (!_stricmp(s, "free")) {
            scan_free();
            bput(b, "{\"ok\":true}");
        } else {
            int op = parse_op(s);
            double v = 0;
            if (op < 0 || (op_needs_value(op) && (a.n < 3 || !parse_num(a.t[2], &v)))) {
                berr(b, "scan <eq|ne|lt|le|gt|ge> <v> | scan <changed|same|inc|dec>"); return 0;
            }
            scan_filter(b, op, v);
        }
    } else if (!_stricmp(c, "pause")) {
        int held; uint64_t fr;
        AcquireSRWLockExclusive(&s_lock);
        s_paused = 1;
        s_step_budget = 0;
        ReleaseSRWLockExclusive(&s_lock);
        pause_wait_held(a.timeout < 3000 ? a.timeout : 3000, &held, &fr);
        bput(b, "{\"ok\":true,\"paused\":true,\"held\":%s,\"frame\":%llu}",
             held ? "true" : "false", (unsigned long long)fr);
    } else if (!_stricmp(c, "step")) {
        uint32_t n = 1;
        int held; uint64_t fr, target;
        DWORD t0 = GetTickCount();
        if (a.n > 1 && (!parse_u32(a.t[1], &n) || !n)) { berr(b, "step [n >= 1]"); return 0; }
        AcquireSRWLockExclusive(&s_lock);
        if (!s_paused) {
            ReleaseSRWLockExclusive(&s_lock);
            berr(b, "not paused");
            return 0;
        }
        target = (s_held ? s_held_frame : s_frame) + n;
        s_step_budget += n;
        WakeAllConditionVariable(&s_cv);
        while (!(s_held && s_held_frame >= target) && GetTickCount() - t0 < a.timeout)
            SleepConditionVariableSRW(&s_cv, &s_lock, 20, 0);
        held = s_held && s_held_frame >= target;
        fr = s_held ? s_held_frame : s_frame;
        ReleaseSRWLockExclusive(&s_lock);
        if (held)
            bput(b, "{\"ok\":true,\"frame\":%llu}", (unsigned long long)fr);
        else
            bput(b, "{\"ok\":false,\"error\":\"timeout\",\"frame\":%llu}", (unsigned long long)fr);
    } else if (!_stricmp(c, "resume")) {
        uint64_t fr;
        AcquireSRWLockExclusive(&s_lock);
        s_paused = 0;
        s_step_budget = 0;
        fr = s_frame;
        WakeAllConditionVariable(&s_cv);
        ReleaseSRWLockExclusive(&s_lock);
        bput(b, "{\"ok\":true,\"frame\":%llu}", (unsigned long long)fr);
    } else if (!_stricmp(c, "quit") || !_stricmp(c, "exit")) {
        bput(b, "{\"ok\":true,\"quitting\":true}");
        return 1;
    } else {
        berr(b, "unknown command '%s' (try help)", c);
    }
    return 0;
}

/* ---- the listener ---------------------------------------------------------------- */

static int send_all(SOCKET s, const char *p, size_t n)
{
    while (n) {
        int k = send(s, p, n > 1 << 20 ? 1 << 20 : (int)n, 0);
        if (k <= 0) return -1;
        p += k; n -= (size_t)k;
    }
    return 0;
}

#define IN_MAX (1 << 16)

static void serve(SOCKET c)
{
    char *in = (char *)malloc(IN_MAX);
    size_t have = 0;
    Buf b = { 0 };
    if (!in) return;

    for (;;) {
        char *nl;
        int k;
        while ((nl = (char *)memchr(in, '\n', have)) != NULL) {
            size_t len = (size_t)(nl - in);
            int quit;
            *nl = 0;
            if (len && in[len - 1] == '\r') in[len - 1] = 0;
            b.n = 0;
            {
                /* Commands share the scan state and the screenshot temp
                 * file, so they run one at a time -- except the ones that
                 * block (wait, step, pause), which only touch the frame
                 * clock and must not hold up other clients. */
                const char *p0 = in;
                int blocking;
                while (*p0 == ' ' || *p0 == '	') p0++;
                blocking = !_strnicmp(p0, "wait", 4) || !_strnicmp(p0, "step", 4) ||
                           !_strnicmp(p0, "pause", 5);
                if (!blocking) AcquireSRWLockExclusive(&s_cmd_lock);
                quit = handle(in, &b);
                if (!blocking) ReleaseSRWLockExclusive(&s_cmd_lock);
            }
            bput(&b, "\n");
            send_all(c, b.p, b.n);
            memmove(in, nl + 1, have - len - 1);
            have -= len + 1;
            if (quit) {
                fprintf(stderr, "[CTL] quit requested\n");
                fflush(stderr);
                shutdown(c, SD_SEND);
                closesocket(c);
                TerminateProcess(GetCurrentProcess(), 0);
            }
        }
        if (have == IN_MAX) {               /* overlong line: drop it */
            have = 0;
            send_all(c, "{\"ok\":false,\"error\":\"line too long\"}\n", 37);
        }
        k = recv(c, in + have, (int)(IN_MAX - have), 0);
        if (k <= 0) break;
        have += (size_t)k;
    }
    free(b.p);
    free(in);
}

static volatile LONG s_clients;

static DWORD WINAPI client_thread(LPVOID arg)
{
    SOCKET c = (SOCKET)(uintptr_t)arg;
    serve(c);
    closesocket(c);
    InterlockedDecrement(&s_clients);
    return 0;
}

static DWORD WINAPI listener(LPVOID arg)
{
    unsigned short port = (unsigned short)(uintptr_t)arg;
    WSADATA wd;
    SOCKET ls;
    struct sockaddr_in sa;
    BOOL yes = TRUE;

    if (WSAStartup(MAKEWORD(2, 2), &wd)) {
        fprintf(stderr, "[CTL] WSAStartup failed\n");
        return 0;
    }
    ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (ls == INVALID_SOCKET) return 0;
    setsockopt(ls, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&yes, sizeof yes);
    memset(&sa, 0, sizeof sa);
    sa.sin_family = AF_INET;
    sa.sin_port = htons(port);
    sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);     /* loopback only */
    if (bind(ls, (struct sockaddr *)&sa, sizeof sa) || listen(ls, 4)) {
        fprintf(stderr, "[CTL] cannot listen on 127.0.0.1:%u (error %d)\n", port,
                WSAGetLastError());
        fflush(stderr);
        closesocket(ls);
        return 0;
    }
    fprintf(stderr, "[CTL] control channel listening on 127.0.0.1:%u\n", port);
    fflush(stderr);
    for (;;) {
        struct sockaddr_in peer;
        int plen = sizeof peer;
        SOCKET c = accept(ls, (struct sockaddr *)&peer, &plen);
        if (c == INVALID_SOCKET) { Sleep(100); continue; }
        if (peer.sin_family != AF_INET ||
            (ntohl(peer.sin_addr.s_addr) >> 24) != 127) {
            closesocket(c);
            continue;
        }
        setsockopt(c, IPPROTO_TCP, TCP_NODELAY, (const char *)&yes, sizeof yes);
        /* a few clients at once (an MCP server holding its connection and a
         * shell CLI); each on its own thread */
        if (InterlockedIncrement(&s_clients) > 8) {
            InterlockedDecrement(&s_clients);
            static const char busy[] = "{\"ok\":false,\"error\":\"too many clients\"}\n";
            send_all(c, busy, sizeof busy - 1);
            closesocket(c);
            continue;
        }
        CloseHandle(CreateThread(NULL, 0, client_thread, (LPVOID)(uintptr_t)c, 0, NULL));
    }
}

void atv2_control_init(void)
{
    const char *e = getenv("RECOMP_CONTROL");
    const char *ps;
    unsigned long port;
    char *end;

    if (!e || !*e || !strcmp(e, "0"))
        return;
    /* "<port>" or "127.0.0.1:<port>" / "localhost:<port>"; nothing else */
    ps = strrchr(e, ':');
    if (ps) {
        size_t hl = (size_t)(ps - e);
        if (!((hl == 9 && !strncmp(e, "127.0.0.1", 9)) ||
              (hl == 9 && !_strnicmp(e, "localhost", 9)))) {
            fprintf(stderr, "[CTL] RECOMP_CONTROL=%s refused: loopback only "
                            "(use <port> or 127.0.0.1:<port>)\n", e);
            return;
        }
        ps++;
    } else {
        ps = e;
    }
    port = strtoul(ps, &end, 10);
    if (*end || port == 0 || port > 65535) {
        fprintf(stderr, "[CTL] RECOMP_CONTROL=%s: not a port\n", e);
        return;
    }
    QueryPerformanceFrequency(&s_qpf);
    InterlockedExchange(&s_on, 1);
    CloseHandle(CreateThread(NULL, 0, listener, (LPVOID)(uintptr_t)port, 0, NULL));
}
