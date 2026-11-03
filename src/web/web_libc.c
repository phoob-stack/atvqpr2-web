/*
 * libc functions wasi-libc (wasm32-wasip1-threads, wasi-sdk 34) leaves out
 * and the POSIX side of the runtime calls: getpid, sysinfo, pthread_exit,
 * tzset.
 */
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <sys/sysinfo.h>

/* One process; any constant will do (win32_compat names shm objects and
 * reports GetCurrentProcessId with it). */
pid_t getpid(void) { return 1; }

/* GlobalMemoryStatusEx (win32_compat.c). The Xbox title asks for its own RAM
 * through the kernel, so this only has to be plausible: 4 GiB of wasm
 * address space, the unused part of it free. */
int sysinfo(struct sysinfo *si)
{
    unsigned long used = (unsigned long)__builtin_wasm_memory_size(0) * 65536ul;
    memset(si, 0, sizeof *si);
    si->totalram = 0xFFFF0000ul;           /* 4 GiB, as unsigned long fits */
    si->freeram = used < si->totalram ? si->totalram - used : 0;
    si->mem_unit = 1;
    si->procs = 1;
    return 0;
}

/* No time zones in the browser build: the kernel reports UTC (kernel_xbox.c
 * calls this before localtime). */
void tzset(void) {}

/* ExitThread (win32_compat.c). wasi-libc's threads have no pthread_exit, and
 * a wasm thread can only end by returning from its start function or by
 * unwinding out of it. The worker that runs the thread (web/host, wasm-
 * threads' workers.js) provides env.web_thread_exit: it throws a sentinel the
 * worker's wasi_thread_start wrapper catches, which ends the thread the way
 * returning would. On the main thread it ends the process (proc_exit). */
__attribute__((import_module("env"), import_name("web_thread_exit"), noreturn))
void web_thread_exit(void *retval);

_Noreturn void pthread_exit(void *retval)
{
    web_thread_exit(retval);
}
