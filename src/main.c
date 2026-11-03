#ifndef _WIN32
#define _GNU_SOURCE
#endif
/**
 * YOUR_GAME_NAME - Recompiled Game Entry Point
 *
 * This is the Windows executable that hosts the recompiled game code.
 * It performs the following initialization sequence:
 *
 * 1. Load the original XBE file from disk
 * 2. Initialize the Xbox memory layout (map data sections to original VAs)
 * 3. Initialize the Xbox kernel replacement layer
 * 4. Initialize the kernel bridge (thunk table in Xbox memory)
 * 5. Set up game file paths for I/O redirection
 * 6. Initialize the stack pointer
 * 7. Install VEH crash handler for diagnostics
 * 8. Call the game's original entry point (recompiled)
 *
 * Customize this file for your game:
 *   - Set YOUR_GAME_ENTRY_POINT to the XBE entry point address
 *   - Set YOUR_GAME_XBE_PATH to where the XBE file lives
 *   - Set YOUR_GAME_DIR to the game data directory
 *   - Add any CRT global pre-initialization your game needs
 *   - Customize the VEH handler for game-specific crash diagnosis
 *
 * XBE Details (fill in from xbe_parser output):
 *   Title:       YOUR_GAME_NAME
 *   Title ID:    0x00000000
 *   Base addr:   0x00010000
 *   Entry point: 0x00000000
 *   Code size:   ~??? KB (.text)
 *   Sections:    ?? (list them)
 *   Kernel imports: ??
 */

#ifdef _WIN32
#include <windows.h>
#include <dbghelp.h>
#else
#include "win32_compat.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <string.h>
#include <math.h>

/* xboxrecomp runtime headers */
#include <xbox/xboxrecomp.h>

/*
 * If xboxrecomp.h is not an umbrella header in your setup, include
 * the individual headers directly:
 *
 * #include "kernel.h"
 * #include "xbox_memory_layout.h"
 * #include "d3d8_xbox.h"
 * #include "dsound_xbox.h"
 * #include "xinput_xbox.h"
 */

/* ── Global register state (defined in xbox_memory_layout.c) ── */

/* RECOMP_TLS is not optional here. The runtime defines these thread-local, and
 * a plain `extern` referencing a __declspec(thread) variable does not resolve
 * to the calling thread's copy -- it resolves to the image's TLS template. The
 * host side then writes g_esp somewhere the generated code never reads, so the
 * guest starts with every register at zero and faults immediately, having
 * apparently ignored the setup that visibly ran. */
extern RECOMP_TLS uint32_t g_eax, g_ecx, g_edx, g_esp;
extern RECOMP_TLS uint32_t g_ebx, g_esi, g_edi;
extern RECOMP_TLS uint32_t g_seh_ebp;
/* x87 and SSE state. Global for the same reason the volatile GPRs are: one
 * guest routine can lift to several C functions, so a value written in one
 * body is read in the next. Defined in xbox_memory_layout.c like the rest of
 * the register file. */
extern RECOMP_TLS double g_fp_stack[8];
extern RECOMP_TLS int g_fp_top;
extern RECOMP_TLS uint16_t g_fp_control_word;
extern RECOMP_TLS uint32_t g_mxcsr;
extern RECOMP_TLS int g_fp_cmp;
extern RECOMP_TLS RecompXmm g_xmm0, g_xmm1, g_xmm2, g_xmm3;
extern RECOMP_TLS RecompXmm g_xmm4, g_xmm5, g_xmm6, g_xmm7;
extern ptrdiff_t g_xbox_mem_offset;

/* ── XBE Constants ─────────────────────────────────────────── */

/*
 * TODO: Set these from your xbe_parser output.
 * Run: py -3 -m tools.xbe_parser game/default.xbe
 */
#define YOUR_GAME_ENTRY_POINT   0x000CA76D  /* XBE entry point VA */
#define YOUR_GAME_XBE_PATH      "game\\atv2\\default.xbe"
#define YOUR_GAME_DIR            "game\\atv2"

extern MCPXAPUState *g_apu_state;
int recomp_dispatch_init(void);


#ifndef _WIN32
#include <signal.h>
#include <execinfo.h>
#include <ucontext.h>
#include <unistd.h>
/* Last-resort crash report on POSIX: the runtime's own SIGSEGV users chain
 * here when a fault is not theirs. */
