/*
 * roam_net.c -- the native transport for free roam (src/roam.c): one
 * WebSocket (RFC 6455) client on Winsock, on its own thread, between the
 * roam mailbox and the hub. The same protocol the browser speaks with its own
 * WebSocket (web/host/roam.js), so native and browser players share a hub.
 *
 *   RECOMP_ROAM=host:port            ws://host:port/roam (a local hub)
 *   RECOMP_ROAM=ws://host[:port]/path
 *   RECOMP_ROAM=wss://host[:port]/path   TLS through Windows Schannel
 *                                    (e.g. wss://hub.atvqpr2.com/)
 *
 *   - connects, retrying (1 s, doubling to 15 s while the hub is
 *     unreachable); "open"/"close" go to the game as events, and the game
 *     sends its hello (with the hub's resume token after a reconnect);
 *   - wss: Schannel (secur32) negotiates TLS and checks the server's
 *     certificate against Windows' trusted roots and the host name; only for a
 *     loopback test hub, RECOMP_ROAM_TLS_INSECURE=1 skips that check (a
 *     self-signed test certificate);
 *   - text frames carry the JSON control messages, binary frames the
 *     snapshot bundles; client frames are masked, as the RFC requires; frames
 *     over ROAM_MAX_TEXT / ROAM_MAX_BINARY are dropped;
 *   - answers pings. The native game sends no Origin header (a hosted hub
 *     must allow that: roamhub.mjs --allow-no-origin 1).
 *
 * No library beyond Winsock and Schannel (both part of Windows). The browser
 * build has no thread here: the page pumps the mailbox (atv2_roam_net_start
 * publishes it in WebHost).
 */
#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#define SECURITY_WIN32
#include <security.h>
#include <schannel.h>
#if defined(_MSC_VER)
#pragma comment(lib, "secur32.lib")
#pragma comment(lib, "ws2_32.lib")
#endif
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "roam.h"

#if defined(_WIN32)

static char     s_hub_host[128];
static char     s_hub_port[16];
static char     s_hub_path[128];
static int      s_tls;                /* wss:// */
static int      s_tls_insecure;       /* loopback test hub only */
static SOCKET   s_sock = INVALID_SOCKET;
static uint8_t  s_rx[1 << 17];        /* plaintext from the hub */
static int      s_rx_n;
static unsigned s_oversize;

/* Schannel state */
static CredHandle s_cred;
static CtxtHandle s_ctx;
static int        s_have_cred, s_have_ctx;
static SecPkgContext_StreamSizes s_sizes;
static uint8_t    s_tin[1 << 17];     /* TLS records received, not yet decrypted */
static int        s_tin_n;
static uint8_t    s_tout[1 << 15];

static void ev(const char *what)
{
    atv2_roam_in_put(ROAM_KIND_EVENT, what, (unsigned)strlen(what));
}

static int raw_send(const uint8_t *p, int n)
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

/* ---- TLS (Schannel) ------------------------------------------------------- */

static void tls_free(void)
{
    if (s_have_ctx) { DeleteSecurityContext(&s_ctx); s_have_ctx = 0; }
    s_tin_n = 0;
}

