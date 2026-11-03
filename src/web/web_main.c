/*
 * Browser entry point (wasm32-wasip1-threads): main.c's boot sequence
 * without Win32 -- no VEH, dbghelp, WinMain, message boxes, stderr flusher
 * thread or control channel.
 *
 * The page (web/host) runs this module's _start on a Worker (the guest main
 * thread) with a WASI filesystem it implements in JS:
 *   /game  the player's own game folder, read-only, fetched from the local
 *          dev server in 1 MiB blocks and cached in OPFS
 *   /save  the save side (xbox_path_init's save dir: UDATA, TDATA, the
 *          partition images), in memory for now
 * Environment variables come from the page (DEFAULT_ENV in web/host/main.js,
 * overridable with ?env=K=V,K=V), as run.ps1 sets them natively.
 *
 * Faults: a wasm trap unwinds to the worker, which calls the exported
 * web_report_crash() to print the guest registers and the guest stack scan,
 * as main.c's handler does. There is no page fault to catch, so the MMIO
 * register traps are wasm-mem's explicit checks, not a handler here.
 */
#include "win32_compat.h"

#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <string.h>
#include <pthread.h>
#include <time.h>

#include <xbox/xboxrecomp.h>
#include "web_host.h"

extern RECOMP_TLS uint32_t g_eax, g_ecx, g_edx, g_esp;
extern RECOMP_TLS uint32_t g_ebx, g_esi, g_edi;
extern ptrdiff_t g_xbox_mem_offset;

#define ATV2_ENTRY_POINT 0x000CA76D
#define ATV2_XBE_PATH    "/game/default.xbe"
#define ATV2_GAME_DIR    "/game"
#define ATV2_SAVE_DIR    "/save"

typedef struct MCPXAPUState MCPXAPUState;
extern MCPXAPUState *mcpx_apu_init_standalone(uint8_t *ram_ptr);
extern MCPXAPUState *g_apu_state;
int recomp_dispatch_init(void);
extern void xbe_entry_point(void);

/* ---- the host block --------------------------------------------------- */

static WebHost s_host = {
    .magic = WEB_HOST_MAGIC, .version = WEB_HOST_VERSION, .size = sizeof(WebHost),
};

__attribute__((export_name("web_host")))
WebHost *web_host(void) { return &s_host; }

/* Free roam (src/roam.c): the page finds the roam mailbox at reserved[0]
 * (web/host/roam.js) and is its WebSocket transport. */
void web_host_set_roam(void *mb)
{
    s_host.reserved[0] = (uint32_t)(uintptr_t)mb;
}

/* Tells the page where the host block is (web/host/imports.js). */
__attribute__((import_module("env"), import_name("web_host_ready")))
void web_host_ready(WebHost *h);

static void stage(uint32_t s)
{
    __atomic_store_n(&s_host.boot_stage, s, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int *)&s_host.boot_stage, ~0u);
}

/* The control channel (src/control) is winsock; the recorder still calls its
 * per-frame hook. */
void atv2_control_frame(unsigned draws) { (void)draws; }
void atv2_control_init(void) {}

/* ---- crash report (called by the worker after a trap) ------------------ */

void xbox_WasmStdioDrain(unsigned ms);   /* xboxrecomp platform/wasm_stdio.c */

__attribute__((export_name("web_report_crash")))
void web_report_crash(void)
{
    fprintf(stderr, "[CRASH] wasm trap; guest eax=%08X ecx=%08X edx=%08X ebx=%08X"
            " esi=%08X edi=%08X esp=%08X\n", g_eax, g_ecx, g_edx, g_ebx, g_esi,
            g_edi, g_esp);
    if (g_xbox_mem_offset && g_esp) {
        const uint32_t *sp = (const uint32_t *)((uintptr_t)g_xbox_mem_offset + g_esp);
        int shown = 0, i;
        fprintf(stderr, "  guest stack (return addresses, innermost first):\n");
        for (i = 0; i < 256 && shown < 24; i++) {
            uint32_t v = sp[i];
            if (v > g_xbox_code_lo && v < g_xbox_code_hi) {
                fprintf(stderr, "    [esp+%-4d] 0x%08X\n", i * 4, v);
                shown++;
            }
        }
        if (!shown)
            fprintf(stderr, "    (no return addresses in range)\n");
    }
    fflush(stderr);
    /* stdout and stderr are queued for a drain thread (wasm_stdio.c): give
     * it the report before the page ends the Workers. */
    xbox_WasmStdioDrain(500);
}