static void posix_crash(int sig, siginfo_t *si, void *ucv)
{
    ucontext_t *uc = (ucontext_t *)ucv;
    void *bt[48];
    int n;
    fprintf(stderr, "\n[CRASH] signal %d addr=%p rip=%p\n", sig, si->si_addr,
            (void *)uc->uc_mcontext.gregs[REG_RIP]);
    fprintf(stderr, "  guest eax=%08X ecx=%08X edx=%08X ebx=%08X esi=%08X edi=%08X esp=%08X\n",
            g_eax, g_ecx, g_edx, g_ebx, g_esi, g_edi, g_esp);
    n = backtrace(bt, 48);
    backtrace_symbols_fd(bt, n, 2);
    _exit(139);
}
static void posix_crash_install(void)
{
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_sigaction = posix_crash;
    sa.sa_flags = SA_SIGINFO;
    sigaction(SIGSEGV, &sa, NULL);
    sigaction(SIGBUS, &sa, NULL);
    sigaction(SIGILL, &sa, NULL);
    sigaction(SIGFPE, &sa, NULL);
}
#endif

/* ── Forward declarations ──────────────────────────────────── */

static BOOL load_xbe(const char *path, void **out_data, size_t *out_size);

#ifdef _WIN32
/* XDK D3D's KickOff (0x196FB0) sets 0x100410 bit 16 and spins until the GPU
 * clears it, before every DMA_PUT. The runtime clears it from the pushbuffer
 * walk, every 256 words -- so while the walk is inside one big batch (the
 * vertex program run on the CPU, then the draw) every kickoff waits for that
 * batch, and the game thread and the "GPU" end up taking turns. Measured in
 * the 3D attract demo: two thirds of the game thread in that spin. Hardware
 * clears it at once, so answer it at once, from a thread of its own.
 *
 * A flip held for its vblank (RECOMP_FLIP_PACING) keeps the bit up: that is
 * how the title feels the flip stall, so this leaves it to the ack loop then.
 *
 * Answered at once, the game runs ahead of the executor, and D3D's fence wait
 * (0x196CF0) takes its "GPU far behind" path: it patches a software method
 * (NO_OPERATION 5) into the pushbuffer and sleeps on the event the GPU's
 * interrupt for it sets. The runtime delivers that interrupt
 * (xbox_Nv2aSoftwareMethod), and D3D can only patch ahead of the executor
 * with an exact DMA_GET, which the DMA walk publishes (RECOMP_PB_WALK=dma);
 * under the segment scan GET lags a whole segment, D3D patches commands
 * already run and the title sleeps for good. So RECOMP_FAST_KICK=1 selects
 * the DMA walk too unless RECOMP_PB_WALK is set (see main). */
extern volatile uint32_t *xbox_Nv2aRegPtr(uint32_t offset);
extern int nv2a_pb_exec_flip_held(void);

static DWORD WINAPI kick_ack_thread(LPVOID unused)
{
    volatile uint32_t *r = NULL;
    unsigned idle = 0;
    (void)unused;
    while (!(r = xbox_Nv2aRegPtr(0x100410)))
        Sleep(1);
    for (;;) {
        if ((*r & 0x10000) && !nv2a_pb_exec_flip_held()) {
            InterlockedAnd((volatile LONG *)r, ~0x10000L);
            idle = 0;
        } else if (++idle < 4096) {
            YieldProcessor();
        } else {
            idle = 0;
            SwitchToThread();
        }
    }
    return 0;
}

static DWORD WINAPI stderr_flusher(LPVOID unused)
{
    (void)unused;
    for (;;) {
        Sleep(250);
        fflush(stderr);
    }
    return 0;
}

static void kick_ack_start(void)
{
    const char *e = getenv("RECOMP_FAST_KICK");
    if (!e || *e != '1')
        return;
    CloseHandle(CreateThread(NULL, 0, kick_ack_thread, NULL, 0, NULL));
    fprintf(stderr, "[BOOT] fast kickoff ack on (RECOMP_FAST_KICK=1), pushbuffer"
            " walk %s\n", getenv("RECOMP_PB_WALK") ? getenv("RECOMP_PB_WALK")
                                                   : "segment");
}
#endif

/* Recompiled entry point (generated by recomp pipeline) */
extern void xbe_entry_point(void);

