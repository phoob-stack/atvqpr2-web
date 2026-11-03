/*
 * roam_net.c -- the native transport for free roam (src/roam.c): one
 * WebSocket (RFC 6455) client on Winsock, on its own thread, between the
 * roam mailbox and the hub. The same protocol the browser speaks with its own
 * WebSocket (web/host/roam.js), so native and browser players share a hub.
 *
 *   - connects to host:port (loopback by default; the hub binds 127.0.0.1),
 *     retrying every second; "open"/"close" go to the game as events, and the
 *     game sends its hello (with the hub's resume token after a reconnect);
 *   - text frames carry the JSON control messages, binary frames the
 *     snapshot bundles; client frames are masked, as the RFC requires;
 *   - answers pings, sends a close on shutdown.
 *
 * No library beyond Winsock. The browser build has no thread here: the page
 * pumps the mailbox (atv2_roam_net_start publishes it in WebHost).
 */
#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "roam.h"

#if defined(_WIN32)

static char     s_hub_host[64];
static char     s_hub_port[16];
static SOCKET   s_sock = INVALID_SOCKET;
static uint8_t  s_rx[1 << 17];
static int      s_rx_n;

static void ev(const char *what)
{
    atv2_roam_in_put(ROAM_KIND_EVENT, what, (unsigned)strlen(what));
}

static int send_all(const uint8_t *p, int n)
{
    while (n > 0) {
        int k = send(s_sock, (const char *)p, n, 0);
        if (k <= 0) {
            if (WSAGetLastError() == WSAEWOULDBLOCK) { Sleep(0); continue; }
            return 0;
        }
        p += k; n -= k;
        atv2_roam_mb.stat_tx_bytes += (uint32_t)k;
    }
    return 1;
}

static uint32_t s_rng = 0x2545F491u;
static uint32_t rnd(void) { s_rng ^= s_rng << 13; s_rng ^= s_rng >> 17; s_rng ^= s_rng << 5; return s_rng; }

static int ws_send(int opcode, const uint8_t *p, int n)
{
    uint8_t hdr[14], mask[4];
    static uint8_t tmp[70000];
    int h = 0, i;
    uint32_t m = rnd();
    if (n > (int)sizeof tmp) return 0;
    hdr[h++] = (uint8_t)(0x80 | opcode);
    if (n < 126) hdr[h++] = (uint8_t)(0x80 | n);
    else { hdr[h++] = 0x80 | 126; hdr[h++] = (uint8_t)(n >> 8); hdr[h++] = (uint8_t)n; }
    memcpy(mask, &m, 4);
    memcpy(hdr + h, mask, 4); h += 4;
    for (i = 0; i < n; i++) tmp[i] = p[i] ^ mask[i & 3];
    return send_all(hdr, h) && send_all(tmp, n);
}

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int ws_connect(void)
{
    struct addrinfo hints, *ai = NULL, *a;
    char req[512], key[32];
    uint8_t raw[16];
    int i, n = 0;
    u_long nb = 1;
    DWORD to = 3000;

    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(s_hub_host, s_hub_port, &hints, &ai) != 0 || !ai)
        return 0;
    for (a = ai; a; a = a->ai_next) {
        s_sock = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s_sock == INVALID_SOCKET) continue;
        if (connect(s_sock, a->ai_addr, (int)a->ai_addrlen) == 0) break;
        closesocket(s_sock);
        s_sock = INVALID_SOCKET;
    }
    freeaddrinfo(ai);
    if (s_sock == INVALID_SOCKET)
        return 0;
    { int one = 1; setsockopt(s_sock, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one); }
    setsockopt(s_sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&to, sizeof to);
    for (i = 0; i < 16; i++) raw[i] = (uint8_t)rnd();
    for (i = 0; i < 15; i += 3) {
        uint32_t v = (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2];
        key[n++] = B64[v >> 18]; key[n++] = B64[(v >> 12) & 63]; key[n++] = B64[(v >> 6) & 63]; key[n++] = B64[v & 63];
    }
    key[n++] = B64[raw[15] >> 2]; key[n++] = B64[(raw[15] & 3) << 4]; key[n++] = '='; key[n++] = '='; key[n] = 0;
    n = snprintf(req, sizeof req,
                 "GET /roam HTTP/1.1\r\nHost: %s:%s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                 "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: atv2-recomp\r\n\r\n",
                 s_hub_host, s_hub_port, key);
    if (!send_all((const uint8_t *)req, n))
        goto fail;
    /* response head */
    n = 0;
    while (n < (int)sizeof req - 1) {
        int k = recv(s_sock, req + n, 1, 0);
        if (k <= 0) goto fail;
        n += k;
        req[n] = 0;
        if (n >= 4 && !memcmp(req + n - 4, "\r\n\r\n", 4)) break;
    }
    if (!strstr(req, " 101 "))
        goto fail;
    ioctlsocket(s_sock, FIONBIO, &nb);
    s_rx_n = 0;
    return 1;
