/*
 * threads_test.c - the runtime's thread and sync layer on wasm, under load.
 *
 * Built by web/tests/threads/build.sh for wasm32-wasip1-threads against the
 * runtime's own win32_compat.c, host_time.c, kernel_guest_cpu.c and
 * kernel_hal.c (the guest CPU lock and the one-CPU DISPATCH gate), and run by
 * run.mjs in Node (worker_threads) or headless Edge (run-edge.mjs) through
 * web/host/threads.js. No guest code: "guest-like" work in C.
 *
 *  - GUESTS guest threads join the guest CPU (RECOMP_GUEST_LOCK=1) and do
 *    unlocked read-modify-writes on one counter, the way a title's threads
 *    trust the console's one CPU. Between them: kernel-call releases, IRQL
 *    raises to DISPATCH (the gate) around a second counter, sleeps
 *    (KeDelayExecutionThread), and waits on auto-reset events in a
 *    ping-pong ring. Totals must be exact: a lost update means two guests
 *    ran at once.
 *  - a timer thread (host, not guest) paced on xbox_HostTimerSleepNs runs
 *    "DPCs" through the gate (TryEnter, as the kernel timer thread does) and
 *    signals an event a guest waits on each round.
 *  - a semaphore producer/consumer pair and a timer-queue timer.
 *  - waves of short-lived threads, more than the Worker pool holds, so
 *    slots are reused and the pool grows; some end with ExitThread
 *    (pthread_exit on wasm).
 *  - a watchdog fails the run instead of hanging it.
 */
#include "kernel.h"
#include "xbox_memory_layout.h"
#include "platform/host_time.h"
#include "platform/wasm_threads.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define GUESTS      6
#define ITERS       4000
#define WAVES       4
#define WAVE_SIZE   24

static volatile int32_t s_rmw;          /* guest-CPU protected, unlocked RMW */
static volatile int32_t s_gate_ctr;     /* DISPATCH-gate protected */
static volatile LONG s_dpcs, s_dpc_queued, s_timer_cb, s_sem_got;
static volatile LONG s_wave_done, s_exit_thread_done;
static HANDLE s_ring[GUESTS];           /* ping-pong ring of auto-reset events */
static HANDLE s_tick_ev;                /* set by the timer thread each round */
static HANDLE s_sem;
static volatile LONG s_stop;
static int failures;
/* The game's g_fs_base is a TLS variable with an initialiser (XBOX_TIB_MAIN).
 * The main thread's TLS block is set up by the start function only in the
 * first instance (threads.js instantiates the main Worker first). */
static __thread uint32_t t_tls_init = 0x4000;
static volatile uint32_t s_thread_tls_seen;
static DWORD WINAPI tls_peek(LPVOID p) { (void)p; s_thread_tls_seen = t_tls_init; return 0; }

static void check(int ok, const char *what)
{
    printf("  %-64s %s\n", what, ok ? "PASS" : "FAIL");
    if (!ok) failures++;
}

/* The kernel thunk's shape: let the CPU go for the call, take it back. */
static void kcall(uint32_t ordinal)
{
    if (xbox_GuestCpuRelease(XBOX_GUEST_CPU_KERNEL, ordinal))
        xbox_GuestCpuAcquire();
}

/* KfRaiseIrql(DISPATCH) ... KfLowerIrql, as the kernel thunks run them: the
 * guest CPU is let go for each call, and the raise takes the gate. */
static void gate_work(void)
{
    KIRQL old;
    int32_t v;

    xbox_GuestCpuRelease(XBOX_GUEST_CPU_KERNEL, 160);   /* KfRaiseIrql */
    old = xbox_KfRaiseIrql(2);
    xbox_GuestCpuAcquire();
    v = s_gate_ctr;
    for (volatile int k = 0; k < 20; k++) { }
    s_gate_ctr = v + 1;
    xbox_GuestCpuRelease(XBOX_GUEST_CPU_KERNEL, 161);   /* KfLowerIrql */
    xbox_KfLowerIrql(old);
    xbox_GuestCpuAcquire();
}

