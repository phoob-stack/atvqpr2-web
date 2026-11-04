# Free-roam hub as a Cloudflare Worker + Durable Object (parked)

Status: written and tested locally, **not deployed, and no longer the plan**:
the hub is hosted as `web/tools/roamhub.mjs` on the owner's Pterodactyl server
behind Cloudflare (see `web/tools/ROAMHUB-HOSTING.md`). Kept because
`protocol.mjs` here is the room logic and the input checks the Node hub uses.

Files:

- `protocol.mjs` -- the wire protocol (described at its top), the `Room` class
  (join / look / leave / resume tokens / grace / bundling / rate limits /
  caps), record and frame checks. Plain ES module, no Node or Workers APIs.
  **Used by the Node hub.**
- `worker.js` -- `fetch` routes `wss://<worker>/roam/<room>` to one Durable
  Object per room (`idFromName(room)`); `RoamRoom` accepts sockets with the
  WebSocket hibernation API, keeps each player on its socket attachment and
  players in their resume grace in storage with an alarm, bundles records with
  a 16 ms timer while busy. Origin allow-list (`ALLOWED_ORIGINS`), optional
  per-IP rate-limit binding (`RL`), `MAX_PLAYERS` per room.
- `wrangler.example.toml` -- placeholders only (no account id, no secrets).
- `test.mjs` -- `node web/roamhub-worker/test.mjs`: protocol, Room, the
  Durable Object with a mocked `ctx` (hibernation round trips, alarms), the
  Worker's entry checks, and the Node hub as a process (plain and hosted flags).

Deploying it would be `wrangler deploy` with a filled-in `wrangler.toml` on
the owner's account; never done here. Untested: the real Workers runtime
(hibernation timing, `WebSocketPair`, the 101 response, alarms), the
rate-limit binding, and Cloudflare's own limits.
