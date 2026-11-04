# Running the delivery stack on a VPS

This folder is configuration only. Nothing here has been deployed, no tunnel
has been created and no account has been logged into: these are the steps
for whoever owns the domain and the server.

What runs (all from the stock `node`, `caddy` and `cloudflared` images; no
image is built):

| service | what | reachable |
|---|---|---|
| `assets` | `server/asset-server.mjs`: the launcher page at `/`, manifest and objects at `/assets/` (Range, ETag, immutable caching, gzip/brotli, COOP/COEP/CORP, rate limit). Refuses to start if its folders fail the no-game-content scan. | container network only |
| `hub` | `hub/hub.mjs`: the free-roam hub (WebSocket), only for pages from `https://DOMAIN` | container network only |
| `caddy` (profile `caddy`) | front door with automatic HTTPS for `DOMAIN` | ports 80, 443 (TCP+UDP) |
| `caddy-tunnel` + `cloudflared` (profile `tunnel`) | the same routes on plain HTTP, reached only through a Cloudflare Tunnel | no open ports |

Routes (`Caddyfile`):

- `https://DOMAIN/` - the project site, exactly as committed (`out/site`, a
  `git archive` of `site/`), with the site's own `_headers` (converted to
  `out/site.caddy` by the pipeline). ATV 2 keeps its "Select local game files"
  path there; nothing of the game is served.
- `https://DOMAIN/demo/` - the delivery test title (launcher + its assets).
- `wss://DOMAIN/hub/` - the free-roam hub.

All containers run read-only, as an unprivileged user, with all capabilities
dropped (Caddy keeps only `NET_BIND_SERVICE`), and mount the pipeline output
read-only.

## 1. What you need

- A VPS with Docker Engine and the Compose plugin (any small x86-64/arm64
  Linux box; the stack idles at well under 200 MB of RAM).
- A domain name.
- For the `caddy` profile: DNS `A`/`AAAA` records for `DOMAIN` pointing at
  the VPS, and ports 80 and 443 open to the internet.
- For the `tunnel` profile instead: the domain on Cloudflare, and a
  Cloudflare account to create the tunnel. No inbound ports at all.
- An e-mail address for Let's Encrypt (caddy profile).

## 2. Build the output (on any machine with Node 22+ and wasi-sdk)

```
node pipeline/build.mjs --hub-url /hub/
node deploy/check.mjs --out out --dry-run
```

(In Git Bash, prefix the first command with `MSYS_NO_PATHCONV=1`, or it turns
`/hub/` into a Windows path; the pipeline refuses that.) The build runs the
no-game-content gate and fails without touching `out/` if anything forbidden
is in its inputs or output. `deploy/check.mjs` validates this folder's files
and the output, and `--dry-run` starts the asset server and hub locally on
127.0.0.1 with the compose settings.

Copy the repository (or just `deploy/` and `out/`) to the VPS, e.g. with
`rsync -a --delete out/ deploy/ vps:/srv/delivery/`.

## 3. Settings

```
cd deploy
cp .env.example .env      # then edit .env; it is git-ignored
```

| variable | meaning |
|---|---|
| `DOMAIN` | the public hostname |
| `ACME_EMAIL` | Let's Encrypt account e-mail (caddy profile) |
| `TUNNEL_TOKEN` | the tunnel's token (tunnel profile); a secret: only in `.env` |
| `OUT_DIR` | the pipeline output, relative to `deploy/` (default `../out`) |
| `ASSET_RATE_RPS`, `ASSET_RATE_BURST` | per-client request rate (token bucket) |
| `ASSET_TRUST_PROXY_HOPS` | `1` with Caddy alone, `2` with the tunnel (client, cloudflared) |
| `ASSET_CDN_BASE`, `ASSET_CDN_MODE` | serve objects from a CDN/bucket: `redirect` (302) or `proxy` |
| `ASSET_CORP` | `cross-origin` when the objects come from another origin |
| `HUB_MAX_PLAYERS` | room size |

## 4a. Start with Caddy (automatic TLS)

```
docker compose --profile caddy up -d
docker compose ps
docker compose logs -f caddy      # watch the certificate being issued
```

Then open `https://DOMAIN/` (the site) and `https://DOMAIN/demo/` (the test
title). Certificates live in the `caddy_data` volume.

## 4b. Or start with a Cloudflare Tunnel (no open ports)

1. In the Cloudflare dashboard: Zero Trust, Networks, Tunnels, create a
   tunnel ("cloudflared" connector). Copy its token into `TUNNEL_TOKEN` in
   `.env`.
2. Add a public hostname to the tunnel: `DOMAIN` -> service
   `http://caddy-tunnel:80`.
3. Set `ASSET_TRUST_PROXY_HOPS=2` in `.env`.
4. `docker compose --profile tunnel up -d`

TLS ends at Cloudflare; between Cloudflare and the VPS the tunnel is an
outbound, encrypted connection made by `cloudflared`. Cloudflare's own cache
should be told to respect origin headers (the default): objects are
`immutable`, the manifest is `no-cache`.

## 5. Updates

Run the pipeline again and copy `out/` over. The manifest changes; objects
are content-addressed, so unchanged files keep their URLs and players
download only what changed. The asset server re-reads `manifest.json` when
the file changes; no restart is needed. When the launcher's own files change,
`sw.js` changes and browsers install the new shell on their next visit.

For a CDN or bucket: upload `out/assets/objects/` first (with
`Cache-Control: public, max-age=31536000, immutable`, and
`Cross-Origin-Resource-Policy: cross-origin` if it is another origin), then
`manifest.json`, and set `ASSET_CDN_BASE`.

## 6. What the owner provides (nothing of this is in the repository)

- the domain, and its DNS (or the domain on Cloudflare for the tunnel);
- the VPS, with Docker, and SSH access to it;
- the Let's Encrypt e-mail;
- for the tunnel: the Cloudflare account, the tunnel and its token;
- for a CDN: the bucket/CDN, its base URL and upload credentials (used by
  your upload tool, never by these containers);
- image pins: check the current `node`, `caddy` and `cloudflared` releases
  and pin them by digest in `docker-compose.yml`.

## 7. Never

- No ATV 2 build (`atv2.wasm`), generated C, disc files, or anything derived
  from the game goes into `out/`, the asset folder, a bucket or a CDN. The
  pipeline cannot package them (it has no option for it and its gate fails
  the build), and the asset server refuses to start on a folder that holds
  them.
- `ASSET_TEST_HOOKS`, `HUB_TEST_HOOKS` and `ASSET_SKIP_SCAN` are for local
  tests only; `deploy/check.mjs` fails if the compose file sets them.