static DWORD WINAPI guest_main(LPVOID p)
{
    int me = (int)(intptr_t)p, i;

    xbox_GuestCpuJoin();
    for (i = 0; i < ITERS; i++) {
        /* A title's "slot = count; fill; count = slot + 1". */
        int32_t v = s_rmw;
        for (volatile int k = 0; k < 50; k++) { }
        s_rmw = v + 1;

        if ((i & 7) == 0)
            kcall(161);                        /* a call that returns at once */
        if ((i & 15) == 3)
            gate_work();
        if ((i & 255) == 17) {                 /* KeDelayExecutionThread(1 ms) */
            xbox_GuestCpuRelease(XBOX_GUEST_CPU_KERNEL, 99);
            Sleep(1);
            xbox_GuestCpuAcquire();
        }
        if ((i & 511) == 100) {                /* ping-pong: wake the next, wait for ours */
            SetEvent(s_ring[(me + 1) % GUESTS]);
            xbox_GuestCpuRelease(XBOX_GUEST_CPU_KERNEL, 159);  /* KeWaitForSingleObject */
            WaitForSingleObject(s_ring[me], 50);
            xbox_GuestCpuAcquire();
        }
        if (me == 0 && (i & 127) == 64) {      /* wait for the timer thread's tick */
            xbox_GuestCpuRelease(XBOX_GUEST_CPU_KERNEL, 159);
            WaitForSingleObject(s_tick_ev, 100);
            xbox_GuestCpuAcquire();
        }
    }
    xbox_GuestCpuPart();
    return 0;
}

/* The kernel timer thread's shape: paced sleeps, DPCs only when the gate is
 * free (else "queued"), an event set per round. */
static DWORD WINAPI timer_main(LPVOID p)
{
    (void)p;
    xbox_HostTimerThreadInit();
    while (!InterlockedCompareExchange(&s_stop, 0, 0)) {
        xbox_HostTimerSleepNs(1000000);
        if (xbox_DispatchGateTryEnter()) {
            int32_t v = s_gate_ctr;
            s_gate_ctr = v + 1;
            InterlockedIncrement(&s_dpcs);
            xbox_DispatchGateLeave();
        } else {
            InterlockedIncrement(&s_dpc_queued);
        }
        SetEvent(s_tick_ev);
    }
    return 0;
}

static DWORD WINAPI producer(LPVOID p)
{
    int i;
    (void)p;
    for (i = 0; i < 500; i++) {
        ReleaseSemaphore(s_sem, 1, NULL);
        if ((i & 31) == 0) Sleep(1);
    }
    return 0;
}

static DWORD WINAPI consumer(LPVOID p)
{
    int i;
    (void)p;
    for (i = 0; i < 500; i++)
        if (WaitForSingleObject(s_sem, 5000) == WAIT_OBJECT_0)
            InterlockedIncrement(&s_sem_got);
    return 0;
}

static VOID CALLBACK timer_cb(PVOID p, BOOLEAN fired)
{
    (void)p; (void)fired;
    InterlockedIncrement(&s_timer_cb);
}

static DWORD WINAPI short_lived(LPVOID p)
{
    int n = (int)(intptr_t)p;
    xbox_GuestCpuJoin();
    {
        int32_t v = s_rmw;
        s_rmw = v + 1;
    }
    kcall(161);
    xbox_GuestCpuPart();
    InterlockedIncrement(&s_wave_done);
    if (n & 1) {                     /* PsTerminateSystemThread's way out */
        InterlockedIncrement(&s_exit_thread_done);
        ExitThread(7);
    }
    return 3;
}

/* Latencies: thread start, an event wake round trip, a contended critical
 * section hand-off. */
