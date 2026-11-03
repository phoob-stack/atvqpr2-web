/*
 * Guest memory on wasm, end to end: the access macros the generated code uses
 * (recomp_types.h, __wasm__ branch), the layout init (xbox_memory_layout.c),
 * the slow path (wasm_mem.c) and the device models behind the MMIO checks.
 *
 *   web/wasm/test-mem.sh      (builds this and runs it under Node's WASI)
 *
 * Every alias range is written through one address and read back through
 * another, every device range is checked to reach its model rather than plain
 * memory, and the runtime's own memory is checked to stay out of the guest's.
 */
#define RECOMP_GENERATED_CODE 1     /* the generated shards' view of the header */
#include "recomp_types.h"
#undef eax
#undef ecx
#undef edx
#undef esp
#undef ebx
#undef esi
#undef edi

#include "kernel/xbox_memory_layout.h"
#include "kernel/wasm_mem.h"
#include "usb/ohci.h"
#include "apu/apu.h"
#include "apu/apu_state.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern MCPXAPUState *g_apu_state;

static int g_fail, g_pass;

#define CHECK(cond, ...) do { \
    if (cond) { g_pass++; } \
    else { g_fail++; printf("FAIL %s:%d: ", __FILE__, __LINE__); \
           printf(__VA_ARGS__); printf("\n"); } \
} while (0)

/* A guest VA as the runtime's C code sees it: base + VA. */
static volatile uint32_t *host32(uint32_t va)
{
    return (volatile uint32_t *)((uintptr_t)xbox_GetMemoryOffset() + va);
}

/* The smallest XBE the loader accepts: one section at 0x11000. */
static uint8_t *fake_xbe(size_t *size)
{
    static uint8_t x[0x2000];
    uint32_t *w = (uint32_t *)x;
    uint8_t *sh = x + 0x200;
    uint32_t i;

    memcpy(x, "XBEH", 4);
    w[0x104 / 4] = 0x10000;                  /* base */
    w[0x108 / 4] = 0x1000;                   /* header size */
    w[0x118 / 4] = 0x10000 + 0x180;          /* certificate */
    w[0x11C / 4] = 1;                        /* sections */
    w[0x120 / 4] = 0x10000 + 0x200;          /* section headers */
    w[0x158 / 4] = 0x00012800u ^ 0x5B6D40B6u; /* kernel thunks (zero: none) */
    ((uint32_t *)sh)[0] = 0x6;               /* flags: executable */
    ((uint32_t *)sh)[1] = 0x11000;           /* VA */
    ((uint32_t *)sh)[2] = 0x2000;            /* virtual size (half BSS) */
    ((uint32_t *)sh)[3] = 0x1000;            /* raw offset */
    ((uint32_t *)sh)[4] = 0x1000;            /* raw size */
    ((uint32_t *)sh)[5] = 0x10000 + 0x300;   /* name */
    memcpy(x + 0x300, "TEST", 5);
    for (i = 0x1000; i < 0x2000; i++)
        x[i] = (uint8_t)(i * 7 + 1);
    *size = sizeof x;
    return x;
}