#ifdef _WIN32
/* ── VEH crash handler ─────────────────────────────────────── */

/*
 * Vectored Exception Handler for crash diagnostics.
 *
 * When the recompiled game hits an access violation, this handler prints
 * the faulting address, all Xbox register values, and a native stack trace.
 * This is your primary debugging tool during bring-up.
 *
 * Customize this for your game:
 *   - Add game-specific address checks (GPU register probes, etc.)
 *   - Add dumps of game-specific globals (heap handles, state flags)
 *   - Add SEH simulation if your game uses __try/__except
 */
/* Name the guest function a fault happened in, and recover the call chain.
 *
 * Recompiled code faults as ordinary native code, so the exception record
 * carries a host RIP and nothing else -- there is no guest program counter to
 * report, and the host address changes every build. Two things recover the
 * guest view:
 *
 *   - every generated function is a real symbol in the image (sub_005A03C0
 *     and so on), so the linker's PDB already maps host address back to guest
 *     function. dbghelp turns an anonymous RIP into that name.
 *
 *   - every lifted call pushes its guest return address onto the guest stack
 *     before jumping, so the stack still holds the chain. Scanning up from esp
 *     for values inside the code sections recovers it.
 *
 * ponytail: the stack scan is a scan, not a frame walk -- these are FPO frames
 * with no reliable ebp chain, so there is nothing to walk. It over-reports,
 * since addresses from returned-from calls linger below esp, but naming the
 * guest function is the whole question at a fault.
 *
 * Requires linking dbghelp and keeping the .pdb beside the .exe.
 */
static void print_guest_context(void *rip)
{
    /* SYMBOL_INFO is variable-length: the name is written past the struct, so
     * it must be over-allocated with MaxNameLen set to the slack. */
    char buf[sizeof(SYMBOL_INFO) + 256];
    SYMBOL_INFO *sym = (SYMBOL_INFO *)buf;
    DWORD64 disp = 0;

    memset(buf, 0, sizeof(buf));
    sym->SizeOfStruct = sizeof(SYMBOL_INFO);
    sym->MaxNameLen = 255;
    if (SymFromAddr(GetCurrentProcess(), (DWORD64)(uintptr_t)rip, &disp, sym))
        fprintf(stderr, "  in %s+0x%llX\n",
                sym->Name, (unsigned long long)disp);

    if (g_xbox_mem_offset && g_esp) {
        const uint32_t *sp =
            (const uint32_t *)((uintptr_t)g_xbox_mem_offset + g_esp);
        int shown = 0, i;
        fprintf(stderr, "  guest stack (return addresses, innermost first):\n");
        for (i = 0; i < 256 && shown < 24; i++) {
            uint32_t v = sp[i];
            if (v > g_xbox_code_lo && v < g_xbox_code_hi) {
                fprintf(stderr, "    [esp+%-4d] 0x%08X\n", i * 4, v);
                shown++;
            }
        }
        /* When the frame is gone, say so, and fall back on what is left.
         *
         * A fault inside a block copy leaves no return address in range: the
         * copy is a host memmove and its caller's frame is further up than
         * this reaches. Worse, a copy that ran past its buffer overwrites the
         * stack itself, so the list comes out empty exactly when it is most
         * needed -- and an empty list under a promising heading reads like
         * "nothing to see" rather than "the evidence is destroyed". */
        if (!shown)
            fprintf(stderr, "    (no return addresses in range)\n");

        /* Everything below only pays for itself when the scan came back
         * empty. A crash where the chain was recovered already says what
         * happened, and burying that under another twenty lines makes the
         * common report worse to read. */
        if (!shown) {
            uint32_t k;

            /* The indirect-call history, which the stack cannot overwrite.
             * recomp_manual.c prints this too, but only from
             * recomp_icall_fail_log -- a page fault inside a block copy
             * never reaches that path, and this is the same information by
             * the route the fault actually took.
             *
             * Declared here rather than included: main.c does not pull in
             * recomp_types.h, and recomp_manual.c spells it the same way. */
            extern volatile uint32_t g_icall_trace[16];
            extern volatile uint32_t g_icall_trace_idx;

            fprintf(stderr, "  recent ICALL targets:");
            for (k = 0; k < 16; k++)
                fprintf(stderr, " %08X",
                        g_icall_trace[(g_icall_trace_idx + k) & 15]);
            fprintf(stderr, "\n");

            /* The frame unfiltered. The pointers and lengths handed to
             * whatever faulted live here and look nothing like code, so the
             * filter above drops exactly what is wanted. On the crash this
             * was written for, one of these words was the end of the mapped
             * RAM mirror -- which is what identified the fault as a copy
             * running off its buffer rather than a stray pointer. */
            for (i = 0; i < 20; i++)
                fprintf(stderr, "    raw[esp+%-4d] 0x%08X\n", i * 4, sp[i]);
        }
    }
}

