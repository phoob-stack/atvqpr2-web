# Free-roam hub: hosting notes

The hub is `web/tools/roamhub.mjs` plus `web/roamhub-worker/protocol.mjs`
(imported as `../roamhub-worker/protocol.mjs`; keep that layout, or edit the
one import line). Node 22+ built-ins only: no `npm install`. It relays player
state only (names, rider / ATV choices, poses, trick / engine state); it holds
and serves nothing from the game.

The Pterodactyl egg is in `deploy\pterodactyl\` (written separately); it starts:

    node roamhub.mjs --port <SERVER_PORT> --bind 0.0.0.0 --trust-proxy cf \
      --origins https://atvqpr2.com,https://www.atvqpr2.com \
      --max-players <N> --max-rooms <N> --max-conns-per-ip <N> --idle-timeout <s> \
      --allow-no-origin <0|1>

Ready line (the egg's "done" string): `roamhub on ws://0.0.0.0:<port>/ (...)`.
SIGINT (the panel's stop, `^C`) and SIGTERM close every connection with
1001 "hub stopping" and exit 0.

## Flags

| flag | meaning |
|---|---|
| `--port N` | listening port (the allocation) |
| `--bind A` | default `127.0.0.1`; any other address only when given, with a `WARNING: bound to ...` line |
| `--trust-proxy cf` | per-IP limits and logs use `CF-Connecting-IP`; without it forwarding headers are ignored and the socket's peer counts |
| `--origins a,b` | the browser `Origin` must be one of these, else HTTP 403. Public bind without `--origins`: `https://atvqpr2.com,https://www.atvqpr2.com` |
| `--allow-no-origin 0\|1` | `1`: a connection without `Origin` (the native game) is let in. Default `0`. A bare `--allow-no-origin` means `1` |
| `--max-players N` | players in all rooms together (a resume always gets back in) |
| `--max-rooms N` | rooms at once; a room holds up to 8 riders (the game's limit, `--room-players` lowers it) |
| `--max-conns-per-ip N` | open WebSockets per address, else HTTP 429 |
| `--idle-timeout s` | nothing received for this long: closed (4004). Clients send a keepalive every 10 s |
| `--grace s` | a dropped player keeps its id (and slot) this long for a resume (10) |
| `--collide 0\|1`, `--ghost s` | collisions for every room (off), ghost period (3 s) |
| `--log file`, `--quiet` | log to a file, nothing on stdout |
| `--delay/--jitter/--loss/--inject-bad` | test aids (network simulation, bad records) |

Always on: a hello within 10 s (else 4003); text frames <= 1 KB and binary <=
1 KB from a client (records <= 128 bytes, at most 4 per frame); 10 messages/s
and 45 records/s per player (token buckets), 300 dropped inputs close the
connection (4008); every record's position / velocity finite and in range, a
real rotation, rpm and trick id in range (else dropped, never forwarded).

`GET /` (no upgrade) answers `200 text/plain`:
`atv2 roamhub v2: N players, M rooms` -- counts only, no names or addresses.
The "is it up behind Cloudflare" check is `curl https://hub.atvqpr2.com/`.
(`/status.json` and `/drop` exist on loopback binds only, for tests.)

## TLS: Cloudflare in front (the chosen setup)

`hub.atvqpr2.com` proxied (orange cloud), SSL/TLS mode **Flexible** for that
host, an Origin Rule sending it to the allocation port. Browsers connect to
`wss://hub.atvqpr2.com/`; Cloudflare terminates TLS and speaks plain ws to the
hub. If the allocation port is one Cloudflare proxies directly (HTTP:
80, 8080, 8880, 2052, 2082, 2086, 2095), no Origin Rule is needed for the port.
WebSockets must be on (Network tab; on by default). With "Always Use HTTPS"
on, plain `ws://hub.atvqpr2.com` from the native game is redirected and fails:
the native game uses `wss://` (below).

## TLS alternative: nginx (the panel's own) as the reverse proxy

    # /etc/nginx/sites-available/roamhub.conf
    map $http_upgrade $connection_upgrade { default upgrade; '' close; }
    server {
        listen 443 ssl;
        server_name hub.atvqpr2.com;
        ssl_certificate     /etc/letsencrypt/live/hub.atvqpr2.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/hub.atvqpr2.com/privkey.pem;
        location / {
            proxy_pass http://127.0.0.1:<SERVER_PORT>;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_set_header CF-Connecting-IP $remote_addr;   # the hub's --trust-proxy cf reads this
            proxy_read_timeout 300s;
        }
    }

Then start the hub with `--bind 127.0.0.1` (only nginx reaches it) and
`--trust-proxy cf`. (Behind Cloudflare *and* nginx, pass Cloudflare's own
header through instead: `proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;`
-- and only accept connections from Cloudflare's ranges in that case.)

## Clients

`RECOMP_ROAM` takes `host:port` (a local hub: `ws://host:port/roam`) or a full
URL: `ws://host[:port]/path`, `wss://host[:port]/path`. A path `/room/<name>`
names the room (else the hello's `room=` option, else `freeride`).

- Browser (web/host): `?roam=wss://hub.atvqpr2.com/` (`&roam_name=NAME`), or the
  settings `roam_url` / `roam_name` in `localStorage['atv2.settings.v1'].values`
  (strings; `roam_url` must be `ws://` or `wss://`, `roam_name` up to 20
  printable characters). They become `RECOMP_ROAM=<url>;name=<name>`; `?env=RECOMP_ROAM=`
  still wins. No URL: Free Ride runs single-player and offline, as before.
  Reconnects back off from 1 s to 15 s.
- Native (Windows): `RECOMP_ROAM=wss://hub.atvqpr2.com/,name=NAME` works -- TLS
  through Windows Schannel (src/roam_net.c), the certificate checked against
  Windows' trusted roots and the host name. The native game sends no `Origin`,
  so the hub needs `--allow-no-origin 1` for native players.
  `RECOMP_ROAM_TLS_INSECURE=1` skips the certificate check for a loopback
  (127.0.0.1 / localhost) test hub only; it is ignored for any other host.

## Site CSP

The page needs one `connect-src` addition:

    connect-src ... wss://hub.atvqpr2.com

(`ws://127.0.0.1:*` only for local tests; not for the public site.)

## Tested here (127.0.0.1 only)

`node web/roamhub-worker/test.mjs`: protocol and room logic, the Worker /
Durable Object version (parked), the hub process with the hosted flags on
127.0.0.2 (warning, ready line, origins, missing Origin, per-IP limit from
CF-Connecting-IP, GET / status, idle close, no-hello close, `--allow-no-origin 1`).
TLS: `work\roam2\tools\tlsproxy.mjs` (Node `tls`, a self-signed certificate
made with Git's openssl) in front of the hub stands in for Cloudflare / nginx;
the native game connected over `wss://127.0.0.1:8443/room/freeride` (and was
refused, as it should be, without `RECOMP_ROAM_TLS_INSECURE=1`).