/* ---- fast kickoff ack (main.c's kick_ack_thread, on pthreads) ---------- */

extern volatile uint32_t *xbox_Nv2aRegPtr(uint32_t offset);
extern int nv2a_pb_exec_flip_held(void);

static void *kick_ack_thread(void *unused)
{
    volatile uint32_t *r;
    unsigned idle = 0;
    (void)unused;
    while (!(r = xbox_Nv2aRegPtr(0x100410)))
        Sleep(1);
    for (;;) {
        if ((*r & 0x10000) && !nv2a_pb_exec_flip_held()) {
            __atomic_fetch_and(r, ~0x10000u, __ATOMIC_SEQ_CST);
            idle = 0;
        } else if (++idle >= 4096) {
            idle = 0;
            sched_yield();
        }
    }
    return NULL;
}

void atv_kick_ack_start_wasm(void);   /* src/wasm/kick_ack_wasm.c */

/* The ack waits on the register word (memory.atomic.wait32) instead of
 * spinning a Worker: src/wasm/kick_ack_wasm.c (wasm-threads). */
static void kick_ack_start(void)
{
    const char *e = getenv("RECOMP_FAST_KICK");
    if (e && *e == '1') {
        atv_kick_ack_start_wasm();
        return;
    }
    pthread_t t;
    if (!e || *e != '1')
        return;
    if (pthread_create(&t, NULL, kick_ack_thread, NULL) != 0) {
        fprintf(stderr, "[BOOT] RECOMP_FAST_KICK=1 but no thread for the ack;"
                " kickoff stays on the walk's ack\n");
        return;
    }
    pthread_detach(t);
    fprintf(stderr, "[BOOT] fast kickoff ack on, pushbuffer walk %s\n",
            getenv("RECOMP_PB_WALK") ? getenv("RECOMP_PB_WALK") : "segment");
}

/* ---- boot --------------------------------------------------------------- */

static bool load_xbe(const char *path, void **out_data, size_t *out_size)
{
    FILE *f = fopen(path, "rb");
    long size;
    void *data;

    if (!f) {
        fprintf(stderr, "Cannot open XBE: %s\n", path);
        return false;
    }
    fseek(f, 0, SEEK_END);
    size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0 || !(data = malloc((size_t)size))) {
        fclose(f);
        return false;
    }
    if (fread(data, 1, (size_t)size, f) != (size_t)size) {
        free(data);
        fclose(f);
        return false;
    }
    fclose(f);
    *out_data = data;
    *out_size = (size_t)size;
    return true;
}

static int fail(uint32_t at, const char *what)
{
    fprintf(stderr, "[BOOT] FAILED: %s\n", what);
    fflush(stderr);
    stage(WEB_STAGE_FAILED | at);
    return 1;
}