/* The emulated APU.
 *
 * Two entry points that had no callers anywhere in the tree. apu_mmio_hook.c
 * documents apu_hook_handle_mmio as "called from VEH in main.c" and no main.c
 * called it; apu_decode_and_handle's first line is `if (!g_apu_state) return
 * false` and nothing assigned g_apu_state. So with RECOMP_AC97_READY set the
 * APU's registers were unmapped to be trapped, and every trap was then
 * declined and surfaced as an access violation on the first register
 * DirectSound touched. The VEH below now reaches apu_hook_handle_mmio
 * through the toolkit's xbox_VehMmioFault.
 *
 * Declared rather than included so this does not depend on src/apu being on
 * the include path. */
typedef struct MCPXAPUState MCPXAPUState;
extern MCPXAPUState *mcpx_apu_init_standalone(uint8_t *ram_ptr);
extern MCPXAPUState *g_apu_state;

static LONG CALLBACK veh_handler(PEXCEPTION_POINTERS ep)
{
    if (ep->ExceptionRecord->ExceptionCode == EXCEPTION_ACCESS_VIOLATION) {
        uintptr_t fault_addr = ep->ExceptionRecord->ExceptionInformation[1];

        /*
         * GPU register probe at 0xFD000000 range.
         * Some games probe NV2A registers directly. On real hardware this
         * returns GPU state; here we just skip the instruction.
         * TODO: Implement mini x86-64 decoder for instruction skipping,
         * or connect to the xbox_nv2a library for proper handling.
         */
        /* The guest is mapped at offset 0 here, so this host range is the
         * NV2A's own: let the runtime's traps (the PGRAPH page while a
         * software-method interrupt waits for its acknowledgement) see it
         * first. */
        if (fault_addr >= 0xFD000000 && fault_addr < 0xFE000000) {
            if (xbox_VehMmioFault(ep))
                return EXCEPTION_CONTINUE_EXECUTION;
            return EXCEPTION_CONTINUE_SEARCH;
        }

        /* Trapped hardware registers (APU, USB OHCI) -> their models.
         *
         * The other half of RECOMP_AC97_READY: reporting the codec ready is
         * what lets DirectSoundCreate past its first gate, and from there it
         * drives the APU directly, so the registers have to fault to be seen.
         * "Handled" means the access was decoded and the instruction stepped
         * over, so execution resumes instead of unwinding. */
        if (xbox_VehMmioFault(ep))
            return EXCEPTION_CONTINUE_EXECUTION;

        fprintf(stderr, "[CRASH] Access violation at RIP=0x%llX, fault addr=0x%llX (%s)\n",
            (unsigned long long)ep->ContextRecord->Rip,
            (unsigned long long)fault_addr,
            ep->ExceptionRecord->ExceptionInformation[0] ? "write" : "read");
        fprintf(stderr, "  Xbox regs: eax=0x%08X ecx=0x%08X edx=0x%08X esp=0x%08X\n",
            g_eax, g_ecx, g_edx, g_esp);
        fprintf(stderr, "  Xbox regs: ebx=0x%08X esi=0x%08X edi=0x%08X\n",
            g_ebx, g_esi, g_edi);
        fprintf(stderr, "  Xbox VA of fault: 0x%08X\n",
            (uint32_t)(fault_addr - (uintptr_t)g_xbox_mem_offset));
        print_guest_context((void *)ep->ContextRecord->Rip);

        /*
         * TODO: Add game-specific diagnostics here. Examples:
         *
         * Dump CRT heap handle:
         *   uint32_t heap = *(uint32_t *)((uint8_t *)g_xbox_mem_offset + HEAP_HANDLE_VA);
         *   fprintf(stderr, "  CRT heap handle: 0x%08X\n", heap);
         *
         * Dump game state:
         *   uint32_t state = *(uint32_t *)((uint8_t *)g_xbox_mem_offset + GAME_STATE_VA);
         *   fprintf(stderr, "  Game state: %u\n", state);
         */

        /* Print native stack return addresses for debugging */
        {
            uintptr_t *sp = (uintptr_t *)ep->ContextRecord->Rsp;
            fprintf(stderr, "  Native stack (first 8 return addrs):\n");
            for (int i = 0; i < 64 && sp[i]; i++) {
                if (sp[i] >= 0x140000000ULL && sp[i] < 0x150000000ULL) {
                    fprintf(stderr, "    [%d] 0x%llX\n", i, (unsigned long long)sp[i]);
                }
            }
        }
        fflush(stderr);
    }
    if (ep->ExceptionRecord->ExceptionCode == EXCEPTION_INT_DIVIDE_BY_ZERO
        || ep->ExceptionRecord->ExceptionCode == EXCEPTION_INT_OVERFLOW) {
        /* A guest `div` by zero (or overflow) faults the same way on the
         * host; without this the process just ends with 0xC0000094. */
        fprintf(stderr, "[CRASH] integer %s at RIP=0x%llX\n",
                ep->ExceptionRecord->ExceptionCode == EXCEPTION_INT_DIVIDE_BY_ZERO
                    ? "divide by zero" : "overflow",
                (unsigned long long)ep->ContextRecord->Rip);
        fprintf(stderr, "  Xbox regs: eax=0x%08X ecx=0x%08X edx=0x%08X esp=0x%08X\n",
            g_eax, g_ecx, g_edx, g_esp);
        print_guest_context((void *)ep->ContextRecord->Rip);
        fflush(stderr);
    }

    return EXCEPTION_CONTINUE_SEARCH;
}

