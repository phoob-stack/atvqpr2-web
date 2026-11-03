/*
 * test_stubs.c - what kernel_hal.c needs from the rest of the runtime that
 * threads_test.c does not exercise: the guest register file (main.c defines
 * it in the game), the memory layout's globals, the DPC queue (kernel_bridge.c)
 * and the log. Thread-local where the game's are, so the link is the same
 * shape as the game's.
 */
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define TLS __thread
typedef struct { uint8_t b[16]; } Xmm16;

TLS uint32_t g_eax, g_ebx, g_ecx, g_edx, g_esi, g_edi, g_ebp, g_esp;
TLS uint32_t g_eflags, g_seh_ebp, g_fs_base;
TLS int g_df, g_fp_top, g_fp_cmp;
TLS uint16_t g_fp_cc, g_fp_control_word;
TLS double g_fp_stack[8];
TLS uint64_t g_mm0, g_mm1, g_mm2, g_mm3, g_mm4, g_mm5, g_mm6, g_mm7;
TLS Xmm16 g_xmm0, g_xmm1, g_xmm2, g_xmm3, g_xmm4, g_xmm5, g_xmm6, g_xmm7;

ptrdiff_t g_xbox_mem_offset;
uint32_t g_xbox_stack_base;

int xbox_DpcPending(void) { return 0; }
int xbox_DpcDrainHere(void) { return 0; }
int xbox_worker_stack_alloc(void) { return -1; }
void xbox_worker_stack_free(int slot) { (void)slot; }

void xbox_log(int level, const char *subsystem, const char *fmt, ...)
{
    va_list ap;
    if (level > 1)
        return;
    va_start(ap, fmt);
    fprintf(stderr, "[%s] ", subsystem ? subsystem : "?");
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}