static int tls_handshake(void)
{
    SecBuffer ob[1], ib[2];
    SecBufferDesc od = { SECBUFFER_VERSION, 1, ob }, id = { SECBUFFER_VERSION, 2, ib };
    DWORD flags = ISC_REQ_SEQUENCE_DETECT | ISC_REQ_REPLAY_DETECT | ISC_REQ_CONFIDENTIALITY |
                  ISC_REQ_ALLOCATE_MEMORY | ISC_REQ_STREAM | (s_tls_insecure ? ISC_REQ_MANUAL_CRED_VALIDATION : 0);
    DWORD outf;
    SECURITY_STATUS st;
    int first = 1;
    if (!s_have_cred) {
        SCHANNEL_CRED sc;
        memset(&sc, 0, sizeof sc);
        sc.dwVersion = SCHANNEL_CRED_VERSION;
        sc.dwFlags = SCH_CRED_NO_DEFAULT_CREDS |
                     (s_tls_insecure ? SCH_CRED_MANUAL_CRED_VALIDATION : SCH_CRED_AUTO_CRED_VALIDATION);
        if (AcquireCredentialsHandleA(NULL, (LPSTR)UNISP_NAME_A, SECPKG_CRED_OUTBOUND, NULL, &sc, NULL, NULL,
                                      &s_cred, NULL) != SEC_E_OK) {
            fprintf(stderr, "[ROAM] TLS: no Schannel credentials\n");
            return 0;
        }
        s_have_cred = 1;
    }
    s_tin_n = 0;
    for (;;) {
        ob[0].BufferType = SECBUFFER_TOKEN; ob[0].pvBuffer = NULL; ob[0].cbBuffer = 0;
        if (first) {
            st = InitializeSecurityContextA(&s_cred, NULL, s_hub_host, flags, 0, 0, NULL, 0, &s_ctx, &od, &outf, NULL);
            s_have_ctx = 1;
            first = 0;
        } else {
            ib[0].BufferType = SECBUFFER_TOKEN; ib[0].pvBuffer = s_tin; ib[0].cbBuffer = (unsigned long)s_tin_n;
            ib[1].BufferType = SECBUFFER_EMPTY; ib[1].pvBuffer = NULL; ib[1].cbBuffer = 0;
            st = InitializeSecurityContextA(&s_cred, &s_ctx, s_hub_host, flags, 0, 0, &id, 0, NULL, &od, &outf, NULL);
            if (st == SEC_E_INCOMPLETE_MESSAGE)
                goto more;
            if (ib[1].BufferType == SECBUFFER_EXTRA && ib[1].cbBuffer) {
                memmove(s_tin, s_tin + s_tin_n - ib[1].cbBuffer, ib[1].cbBuffer);
                s_tin_n = (int)ib[1].cbBuffer;
            } else
                s_tin_n = 0;
        }
        if (ob[0].cbBuffer && ob[0].pvBuffer) {
            int ok = raw_send((const uint8_t *)ob[0].pvBuffer, (int)ob[0].cbBuffer);
            FreeContextBuffer(ob[0].pvBuffer);
            if (!ok) return 0;
        }
        if (st == SEC_E_OK)
            break;
        if (st != SEC_I_CONTINUE_NEEDED) {
            fprintf(stderr, "[ROAM] TLS handshake with %s failed (0x%08lX)%s\n", s_hub_host, (unsigned long)st,
                    st == (SECURITY_STATUS)SEC_E_UNTRUSTED_ROOT || st == (SECURITY_STATUS)SEC_E_WRONG_PRINCIPAL ?
                    ": the certificate is not trusted for this name" : "");
            return 0;
        }
        if (s_tin_n)
            continue;                 /* the next handshake message is already here */
more:
        {
            int k = recv(s_sock, (char *)s_tin + s_tin_n, (int)sizeof s_tin - s_tin_n, 0);
            if (k <= 0) return 0;
            s_tin_n += k;
            atv2_roam_mb.stat_rx_bytes += (uint32_t)k;
        }
    }
    if (QueryContextAttributesA(&s_ctx, SECPKG_ATTR_STREAM_SIZES, &s_sizes) != SEC_E_OK)
        return 0;
    return 1;
}