#endif /* _WIN32 VEH */
/* ── WinMain ───────────────────────────────────────────────── */

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance,
                   LPSTR lpCmdLine, int nCmdShow)
{
    void *xbe_data = NULL;
    size_t xbe_size = 0;

    (void)hInstance;
    (void)hPrevInstance;
    (void)lpCmdLine;
    (void)nCmdShow;

    /* stdout unbuffered; stderr -- where the runtime logs -- buffered.
     *
     * MSVC's unbuffered stream issues one WriteFile per character, and a
     * WriteFile to the redirected log cost ~300 us here: ~10 ms per log line,
     * on whichever thread logged, the pushbuffer thread included. Buffered it
     * is ~1.4 us a line. A flusher keeps the file within 250 ms of live, and
     * the crash, watchdog and exit paths fflush(stderr) themselves. */
    /* RECOMP_LOG=<path>: the log is a file this process opens itself rather
     * than a handle the launcher redirected. PowerShell's Start-Process
     * redirect left a write to it blocked for good in one run, with the
     * stderr lock held and every logging thread queued behind it. */
    {
        const char *log = getenv("RECOMP_LOG");
        if (log && *log && !freopen(log, "w", stderr))
            fprintf(stdout, "cannot open RECOMP_LOG %s\n", log);
    }
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IOFBF, 1 << 16);
#ifdef _WIN32
    CloseHandle(CreateThread(NULL, 0, stderr_flusher, NULL, 0, NULL));
#endif

    /* The one-CPU DISPATCH gate on by default (RECOMP_DISPATCH_GATE=0 turns it
     * off). XAPI's USB driver edits its pending-endpoint lists at DISPATCH and
     * then enables StartOfFrame; its DPC drains those lists and disables SOF.
     * Without the gate the DPC ran on the timer thread beside the raised
     * thread, disabled SOF after the enable, and the new endpoint was never
     * serviced: the pad's interrupt pipe never opened (5 boots in 12 with no
     * input), and the same overlap is how a cancel walked off a TD list
     * (the sub_001ABCF2 crash). With the gate: 39 of 39 boots. */
    if (!getenv("RECOMP_DISPATCH_GATE")) {
#ifdef _WIN32
        _putenv_s("RECOMP_DISPATCH_GATE", "1");
#else
        setenv("RECOMP_DISPATCH_GATE", "1", 0);
#endif
    }
    /* Fast kickoff needs the DMA walk's exact DMA_GET (kick_ack_thread). */
    {
        const char *fk = getenv("RECOMP_FAST_KICK");
        if (fk && *fk == '1' && !getenv("RECOMP_PB_WALK")) {
#ifdef _WIN32
            _putenv_s("RECOMP_PB_WALK", "dma");
#else
            setenv("RECOMP_PB_WALK", "dma", 0);
#endif
        }
    }

    printf("=== YOUR_GAME_NAME - Static Recompilation ===\n");
    printf("Loading XBE...\n");

    /* Install VEH handler (first handler in chain) */
    /* Load symbols up front rather than from inside the handler: at fault
     * time the process is already in a bad way, and SymInitialize
     * allocates. Failure is not fatal -- the handler prints no name. */