int main(void)
{
    size_t xbe_size;
    const uint8_t *xbe = fake_xbe(&xbe_size);

    setenv("RECOMP_AC97_READY", "1", 1);
    setenv("RECOMP_USB", "1", 1);

    /* ---- layout ------------------------------------------------------ */
    CHECK(xbox_MemoryLayoutInit(xbe, xbe_size), "xbox_MemoryLayoutInit failed");
    CHECK(xbox_GetMemoryOffset() == XBOX_WASM_OFFSET,
          "offset %ld", (long)xbox_GetMemoryOffset());
    CHECK((uintptr_t)xbox_GetMemoryBase() == XBOX_WASM_OFFSET, "base %p",
          xbox_GetMemoryBase());
    CHECK((uint64_t)__builtin_wasm_memory_size(0) * 65536 >= XBOX_WASM_MEM_END,
          "memory %u pages", (unsigned)__builtin_wasm_memory_size(0));
    /* the XBE section is where its VA says, loaded and BSS-zeroed */
    CHECK(MEM8(0x11000) == (uint8_t)(0x1000 * 7 + 1) && MEM8(0x11FFF) ==
          (uint8_t)(0x1FFF * 7 + 1) && MEM32(0x12000) == 0, "section load");
    CHECK(MEM32(0x10000) == 0x48454258u, "XBE header at 0x10000");

    /* ---- RAM: fast path, both views ------------------------------------ */
    MEM32_ST(0x00123450, 0x11223344u);
    CHECK(*host32(0x00123450) == 0x11223344u, "RAM store vs host view");
    *host32(0x00123454) = 0xCAFEF00Du;
    CHECK(MEM32(0x00123454) == 0xCAFEF00Du, "host store vs RAM load");
    MEM8_ST(0x00123458, 0x80);
    CHECK(SMEM8(0x00123458) == -128 && MEM8(0x00123458) == 0x80, "SMEM8 sign");
    MEM32_ST(0x00123461, 0xA1B2C3D4u);       /* unaligned */
    CHECK(MEM32(0x00123461) == 0xA1B2C3D4u && MEM8(0x00123461) == 0xD4,
          "unaligned");

    /* ---- RAM mirrors: folded --------------------------------------------- */
    CHECK(MEM32(0x04123450) == 0x11223344u, "mirror 1 read");
    CHECK(MEM32(0x70123450) == 0x11223344u, "mirror 28 read");
    MEM16_ST(0x08123450, 0xBEEF);
    CHECK(MEM16(0x00123450) == 0xBEEF, "mirror 2 store");
    MEMF_ST(0x3C123470, 2.5f);
    CHECK(MEMF(0x00123470) == 2.5f, "mirror float");
    MEMD_ST(0x00123478, -1.25);
    CHECK(MEMD(0x44123478) == -1.25, "mirror double");
    SMEM64_ST(0x0C123480, -2);
    CHECK(SMEM64(0x00123480) == -2 && MEM32(0x00123484) == 0xFFFFFFFFu,
          "mirror 64-bit");
    CHECK(*host32(0x04123450) == 0, "the mirrors' linear range stays a hole");

    /* ---- contiguous window: fast path ------------------------------------ */
    MEM32_ST(0x80001000 + 0x100, 0x5EED5EEDu);
    CHECK(*host32(0x80001100) == 0x5EED5EEDu, "contig store vs host view");
    CHECK(MEM32(0x00001100) != 0x5EED5EEDu, "contig is not RAM (as native)");

    /* ---- tiled aperture: folded onto the contiguous window --------------- */
    MEM32_ST(0xF0002000, 0x7117ED00u);
    CHECK(MEM32(0x80002000) == 0x7117ED00u, "tiled store, contig load");
    CHECK(*host32(0x80002000) == 0x7117ED00u, "tiled store, host view");
    MEMD_ST(0x80002008, 1.5);
    CHECK(MEMD(0xF0002008) == 1.5, "contig store, tiled load");
    {
        RecompXmm v = { .u = { 1, 2, 3, 4 } }, r;
        XMM_STORE(0xF0002010, v);
        r = XMM_MEM(0x80002010);
        CHECK(r.u[0] == 1 && r.u[3] == 4, "XMM via tiled");
    }
    {
        uint32_t old = RECOMP_ATOMIC_CAS32(XBOX_PTR(0xF0002000), 0x7117ED00u, 9u);
        CHECK(old == 0x7117ED00u && MEM32(0x80002000) == 9u, "cmpxchg via tiled");
    }

    /* ---- XBOX_PTR (rep movs/stos), PUSH/POP ------------------------------ */
    memcpy((void *)XBOX_PTR(0x04200000), "hello", 6);
    CHECK(!memcmp((const void *)XBOX_PTR(0x00200000), "hello", 6),
          "memcpy through a mirror pointer");
    {
        uint32_t sp = 0x00300000, v = 0;
        PUSH32(sp, 0xABCDEF01u);
        CHECK(sp == 0x002FFFFC && MEM32(0x002FFFFC) == 0xABCDEF01u, "PUSH32");
        POP32(sp, v);
        CHECK(sp == 0x00300000 && v == 0xABCDEF01u, "POP32");
    }

    /* ---- NV2A: plain registers, guest and host agree -------------------- */
    MEM32_ST(0xFD100410, 0x00010000u);
    CHECK(xbox_Nv2aRegPtr(0x100410) && *xbox_Nv2aRegPtr(0x100410) == 0x00010000u,
          "NV2A guest store, host read");
    *xbox_Nv2aRegPtr(0x600100) = 5;
    CHECK(MEM32(0xFD600100) == 5, "NV2A host store, guest read");
    SMEM64_ST(0xFD000800, 0x1122334455667788ll);
    CHECK(MEM32(0xFD000800) == 0x55667788u && MEM32(0xFD000804) == 0x11223344u,
          "NV2A 64-bit split");
    MEM32_ST(0xFD400100, 0x123);   /* PGRAPH page, no interrupt pending: plain */
    CHECK(*xbox_Nv2aRegPtr(0x400100) == 0x123, "PGRAPH page plain while unarmed");

    /* ---- AC'97: RR completes on the write -------------------------------- */
    CHECK(MEM32(0xFEC00130) & 0x100, "AC97 codec ready");
    MEM8_ST(0xFEC0010B, 0x03);                 /* RR | RPBM */
    CHECK(MEM8(0xFEC0010B) == 0x01, "AC97 RR cleared, RPBM kept (%02X)",
          MEM8(0xFEC0010B));

    /* ---- APU: reaches the model, not the aperture ------------------------ */
    g_apu_state = (MCPXAPUState *)calloc(1, sizeof(MCPXAPUState));
    MEM32_ST(0xFE800000 + NV_PAPU_XGSCNT, 1234);
    CHECK(g_apu_state->sample_count == 1234, "APU write reached the model");
    CHECK(MEM32(0xFE800000 + NV_PAPU_XGSCNT) == 1234, "APU read from the model");
    CHECK(*host32(0xFE800000 + NV_PAPU_XGSCNT) == 0, "APU aperture memory untouched");
    g_apu_state->regs[0x1000] = 0x600D;
    CHECK(MEM32(0xFE801000) == 0x600D, "APU register file read");
    MEM32_ST(0xFE830000 + 0x10, 77);           /* GP DSP memory: plain, as native */
    CHECK(*host32(0xFE830010) == 77, "GP memory is plain");

    /* ---- OHCI: reaches the controller model ------------------------------ */
    xbox_OhciInit();
    CHECK(xbox_OhciOwnsAddress(0xFED00000), "OHCI enabled");
    CHECK(MEM32(0xFED00000) == 0x10, "HcRevision from the model (%08X)",
          MEM32(0xFED00000));
    CHECK(*host32(0xFED00000) == 0, "OHCI aperture memory untouched");
    MEM32_ST(0xFED00020, 0x80004000u);         /* HcControlHeadED */
    CHECK(MEM32(0xFED00020) == 0x80004000u, "HcControlHeadED round trip");
    CHECK(*host32(0xFED00020) == 0, "OHCI write went to the model");
    CHECK(MEM32(0xFED08000) == 0x10, "second controller");

    /* ---- unmapped: no fault, counted, nothing corrupted ------------------ */
    {
        uint64_t before = xbox_WasmUnmappedCount();
        CHECK(MEM32(0x90000000) == 0, "unmapped read is 0");
        MEM32_ST(0x90000000, 1);
        MEM32_ST(0xFE000000, 1);               /* between NV2A and MCPX */
        CHECK(xbox_WasmUnmappedCount() == before + 3, "unmapped counted");
    }

    /* ---- the runtime stays out of the guest's windows -------------------- */
    {
        uint8_t *p = malloc(256u << 20);
        uintptr_t a = (uintptr_t)p;
        CHECK(p && a >= XBOX_WASM_RUNTIME_LO && a + (256u << 20) <= XBOX_WASM_RUNTIME_HI,
              "malloc at %p", (void *)p);
        if (p) { memset(p, 0xEE, 256u << 20); free(p); }
        CHECK(MEM32(0x00123454) == 0xCAFEF00Du && MEM32(0x80001100) == 0x5EED5EEDu,
              "guest memory intact after malloc");
    }

    printf("wasm memory test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