fail:
    closesocket(s_sock);
    s_sock = INVALID_SOCKET;
    return 0;
}

/* Parse whole frames out of s_rx; 0 on a protocol error or close. */
static int ws_parse(void)
{
    int at = 0;
    while (s_rx_n - at >= 2) {
        uint8_t b0 = s_rx[at], b1 = s_rx[at + 1];
        int op = b0 & 15, masked = b1 & 0x80, h = 2;
        uint64_t len = b1 & 127;
        uint8_t mk[4] = {0, 0, 0, 0};
        uint8_t *pl;
        uint64_t i;
        if (len == 126) { if (s_rx_n - at < 4) break; len = (s_rx[at + 2] << 8) | s_rx[at + 3]; h = 4; }
        else if (len == 127) {
            if (s_rx_n - at < 10) break;
            len = 0;
            for (i = 0; i < 8; i++) len = (len << 8) | s_rx[at + 2 + i];
            h = 10;
        }
        if (masked) { if (s_rx_n - at < h + 4) break; memcpy(mk, s_rx + at + h, 4); h += 4; }
        if (len > sizeof s_rx - 16) return 0;
        if ((uint64_t)(s_rx_n - at - h) < len) break;
        pl = s_rx + at + h;
        if (masked) for (i = 0; i < len; i++) pl[i] ^= mk[i & 3];
        if (op == 1 || op == 2)
            atv2_roam_in_put(op == 1 ? ROAM_KIND_TEXT : ROAM_KIND_BINARY, pl, (unsigned)len);
        else if (op == 8)
            return 0;
        else if (op == 9)
            ws_send(10, pl, (int)len);
        at += h + (int)len;
    }
    if (at) { memmove(s_rx, s_rx + at, s_rx_n - at); s_rx_n -= at; }
    return 1;
}

static DWORD WINAPI net_thread(LPVOID arg)
{
    static uint8_t msg[0x10000];
    (void)arg;
    for (;;) {
        if (s_sock == INVALID_SOCKET) {
            atv2_roam_mb.state = 1;
            if (!ws_connect()) { Sleep(1000); continue; }
            atv2_roam_mb.state = 2;
            ev("open");
        }
        /* outgoing */
        {
            int kind, n, ok = 1;
            while (ok && (n = atv2_roam_out_get(&kind, msg, sizeof msg)) >= 0)
                ok = ws_send(kind == ROAM_KIND_TEXT ? 1 : 2, msg, n);
            if (!ok) goto lost;
        }
        /* incoming */
        {
            fd_set rf;
            struct timeval tv = {0, 2000};
            int k;
            FD_ZERO(&rf);
            FD_SET(s_sock, &rf);
            if (select(0, &rf, NULL, NULL, &tv) > 0) {
                k = recv(s_sock, (char *)s_rx + s_rx_n, (int)sizeof s_rx - s_rx_n, 0);
                if (k == 0 || (k < 0 && WSAGetLastError() != WSAEWOULDBLOCK)) goto lost;
                if (k > 0) {
                    s_rx_n += k;
                    atv2_roam_mb.stat_rx_bytes += (uint32_t)k;
                    if (!ws_parse()) goto lost;
                }
            }
        }
        continue;
lost:
        closesocket(s_sock);
        s_sock = INVALID_SOCKET;
        atv2_roam_mb.state = 1;
        ev("close");
        Sleep(500);
    }
    return 0;
}

void atv2_roam_net_start(const char *addr)
{
    WSADATA w;
    const char *c = strrchr(addr, ':');
    if (!c) {
        fprintf(stderr, "[ROAM] RECOMP_ROAM wants host:port (got %s)\n", addr);
        return;
    }
    snprintf(s_hub_host, sizeof s_hub_host, "%.*s", (int)(c - addr), addr);
    snprintf(s_hub_port, sizeof s_hub_port, "%s", c + 1);
    s_rng ^= GetTickCount() * 2654435761u ^ GetCurrentProcessId();
    WSAStartup(MAKEWORD(2, 2), &w);
    CloseHandle(CreateThread(NULL, 0, net_thread, NULL, 0, NULL));
}

#else  /* browser: the page is the transport */

void web_host_set_roam(void *mb);

void atv2_roam_net_start(const char *addr)
{
    (void)addr;
    web_host_set_roam(&atv2_roam_mb);
}

#endif