#ifndef _WIN32
    posix_crash_install();
#endif
#ifdef _WIN32
    SymSetOptions(SYMOPT_DEFERRED_LOADS | SYMOPT_UNDNAME);
    SymInitialize(GetCurrentProcess(), NULL, TRUE);
    AddVectoredExceptionHandler(1, veh_handler);
#endif

    /* Step 1: Load XBE */
    if (!load_xbe(YOUR_GAME_XBE_PATH, &xbe_data, &xbe_size)) {
        MessageBoxA(NULL, "Failed to load default.xbe.\n"
                    "Place the game files in the 'game' subdirectory.",
                    "Recomp", MB_ICONERROR);
        return 1;
    }
    printf("XBE loaded: %zu bytes\n", xbe_size);

    /* Step 2: Initialize Xbox memory layout */
    printf("Initializing Xbox memory layout...\n");
    if (!xbox_MemoryLayoutInit(xbe_data, xbe_size)) {
        MessageBoxA(NULL, "Failed to initialize Xbox memory layout.\n"
                    "The required virtual address range may be unavailable.",
                    "Recomp", MB_ICONERROR);
        free(xbe_data);
        return 1;
    }

    g_xbox_mem_offset = xbox_GetMemoryOffset();
    printf("Xbox memory mapped. Offset: 0x%llX\n", (unsigned long long)g_xbox_mem_offset);

    /* Bring up the emulated APU.
     *
     * Gated on the same variable that unmaps its registers, because the two
     * halves are useless apart: a trap with no model declines every access,
     * and a model nothing traps into never sees a register. The APU walks
     * Xbox physical RAM to find voice buffers, so it gets the guest RAM
     * base. */
    if (getenv("RECOMP_AC97_READY")) {
        g_apu_state = mcpx_apu_init_standalone((uint8_t *)xbox_GetMemoryBase());
        fprintf(stderr, "[BOOT] emulated APU %s\n",
                g_apu_state ? "up" : "FAILED to initialise");
    }

    /* The MCPX USB host controllers, so the statically linked XAPI finds a
     * pad (the keyboard under RECOMP_KEYBOARD, or an XInput pad). Nothing in
     * the runtime or the template calls this, and without it RECOMP_USB is
     * read by no one: the title enumerates an empty bus and ignores input.
     * Needs the guest memory mapped, so it goes after the layout. */
    {
        extern void xbox_OhciInit(void);
        xbox_OhciInit();
    }

    /* Step 3: Initialize Xbox kernel */
    printf("Initializing Xbox kernel replacement...\n");
    xbox_kernel_init();

    /* Step 4: Set game directory for file I/O path translation */
    {
        extern void xbox_path_init(const char *game_dir, const char *save_dir);
        /* RECOMP_SAVE_DIR also takes the partition images and the
         * Cache/SystemData/TitleData/UserData folders, so a test run with its
         * own save dir leaves %LOCALAPPDATA%\xboxrecomp alone entirely. */
        const char *sd = getenv("RECOMP_SAVE_DIR");
        xbox_path_init(YOUR_GAME_DIR, sd && sd[0] ? sd : NULL);
    }

    /* Step 5: Initialize kernel bridge (thunk table in Xbox memory) */
    printf("Initializing kernel bridge...\n");
    xbox_kernel_bridge_init();

    /* Step 6: Initialize stack */
    g_esp = XBOX_STACK_TOP;

    /*
     * TODO: Pre-initialize CRT globals if needed.
     *
     * Many Xbox games use the MSVC CRT. The CRT's __heap_init sets up a
     * heap descriptor at a game-specific address. You may need to
     * pre-initialize __active_heap to avoid small-block heap issues:
     *
     *   uint32_t *active_heap = (uint32_t *)((uint8_t *)g_xbox_mem_offset + ACTIVE_HEAP_VA);
     *   *active_heap = 1;  // 1 = system heap (HeapAlloc), avoids SBH init
     *
     * Find ACTIVE_HEAP_VA by searching the disassembly for __heap_init
     * or by looking for the CRT's __active_heap global in the data section.
     */

    printf("\n=== Initialization complete ===\n");
    printf("Entry point: 0x%08X\n", YOUR_GAME_ENTRY_POINT);
    printf("ESP: 0x%08X\n", g_esp);

    /* Build the flat dispatch table before the guest runs.
     *
     * Without this recomp_lookup falls back to a binary search over the
     * whole function table -- roughly log2(n) branches on *every*
     * indirect call, which for a 45,000-function C++ title is about 16
     * every time the game goes through a vtable. Half-Life 2 spent most
     * of its static initialisation inside recomp_lookup for exactly this
     * reason, and it read as a hang.
     *
     * Optional by design: if the allocation fails the search still works,
     * so a failure is worth one line and not a fatal error. */
    if (!recomp_dispatch_init())
        fprintf(stderr, "[BOOT] flat dispatch unavailable; "
                        "indirect calls will use the binary search\n");

    /* Arm the hang watchdog. Does nothing unless RECOMP_WATCHDOG_SECS is set,
     * and must be called from this thread -- the guest registers it samples are
     * thread-local, so it has to be handed the copies belonging to the thread
     * that runs guest code.
     *
     * Not optional boilerplate: without this call RECOMP_WATCHDOG_SECS is
     * silently inert, and the one diagnostic that tells a hang from slowness
     * does nothing while appearing to be set. */
    xbox_WatchdogStart();

    /* ATV 2 retail: XDK D3D device pointer at 0x1A50E8; write sequence +0x2C,
     * pointer to the GPU's progress +0x30 (fence wait 0x196CF0). With the fast
     * kick (the DMA walk) the mirror only names that word: the walk's
     * SEMAPHORE_RELEASE writes it, since a mirror let D3D overwrite pushbuffer
     * the walk had not read (xboxrecomp nv2a_pb_walk_owns_fence). */
    xbox_Nv2aMirrorFence(0x001A50E8, 0x2C, 0x30);

    /* Draw the pushbuffer on the GPU instead of the CPU rasteriser
     * (RECOMP_GPU=1; src/gpu_d3d11.c). */
    {
        extern void atv2_gpu_backend_install(void);
        atv2_gpu_backend_install();
    }