int main(int argc, char **argv)
{
    void *xbe_data = NULL;
    size_t xbe_size = 0;
    (void)argc; (void)argv;

    /* One fd_write per line: the worker forwards each to the page. */
    setvbuf(stdout, NULL, _IOLBF, 0);
    setvbuf(stderr, NULL, _IOLBF, 1 << 14);
    stage(WEB_STAGE_START);
    web_host_ready(&s_host);

    setenv("RECOMP_DISPATCH_GATE", "1", 0);
    {
        const char *fk = getenv("RECOMP_FAST_KICK");
        if (fk && *fk == '1')
            setenv("RECOMP_PB_WALK", "dma", 0);
    }

    printf("=== ATV Quad Power Racing 2 - static recompilation (browser) ===\n");

    if (!load_xbe(ATV2_XBE_PATH, &xbe_data, &xbe_size))
        return fail(WEB_STAGE_XBE, "cannot read " ATV2_XBE_PATH
                    " (is the game folder served at /data/?)");
    printf("XBE loaded: %zu bytes\n", xbe_size);
    stage(WEB_STAGE_XBE);

    printf("Initializing Xbox memory layout...\n");
    if (!xbox_MemoryLayoutInit(xbe_data, xbe_size))
        return fail(WEB_STAGE_MEMORY, "xbox_MemoryLayoutInit");
    g_xbox_mem_offset = xbox_GetMemoryOffset();
    s_host.mem_offset = (uint32_t)g_xbox_mem_offset;
    printf("Xbox memory mapped. Offset: 0x%08X\n", (unsigned)g_xbox_mem_offset);
    stage(WEB_STAGE_MEMORY);

    if (getenv("RECOMP_AC97_READY")) {
        g_apu_state = mcpx_apu_init_standalone((uint8_t *)xbox_GetMemoryBase());
        fprintf(stderr, "[BOOT] emulated APU %s\n",
                g_apu_state ? "up" : "FAILED to initialise");
    }
    stage(WEB_STAGE_APU);

    {
        extern void xbox_OhciInit(void);
        xbox_OhciInit();
    }
    stage(WEB_STAGE_OHCI);

    printf("Initializing Xbox kernel replacement...\n");
    xbox_kernel_init();
    stage(WEB_STAGE_KERNEL);

    {
        extern void xbox_path_init(const char *game_dir, const char *save_dir);
        xbox_path_init(ATV2_GAME_DIR, ATV2_SAVE_DIR);
    }
    stage(WEB_STAGE_PATHS);

    printf("Initializing kernel bridge...\n");
    xbox_kernel_bridge_init();
    g_esp = XBOX_STACK_TOP;
    stage(WEB_STAGE_BRIDGE);

    printf("Entry point: 0x%08X  ESP: 0x%08X\n", ATV2_ENTRY_POINT, g_esp);
    if (!recomp_dispatch_init())
        fprintf(stderr, "[BOOT] flat dispatch unavailable; "
                        "indirect calls will use the binary search\n");
    stage(WEB_STAGE_DISPATCH);

    xbox_WatchdogStart();
    /* ATV 2 retail: XDK D3D device pointer at 0x1A50E8; write sequence +0x2C,
     * pointer to the GPU's progress +0x30 (fence wait 0x196CF0). With the fast
     * kick (the DMA walk) the mirror only names that word: the walk's
     * SEMAPHORE_RELEASE writes it, since a mirror let D3D overwrite pushbuffer
     * the walk had not read (xboxrecomp nv2a_pb_walk_owns_fence). */
    xbox_Nv2aMirrorFence(0x001A50E8, 0x2C, 0x30);
    {
        extern void atv2_gpu_backend_install(void);
        atv2_gpu_backend_install();
    }
    kick_ack_start();
    stage(WEB_STAGE_GPU);
    /* RECOMP_FREERIDE=1 (?env=RECOMP_FREERIDE=1): straight into Freestyle,
     * Unlimited Time (src/freeride.c). */
    {
        extern void atv2_freeride_init(void);
        atv2_freeride_init();
    }
    /* RECOMP_ROAM=host:port[;name=..] (?env=...): free roam in Free Ride. */
    {
        extern void atv2_roam_init(void);
        atv2_roam_init();
    }

    printf("\nStarting game...\n");
    fflush(stdout);
    stage(WEB_STAGE_ENTRY);
    xbe_entry_point();

    printf("\nGame returned.\n");
    stage(WEB_STAGE_RETURNED);
    xbox_kernel_shutdown();
    xbox_MemoryLayoutShutdown();
    free(xbe_data);
    return 0;
}