static int tls_send(const uint8_t *p, int n)
{
    while (n > 0) {
        int chunk = n > (int)s_sizes.cbMaximumMessage ? (int)s_sizes.cbMaximumMessage : n;
        SecBuffer b[4];
        SecBufferDesc d = { SECBUFFER_VERSION, 4, b };
        if ((int)(s_sizes.cbHeader + chunk + s_sizes.cbTrailer) > (int)sizeof s_tout)
            chunk = (int)sizeof s_tout - (int)(s_sizes.cbHeader + s_sizes.cbTrailer);
        memcpy(s_tout + s_sizes.cbHeader, p, (size_t)chunk);
        b[0].BufferType = SECBUFFER_STREAM_HEADER;  b[0].pvBuffer = s_tout; b[0].cbBuffer = s_sizes.cbHeader;
        b[1].BufferType = SECBUFFER_DATA;           b[1].pvBuffer = s_tout + s_sizes.cbHeader; b[1].cbBuffer = (unsigned long)chunk;
        b[2].BufferType = SECBUFFER_STREAM_TRAILER; b[2].pvBuffer = s_tout + s_sizes.cbHeader + chunk; b[2].cbBuffer = s_sizes.cbTrailer;
        b[3].BufferType = SECBUFFER_EMPTY;          b[3].pvBuffer = NULL; b[3].cbBuffer = 0;
        if (EncryptMessage(&s_ctx, 0, &d, 0) != SEC_E_OK)
            return 0;
        if (!raw_send(s_tout, (int)(b[0].cbBuffer + b[1].cbBuffer + b[2].cbBuffer)))
            return 0;
        p += chunk; n -= chunk;
    }
    return 1;
}

/* Decrypt what has arrived into s_rx. 0 on a TLS error or close. */
static int tls_decrypt(void)
{
    while (s_tin_n > 0) {
        SecBuffer b[4];
        SecBufferDesc d = { SECBUFFER_VERSION, 4, b };
        SECURITY_STATUS st;
        int i, extra = 0;
        b[0].BufferType = SECBUFFER_DATA; b[0].pvBuffer = s_tin; b[0].cbBuffer = (unsigned long)s_tin_n;
        for (i = 1; i < 4; i++) { b[i].BufferType = SECBUFFER_EMPTY; b[i].pvBuffer = NULL; b[i].cbBuffer = 0; }
        st = DecryptMessage(&s_ctx, &d, 0, NULL);
        if (st == SEC_E_INCOMPLETE_MESSAGE)
            return 1;
        if (st == SEC_I_CONTEXT_EXPIRED)
            return 0;
        if (st != SEC_E_OK)
            return 0;                 /* incl. a renegotiation request: reconnect */
        for (i = 1; i < 4; i++) {
            if (b[i].BufferType == SECBUFFER_DATA && b[i].cbBuffer) {
                if (s_rx_n + (int)b[i].cbBuffer > (int)sizeof s_rx) return 0;
                memcpy(s_rx + s_rx_n, b[i].pvBuffer, b[i].cbBuffer);
                s_rx_n += (int)b[i].cbBuffer;
            } else if (b[i].BufferType == SECBUFFER_EXTRA)
                extra = (int)b[i].cbBuffer;
        }
        if (extra) memmove(s_tin, s_tin + s_tin_n - extra, (size_t)extra);
        s_tin_n = extra;
    }
    return 1;
}

/* ---- the byte stream, plain or TLS ----------------------------------------- */

static int net_send(const uint8_t *p, int n)
{
    return s_tls ? tls_send(p, n) : raw_send(p, n);
}

/* What has arrived, into s_rx (plaintext). -1 closed or error, else bytes read. */
static int net_recv(void)
{
    int k;
    if (s_tls) {
        k = recv(s_sock, (char *)s_tin + s_tin_n, (int)sizeof s_tin - s_tin_n, 0);
        if (k == 0) return -1;
        if (k < 0) return WSAGetLastError() == WSAEWOULDBLOCK ? 0 : -1;
        s_tin_n += k;
        atv2_roam_mb.stat_rx_bytes += (uint32_t)k;
        return tls_decrypt() ? k : -1;
    }
    k = recv(s_sock, (char *)s_rx + s_rx_n, (int)sizeof s_rx - s_rx_n, 0);
    if (k == 0) return -1;
    if (k < 0) return WSAGetLastError() == WSAEWOULDBLOCK ? 0 : -1;
    s_rx_n += k;
    atv2_roam_mb.stat_rx_bytes += (uint32_t)k;
    return k;
}

/* ---- WebSocket ----------------------------------------------------------------- */

static uint32_t s_rng = 0x2545F491u;
static uint32_t rnd(void) { s_rng ^= s_rng << 13; s_rng ^= s_rng >> 17; s_rng ^= s_rng << 5; return s_rng; }

