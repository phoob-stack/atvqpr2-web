/* roam.h -- free roam (src/roam.c) and its transports (src/roam_net.c natively,
 * web/host/roam.js in the browser). */
#ifndef ATV2_ROAM_H
#define ATV2_ROAM_H
#include <stdint.h>

/* The mailbox between the game thread and the transport: two SPSC byte rings
 * of messages [u16 len][u8 kind][payload]. In the browser the page reads and
 * writes it in wasm memory (WebHost.reserved[0] holds its address); the
 * layout is mirrored in web/host/roam.js. */
#define ROAM_MB_MAGIC    0x4D414F52u  /* "ROAM" */
#define ROAM_MB_VERSION  1u
#define ROAM_OUT_CAP     16384u
#define ROAM_IN_CAP      65536u

#define ROAM_KIND_TEXT   1   /* WebSocket text frame (JSON control)    */
#define ROAM_KIND_BINARY 2   /* WebSocket binary frame (snapshots)     */
#define ROAM_KIND_EVENT  3   /* transport event: "open" / "close"      */

typedef struct RoamMailbox {
    uint32_t magic, version, size;
    volatile uint32_t state;          /* transport: 0 idle, 1 connecting, 2 open */
    char addr[64];                    /* host:port of the hub                    */
    uint32_t out_cap, in_cap;
    volatile uint32_t out_head, out_tail, in_head, in_tail;
    volatile uint32_t stat_tx_bytes, stat_rx_bytes;   /* transport, wire bytes  */
    volatile uint32_t nlabels;        /* browser overlay: labels below           */
    struct { float x, y, z; char name[20]; } labels[8];
    volatile uint8_t out[ROAM_OUT_CAP];
    volatile uint8_t in[ROAM_IN_CAP];
} RoamMailbox;

extern RoamMailbox atv2_roam_mb;

void atv2_roam_init(void);
void atv2_roam_flip(void);
void atv2_roam_draw_guest(uint32_t va, uint32_t w, uint32_t h, uint32_t pitch);

/* transport side */
void atv2_roam_net_start(const char *addr);
int  atv2_roam_out_get(int *kind, uint8_t *p, unsigned max);
int  atv2_roam_in_put(int kind, const void *p, unsigned n);
int  atv2_roam_out_put(int kind, const void *p, unsigned n);

#endif
