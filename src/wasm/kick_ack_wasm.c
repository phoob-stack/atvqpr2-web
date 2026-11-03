/*
 * kick_ack_wasm.c - the fast kickoff ack (RECOMP_FAST_KICK=1) for the wasm
 * build. main.c's kick_ack_thread is the native one: it spins a host core on
 * 0x100410 bit 16 so D3D's KickOff spin ends at once. On the web that would
 * keep a Worker (and a CPU core) busy forever, so this one sleeps on the
 * register word itself with memory.atomic.wait32:
 *  - when the MMIO store path calls xbox_WasmPollWake on 0x100410 (see
 *    WASM-THREADS.md, "wake hooks"), the ack follows the store at once;
 *  - otherwise it looks every KICK_POLL_NS, which bounds the KickOff spin.
 * A flip held for its vblank keeps the bit up, as natively (main.c).
 *
 * Started by the web main (wasm-host) instead of main.c's kick_ack_start:
 *     if (fast kick) atv_kick_ack_start_wasm();
 */
#if defined(__wasm__)

#include "win32_compat.h"
#include "platform/wasm_threads.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

extern volatile uint32_t *xbox_Nv2aRegPtr(uint32_t offset);
extern int nv2a_pb_exec_flip_held(void);

#define KICK_REG        0x100410u
#define KICK_BUSY       0x10000u
#define KICK_POLL_NS    200000u          /* 0.2 ms without a wake hook */

static DWORD WINAPI kick_ack_wasm_thread(LPVOID unused)
{
    volatile uint32_t *r;

    (void)unused;
    while (!(r = xbox_Nv2aRegPtr(KICK_REG)))
        xbox_WasmSleepNs(1000000u);
    for (;;) {
        uint32_t v = __atomic_load_n(r, __ATOMIC_SEQ_CST);
        if ((v & KICK_BUSY) && !nv2a_pb_exec_flip_held()) {
            __atomic_fetch_and(r, ~KICK_BUSY, __ATOMIC_SEQ_CST);
            continue;
        }
        /* Wait on the value just loaded: a store in between returns at once. */
        xbox_WasmPollWait(r, v, KICK_POLL_NS);
    }
    return 0;
}

void atv_kick_ack_start_wasm(void)
{
    HANDLE t = CreateThread(NULL, 0, kick_ack_wasm_thread, NULL, 0, NULL);
    if (t)
        CloseHandle(t);
    fprintf(stderr, "[BOOT] fast kickoff ack on (wasm, waits on 0x%X), pushbuffer"
            " walk %s\n", KICK_REG,
            getenv("RECOMP_PB_WALK") ? getenv("RECOMP_PB_WALK") : "segment");
}

#endif /* __wasm__ */