static int ws_send(int opcode, const uint8_t *p, int n)
{
    static uint8_t tmp[70000];
    uint8_t mask[4];
    int h = 0, i;
    uint32_t m = rnd();
    if (n + 14 > (int)sizeof tmp) return 0;
    tmp[h++] = (uint8_t)(0x80 | opcode);
    if (n < 126) tmp[h++] = (uint8_t)(0x80 | n);
    else { tmp[h++] = 0x80 | 126; tmp[h++] = (uint8_t)(n >> 8); tmp[h++] = (uint8_t)n; }
    memcpy(mask, &m, 4);
    memcpy(tmp + h, mask, 4); h += 4;
    for (i = 0; i < n; i++) tmp[h + i] = p[i] ^ mask[i & 3];
    return net_send(tmp, h + n);
}

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void net_close(void)
{
    if (s_sock != INVALID_SOCKET) closesocket(s_sock);
    s_sock = INVALID_SOCKET;
    tls_free();
}

static int ws_connect(void)
{
    struct addrinfo hints, *ai = NULL, *a;
    char req[768], key[32], hosthdr[160];
    uint8_t raw[16];
    int i, n = 0, def;
    u_long nb = 1;
    DWORD to = 5000;

    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
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
    if (s_tls && !tls_handshake())
        goto fail;
    for (i = 0; i < 16; i++) raw[i] = (uint8_t)rnd();
    for (i = 0; i < 15; i += 3) {
        uint32_t v = (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2];
        key[n++] = B64[v >> 18]; key[n++] = B64[(v >> 12) & 63]; key[n++] = B64[(v >> 6) & 63]; key[n++] = B64[v & 63];
    }
    key[n++] = B64[raw[15] >> 2]; key[n++] = B64[(raw[15] & 3) << 4]; key[n++] = '='; key[n++] = '='; key[n] = 0;
    def = !strcmp(s_hub_port, s_tls ? "443" : "80");
    snprintf(hosthdr, sizeof hosthdr, def ? "%s" : "%s:%s", s_hub_host, s_hub_port);
    n = snprintf(req, sizeof req,
                 "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                 "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: atv2-recomp\r\n\r\n",
                 s_hub_path, hosthdr, key);
    if (!net_send((const uint8_t *)req, n))
        goto fail;
    /* response head (blocking, with the receive timeout); what follows it stays in s_rx */
    s_rx_n = 0;
    for (;;) {
        uint8_t *end = NULL;
        int k;
        for (k = 3; k < s_rx_n; k++)
            if (!memcmp(s_rx + k - 3, "\r\n\r\n", 4)) { end = s_rx + k + 1; break; }
        if (end) {
            int head = (int)(end - s_rx);
            char line[64];
            snprintf(line, sizeof line, "%.*s", head < 63 ? head : 63, (const char *)s_rx);
            if (!strstr(line, " 101 ")) {
                char *eol = strstr(line, "\r\n");
                if (eol) *eol = 0;
                fprintf(stderr, "[ROAM] hub refused the connection: %s\n", line);
                goto fail;
            }
            memmove(s_rx, end, (size_t)(s_rx_n - head));
            s_rx_n -= head;
            break;
        }
        if (s_rx_n > 4096 || net_recv() <= 0)
            goto fail;
    }
    ioctlsocket(s_sock, FIONBIO, &nb);
    return 1;
fail:
    net_close();
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
        if (op == 1 || op == 2) {
            /* frame size limits (roam.h): a bigger frame is not ours -- dropped */
            if (len > (op == 1 ? ROAM_MAX_TEXT : ROAM_MAX_BINARY)) {
                if (s_oversize++ < 5)
                    fprintf(stderr, "[ROAM] dropped a %s frame of %u bytes (limit %u)\n", op == 1 ? "text" : "binary",
                            (unsigned)len, op == 1 ? ROAM_MAX_TEXT : ROAM_MAX_BINARY);
            } else
                atv2_roam_in_put(op == 1 ? ROAM_KIND_TEXT : ROAM_KIND_BINARY, pl, (unsigned)len);
        }
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
    DWORD backoff = 1000;
    (void)arg;
    for (;;) {
        if (s_sock == INVALID_SOCKET) {
            atv2_roam_mb.state = 1;
            if (!ws_connect()) {
                Sleep(backoff);
                backoff = backoff * 2 > 15000 ? 15000 : backoff * 2;
                continue;
            }
            backoff = 1000;
            atv2_roam_mb.state = 2;
            fprintf(stderr, "[ROAM] %s connection to %s:%s%s\n", s_tls ? "TLS (wss)" : "plain (ws)",
                    s_hub_host, s_hub_port, s_hub_path);
            fflush(stderr);
            ev("open");
            if (s_rx_n && !ws_parse()) goto lost;   /* frames that came with the response */
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
            FD_ZERO(&rf);
            FD_SET(s_sock, &rf);
            if (select(0, &rf, NULL, NULL, &tv) > 0) {
                int k = net_recv();
                if (k < 0) goto lost;
                if (k > 0 && !ws_parse()) goto lost;
            }
        }
        continue;
lost:
        net_close();
        atv2_roam_mb.state = 1;
        ev("close");
        Sleep(500);
    }
    return 0;
}

