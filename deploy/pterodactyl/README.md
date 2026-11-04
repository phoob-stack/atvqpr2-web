# ATV 2 free-roam hub on Pterodactyl

The hub is two Node.js files from atvrecomp (`web/tools/roamhub.mjs` and `web/roamhub-worker/protocol.mjs`), packed in `atv2-roamhub.zip`.
It uses only Node's built-in modules, so there is no `npm install`. It relays
player names, rider choices and poses between players. It holds nothing from
the game and never needs any game file.

Players reach it as `wss://hub.atvqpr2.com/`. Cloudflare terminates TLS and
forwards plain WebSocket traffic to the server's allocated port. Never put a
panel password, API key or token in chat or in this folder.

## 1. Import the egg (panel admin)

1. In the panel, go to Admin → Nests. Create a nest, for example "ATV 2", or
   use an existing one.
2. Choose Import Egg, pick `egg-atv2-roamhub.json`, and select that nest.
3. The egg uses the `ghcr.io/parkervcp/yolks:nodejs_22` image (Node 22). Its
   install script downloads nothing; it only creates the server folder.

## 2. Create the server

1. Go to Admin → Servers → Create New.
   - Nest/Egg: ATV 2 / ATV 2 Free Roam Hub.
   - Resources: 1 CPU core, 256 MB RAM and 1 GB disk are plenty. Each player
     uses about 2 KB/s.
   - Allocation: pick a free port on the server's public IP and note it. In
     the steps below it is called `PORT`, for example 25570.
   - Variables: keep the defaults:
     - Allowed origins: `https://atvqpr2.com,https://www.atvqpr2.com`
     - Max players: 32
     - Max rooms: 8
     - Max connections per IP: 4
     - Idle timeout: 120
     - Allow the Windows game: 0. Set it to 1 later if Windows players should
       join too.
2. Open the server, go to File Manager, and upload `atv2-roamhub.zip` from
   this folder into the root folder. Then choose Unarchive on it. That
   creates `web/tools/roamhub.mjs` and `web/roamhub-worker/protocol.mjs`; the
   hub needs both, at those paths. SFTP works too.
3. Start the server. The console shows a line beginning `roamhub on`, and the
   panel marks the server as running.

## 3. Cloudflare: hub.atvqpr2.com (dashboard)

All of this is in dash.cloudflare.com, under the atvqpr2.com zone.

1. **DNS → Records → Add record**
   - Type `A`, Name `hub`, IPv4 = the server's public IP (the allocation's IP).
   - Proxy status: **Proxied** (orange cloud). Save.
2. **Rules → Origin Rules → Create rule**
   - Name: `hub port`.
   - If incoming requests match: Hostname equals `hub.atvqpr2.com`.
   - Destination Port → Rewrite to `PORT`, your allocation port. Deploy.
3. **SSL for this host only: Rules → Configuration Rules → Create rule**
   - Name: `hub flexible`.
   - If incoming requests match: Hostname equals `hub.atvqpr2.com`.
   - SSL → **Flexible**. Deploy.

   Browsers connect to Cloudflare over TLS (wss). Cloudflare connects to the
   hub over plain ws, because the hub has no certificate. The rest of the site
   keeps its current SSL mode.

   Alternative: Full (strict) with a Cloudflare Origin Certificate installed on
   the server's nginx in front of the hub. Ask for that config if you prefer
   it.
4. **Network**: WebSockets must be **On**. It is on by default.
5. Optional, to keep the port hidden: only allow Cloudflare's IP ranges to
   reach `PORT` (host firewall), so nobody connects to the hub bypassing
   Cloudflare. The hub also refuses pages from other websites (Allowed
   origins).

## 4. Check it

- `https://hub.atvqpr2.com/` in a browser should answer with a short status
  line (not a Cloudflare error page).
- The hub's console should show `#1 ... joined` when a player connects.
- Tell Claude when it answers. The website then gets the hub address and its
  security policy (`connect-src wss://hub.atvqpr2.com`) and is redeployed.

## Updating

Upload the new `roamhub.mjs` over the old one and restart the server.
Players' resume tokens survive a restart only for the grace period, about 10
seconds, so a restart briefly drops riders.