#ifdef _WIN32
    kick_ack_start();
#endif
    /* RECOMP_CONTROL=<port>: loopback test channel (src/control). */
    {
        extern void atv2_control_init(void);
        atv2_control_init();
    }
    /* RECOMP_FREERIDE=1: straight into Freestyle, Unlimited Time (src/freeride.c). */
    {
        extern void atv2_freeride_init(void);
        atv2_freeride_init();
    }

    /* Step 7: Call the recompiled entry point */
    printf("\nStarting game...\n");
    fflush(stdout);

    xbe_entry_point();

    printf("\nGame returned. Cleaning up...\n");

    /* Cleanup */
    xbox_kernel_shutdown();
    xbox_MemoryLayoutShutdown();
    free(xbe_data);

    return 0;
}

/* ── XBE Loading ───────────────────────────────────────────── */

static BOOL load_xbe(const char *path, void **out_data, size_t *out_size)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "Cannot open XBE: %s\n", path);
        return FALSE;
    }

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (size <= 0) {
        fclose(f);
        return FALSE;
    }

    void *data = malloc((size_t)size);
    if (!data) {
        fclose(f);
        return FALSE;
    }

    if (fread(data, 1, (size_t)size, f) != (size_t)size) {
        free(data);
        fclose(f);
        return FALSE;
    }

    fclose(f);
    *out_data = data;
    *out_size = (size_t)size;
    return TRUE;
}

/* Console entry point (for debugging -- lets you see printf output) */
int main(int argc, char **argv)
{
    (void)argc;
    (void)argv;
#ifdef _WIN32
    return WinMain(GetModuleHandle(NULL), NULL, GetCommandLineA(), SW_SHOW);
#else
    return WinMain(NULL, NULL, "", 1);
#endif
}