/* host:port | ws://host[:port][/path] | wss://host[:port][/path] */
static int parse_hub(const char *addr)
{
    const char *p = addr, *hs, *he, *slash;
    s_tls = 0;
    snprintf(s_hub_path, sizeof s_hub_path, "/roam");
    if (!strncmp(p, "wss://", 6)) { s_tls = 1; p += 6; snprintf(s_hub_path, sizeof s_hub_path, "/"); }
    else if (!strncmp(p, "ws://", 5)) { p += 5; snprintf(s_hub_path, sizeof s_hub_path, "/"); }
    slash = strchr(p, '/');
    hs = p; he = slash ? slash : p + strlen(p);
    if (slash) snprintf(s_hub_path, sizeof s_hub_path, "%s", slash);
    if (*hs == '[') {                                  /* [ipv6]:port */
        const char *rb = memchr(hs, ']', (size_t)(he - hs));
        if (!rb) return 0;
        snprintf(s_hub_host, sizeof s_hub_host, "%.*s", (int)(rb - hs - 1), hs + 1);
        if (rb + 1 < he && rb[1] == ':') snprintf(s_hub_port, sizeof s_hub_port, "%.*s", (int)(he - rb - 2), rb + 2);
        else snprintf(s_hub_port, sizeof s_hub_port, s_tls ? "443" : "80");
    } else {
        const char *c = memchr(hs, ':', (size_t)(he - hs));
        snprintf(s_hub_host, sizeof s_hub_host, "%.*s", (int)((c ? c : he) - hs), hs);
        if (c) snprintf(s_hub_port, sizeof s_hub_port, "%.*s", (int)(he - c - 1), c + 1);
        else if (addr != p) snprintf(s_hub_port, sizeof s_hub_port, s_tls ? "443" : "80");
        else return 0;                                 /* bare host:port needs the port */
    }
    return s_hub_host[0] && atoi(s_hub_port) > 0 && atoi(s_hub_port) < 65536;
}

void atv2_roam_net_start(const char *addr)
{
    WSADATA w;
    if (!parse_hub(addr)) {
        fprintf(stderr, "[ROAM] RECOMP_ROAM wants host:port or ws://host[:port]/path or wss://host[:port]/path (got %s)\n", addr);
        return;
    }
    if (s_tls && getenv("RECOMP_ROAM_TLS_INSECURE") && atoi(getenv("RECOMP_ROAM_TLS_INSECURE")) == 1) {
        if (!strcmp(s_hub_host, "127.0.0.1") || !strcmp(s_hub_host, "localhost") || !strcmp(s_hub_host, "::1")) {
            s_tls_insecure = 1;
            fprintf(stderr, "[ROAM] TLS certificate check OFF (RECOMP_ROAM_TLS_INSECURE, loopback test hub)\n");
        } else
            fprintf(stderr, "[ROAM] RECOMP_ROAM_TLS_INSECURE ignored: only for a loopback hub\n");
    }
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