static volatile uint64_t s_started_ns;
static DWORD WINAPI note_start(LPVOID p)
{
    (void)p;
    s_started_ns = xbox_HostNowNs();
    return 0;
}

static HANDLE s_ping, s_pong;
static DWORD WINAPI ponger(LPVOID p)
{
    int i, n = (int)(intptr_t)p;
    for (i = 0; i < n; i++) {
        WaitForSingleObject(s_ping, INFINITE);
        SetEvent(s_pong);
    }
    return 0;
}

static CRITICAL_SECTION s_cs;
static volatile LONG s_cs_turns[2];
static DWORD WINAPI cs_hammer(LPVOID p)
{
    int me = (int)(intptr_t)p, i;
    for (i = 0; i < 20000; i++) {
        EnterCriticalSection(&s_cs);
        s_cs_turns[me]++;
        LeaveCriticalSection(&s_cs);
    }
    return 0;
}

/* The kick-ack shape: a service thread poll-waits on a register word and
 * clears a busy bit the "guest" sets and spins on. */
static volatile uint32_t s_kick_reg;
static volatile LONG s_kick_stop;
static DWORD WINAPI kick_service(LPVOID p)
{
    (void)p;
    while (!InterlockedCompareExchange(&s_kick_stop, 0, 0)) {
        uint32_t v = __atomic_load_n(&s_kick_reg, __ATOMIC_SEQ_CST);
        if (v & 0x10000u) {
            __atomic_fetch_and(&s_kick_reg, ~0x10000u, __ATOMIC_SEQ_CST);
            continue;
        }
        xbox_WasmPollWait(&s_kick_reg, v, 250000);
    }
    return 0;
}

static void kick_round(int hook, int n, double *avg, double *mx)
{
    uint64_t t0, d, sum = 0, m = 0;
    int i;
    for (i = 0; i < n; i++) {
        Sleep(2);                           /* let the service thread go to sleep */
        t0 = xbox_HostNowNs();
        __atomic_fetch_or(&s_kick_reg, 0x10000u, __ATOMIC_SEQ_CST);
        if (hook)
            xbox_WasmPollWake(&s_kick_reg);  /* the MMIO store path's wake hook */
        while (__atomic_load_n(&s_kick_reg, __ATOMIC_SEQ_CST) & 0x10000u)
            ;
        d = xbox_HostNowNs() - t0; sum += d; if (d > m) m = d;
    }
    *avg = sum / (double)n / 1e6;
    *mx = m / 1e6;
}

static void latencies(void)
{
    uint64_t t0, sum = 0, mx = 0, d;
    HANDLE t, h[2];
    int i, n = 200;

    for (i = 0; i < 20; i++) {
        s_started_ns = 0;
        t0 = xbox_HostNowNs();
        t = CreateThread(NULL, 0, note_start, NULL, 0, NULL);
        WaitForSingleObject(t, INFINITE);
        CloseHandle(t);
        d = s_started_ns - t0; sum += d; if (d > mx) mx = d;
    }
    printf("  latency: CreateThread to first instruction avg %.3f ms, max %.3f ms\n",
           sum / 20 / 1e6, mx / 1e6);

    s_ping = CreateEventA(NULL, FALSE, FALSE, NULL);
    s_pong = CreateEventA(NULL, FALSE, FALSE, NULL);
    t = CreateThread(NULL, 0, ponger, (LPVOID)(intptr_t)n, 0, NULL);
    sum = 0; mx = 0;
    for (i = 0; i < n; i++) {
        t0 = xbox_HostNowNs();
        SetEvent(s_ping);
        WaitForSingleObject(s_pong, INFINITE);
        d = xbox_HostNowNs() - t0; sum += d; if (d > mx) mx = d;
    }
    WaitForSingleObject(t, INFINITE);
    printf("  latency: event ping-pong round trip (2 wakes) avg %.3f ms, max %.3f ms\n",
           sum / n / 1e6, mx / 1e6);

    {
        double a0, m0, a1, m1;
        HANDLE k = CreateThread(NULL, 0, kick_service, NULL, 0, NULL);
        kick_round(1, 50, &a1, &m1);
        kick_round(0, 50, &a0, &m0);
        InterlockedExchange(&s_kick_stop, 1);
        xbox_WasmPollWake(&s_kick_reg);
        WaitForSingleObject(k, INFINITE);
        printf("  latency: poll-wait ack with wake hook avg %.3f ms, max %.3f ms;"
               " without (page tick) avg %.3f ms, max %.3f ms\n", a1, m1, a0, m0);
        check(m1 < 5.0, "poll-wait: a woken service thread answers within 5 ms");
    }

    InitializeCriticalSection(&s_cs);
    t0 = xbox_HostNowNs();
    h[0] = CreateThread(NULL, 0, cs_hammer, (LPVOID)0, 0, NULL);
    h[1] = CreateThread(NULL, 0, cs_hammer, (LPVOID)1, 0, NULL);
    WaitForMultipleObjects(2, h, TRUE, INFINITE);
    printf("  latency: 2 threads x 20000 contended CRITICAL_SECTION enters in %.1f ms\n",
           (xbox_HostNowNs() - t0) / 1e6);
    check(s_cs_turns[0] == 20000 && s_cs_turns[1] == 20000, "critical section: both threads got every turn");
}

