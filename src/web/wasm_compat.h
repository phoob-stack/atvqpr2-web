/*
 * Force-included into every file of the wasm build (web/wasm/build.sh).
 *
 * wasi-libc hides a few prototypes the POSIX side of the runtime calls; a
 * call without a prototype is an implicit `int f()`, and on wasm a call
 * whose signature differs from the definition's traps. The definitions are
 * in src/web/web_libc.c.
 */
#ifndef ATV2_WASM_COMPAT_H
#define ATV2_WASM_COMPAT_H
#ifdef __wasm__
void tzset(void);                    /* time.h: "WASI has no timezone tables" */
_Noreturn void pthread_exit(void *); /* pthread.h: upstream-only */
#endif
#endif