static DWORD WINAPI watchdog(LPVOID p)
{
    DWORD secs = (DWORD)(uintptr_t)p;
    Sleep(secs * 1000);
    if (!InterlockedCompareExchange(&s_stop, 0, 0)) {
        printf("  WATCHDOG: no finish after %lu s (rmw %d, gate %d, owner %lu,"
               " waiting %d) -- deadlock\n", (unsigned long)secs, (int)s_rmw,
               (int)s_gate_ctr, xbox_GuestCpuOwner(), xbox_GuestCpuWaiting());
        fflush(stdout);
        exit(2);
    }
    return 0;
}

int main(void)
{
    HANDLE g[GUESTS], t, prod, cons, wd, waves[WAVE_SIZE];
    HANDLE tq_timer = NULL;
    XboxGuestCpuStats st;
    uint64_t t0, t1;
    int i, w;
    DWORD code;

    setenv("RECOMP_GUEST_LOCK", "1", 1);
    setenv("RECOMP_DISPATCH_GATE", "1", 1);
    printf("threads_test: %d guest threads x %d iterations, gate + guest CPU lock\n",
           GUESTS, ITERS);
    check(xbox_GuestCpuOn(), "guest CPU lock on (RECOMP_GUEST_LOCK=1)");
    check(xbox_DispatchGateOn(), "DISPATCH gate on (RECOMP_DISPATCH_GATE=1)");
    check(t_tls_init == 0x4000 && __builtin_wasm_tls_base() != 0,
          "main thread: TLS initialised, block not at address 0");
    {
        HANDLE h = CreateThread(NULL, 0, tls_peek, NULL, 0, NULL);
        WaitForSingleObject(h, INFINITE);
        CloseHandle(h);
        check(s_thread_tls_seen == 0x4000, "spawned thread: TLS initialised");
    }

    wd = CreateThread(NULL, 0, watchdog, (LPVOID)(uintptr_t)60, 0, NULL);
    for (i = 0; i < GUESTS; i++)
        s_ring[i] = CreateEventA(NULL, FALSE, FALSE, NULL);
    s_tick_ev = CreateEventA(NULL, FALSE, FALSE, NULL);
    s_sem = CreateSemaphoreA(NULL, 0, 1000, NULL);
    check(CreateTimerQueueTimer(&tq_timer, NULL, timer_cb, NULL, 1, 2, 0),
          "timer-queue timer created (its own pthread)");

    t0 = xbox_HostNowNs();
    t = CreateThread(NULL, 0, timer_main, NULL, 0, NULL);
    prod = CreateThread(NULL, 0, producer, NULL, 0, NULL);
    cons = CreateThread(NULL, 0, consumer, NULL, 0, NULL);
    for (i = 0; i < GUESTS; i++)
        g[i] = CreateThread(NULL, 0, guest_main, (LPVOID)(intptr_t)i, 0, NULL);
    for (i = 0; i < GUESTS; i++)
        check(g[i] != NULL, "guest thread created");

    check(WaitForMultipleObjects(GUESTS, g, TRUE, 50000) == WAIT_OBJECT_0,
          "all guest threads finished");
    t1 = xbox_HostNowNs();
    check(WaitForSingleObject(prod, 10000) == WAIT_OBJECT_0
          && WaitForSingleObject(cons, 10000) == WAIT_OBJECT_0,
          "semaphore producer/consumer finished");

    /* Waves of short-lived threads: more than the pool, reused slots. */
    for (w = 0; w < WAVES; w++) {
        for (i = 0; i < WAVE_SIZE; i++)
            waves[i] = CreateThread(NULL, 0, short_lived, (LPVOID)(intptr_t)i, 0, NULL);
        check(WaitForMultipleObjects(WAVE_SIZE, waves, TRUE, 20000) == WAIT_OBJECT_0,
              "a wave of short-lived threads finished");
        code = 0;
        GetExitCodeThread(waves[1], &code);
        if (w == 0) check(code == 7, "ExitThread(7) reached the thread object (pthread_exit)");
        GetExitCodeThread(waves[2], &code);
        if (w == 0) check(code == 3, "a returning thread's exit code is 3");
        for (i = 0; i < WAVE_SIZE; i++)
            CloseHandle(waves[i]);
    }

    InterlockedExchange(&s_stop, 1);
    WaitForSingleObject(t, 5000);
    DeleteTimerQueueTimer(NULL, tq_timer, NULL);

    printf("  guest phase %.1f ms; rmw %d (want %d), gate %d, dpcs %ld run /"
           " %ld found the gate busy, timer-queue callbacks %ld, semaphore %ld\n",
           (t1 - t0) / 1e6, (int)s_rmw, GUESTS * ITERS + WAVES * WAVE_SIZE,
           (int)s_gate_ctr, (long)s_dpcs, (long)s_dpc_queued,
           (long)s_timer_cb, (long)s_sem_got);
    check(s_rmw == GUESTS * ITERS + WAVES * WAVE_SIZE,
          "guest CPU: no read-modify-write lost (one guest at a time)");
    check(s_gate_ctr == GUESTS * (ITERS / 16) + s_dpcs,
          "DISPATCH gate: no update lost between raises and DPCs");
    check(s_dpcs > 10, "timer thread ran DPCs through the gate");
    check(s_timer_cb > 10, "timer-queue timer fired");
    check(s_sem_got == 500, "semaphore: every release consumed");
    check(s_wave_done == WAVES * WAVE_SIZE, "every short-lived thread ran");
    check(s_exit_thread_done == WAVES * WAVE_SIZE / 2, "half of them left by ExitThread");
    xbox_GuestCpuStatsGet(&st, 0);
    printf("  guest cpu: turns %ld, releases %ld, switches %ld, waits %ld,"
           " longest turn %.2f ms, longest wait %.2f ms\n",
           st.turns, st.releases, st.switches, st.waits,
           st.max_turn_us / 1000.0, st.max_wait_us / 1000.0);
    check(xbox_GuestCpuWaiting() == 0 && xbox_GuestCpuOwner() == 0,
          "guest CPU free at the end, nobody queued");
    latencies();
    (void)wd;
    printf("threads_test: %s (%d failure%s)\n", failures ? "FAIL" : "PASS",
           failures, failures == 1 ? "" : "s");
    fflush(stdout);
    return failures ? 1 : 0;
}
