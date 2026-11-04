// worker.js -- the free-roam hub as a Cloudflare Worker + Durable Object.
// Written to be deployable, NOT deployed: see README.md. Same protocol and the
// same room logic as the Node hub (web/tools/roamhub.mjs), both from
// protocol.mjs.
//
//   wss://<your worker>/roam/<room>     (room: [A-Za-z0-9_-]{1,24}, default "freeride")
//
// One Durable Object per room (idFromName(room)). It accepts the players'
// WebSockets with the hibernation API, so an idle room costs nothing: each
// socket carries its player (serializeAttachment), players in their resume
// grace are kept in the object's storage with an alarm for the end of the
// grace, and both are read back when the object wakes. While a room is busy a
// short timer bundles the records (16 ms) -- the same bundling as the Node hub.
//
// Limits: per-player message and record rates and frame sizes (protocol.mjs),
// players per room (MAX_PLAYERS, at most 8), an optional rate limit per IP on
// new connections (a Workers rate-limiting binding, RL), an optional origin
// allow-list (ALLOWED_ORIGINS). Records are checked (NaN / out of range) before
// they are forwarded. The hub carries player state only: names, rider / ATV
// choices, poses.
import { Room, PROTO, cleanRoom } from './protocol.mjs';

const BUNDLE_MS = 16;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/roam(?:\/([^/]*))?\/?$/);
    if (!m) return new Response('atv2 roam hub: connect a WebSocket to /roam/<room>\n', { status: 404 });
    const room = cleanRoom(m[1] || 'freeride');
    if (!room) return new Response('bad room name\n', { status: 400 });
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket')
      return new Response('expected a WebSocket upgrade\n', { status: 426 });
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin');
    if (allowed.length && origin && !allowed.includes(origin))
      return new Response('origin not allowed\n', { status: 403 });
    if (env.RL) {        // optional: [[unsafe.bindings]] type = "ratelimit" (see wrangler.example.toml)
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return new Response('too many connections\n', { status: 429 });
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    const fwd = new Request(request);
    fwd.headers.set('X-Roam-Room', room);
    return stub.fetch(fwd);
  },
};

export class RoamRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.flushTimer = null;
  }

  // The room, rebuilt from the sockets and storage after a hibernation.
  async ensureRoom(name) {
    if (this.room) return this.room;
    const env = this.env;
    const room = new Room(name ?? (await this.ctx.storage.get('name')) ?? 'freeride', {
      maxPlayers: Math.min(PROTO.maxPlayers, Number(env.MAX_PLAYERS ?? PROTO.maxPlayers)),
      graceMs: Number(env.GRACE_S ?? 10) * 1000,
      collide: Number(env.COLLIDE ?? 0) === 1 ? 1 : 0,
      ghost: Number(env.GHOST_S ?? 3),
      now: () => Date.now(),
      log: (s) => { if (env.LOG === '1') console.log(s); },
      send: (ws, data) => { try { ws.send(data); } catch { /* closed */ } },
      close: (ws, code, why) => { try { ws.close(code, why); } catch { /* closed */ } },
      onChange: (p) => this.save(p),
      onLeave: (p) => { this.ctx.storage.delete(`p:${p.id}`); },
    });
    this.room = room;
    // players on live sockets
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.id) room.restore(a, ws);
    }
    // players in their resume grace
    const saved = await this.ctx.storage.list({ prefix: 'p:' });
    for (const [, a] of saved) if (!room.players.has(a.id)) room.restore(a, null);
    if (name) await this.ctx.storage.put('name', name);
    return room;
  }

  save(p) {
    const a = this.room.persistent(p);
    if (p.conn) { try { p.conn.serializeAttachment(a); } catch { /* closed */ } }
    this.ctx.storage.put(`p:${p.id}`, a);
  }

  async fetch(request) {
    const room = await this.ensureRoom(request.headers.get('X-Roam-Room'));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    if (room.connected() >= room.opt.maxPlayers + 2) {      // a burst of strangers: refuse at the door
      server.close(4001, 'room full');
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const room = await this.ensureRoom();
    if (typeof message === 'string') room.onText(ws, message);
    else room.onBinary(ws, new Uint8Array(message));
    if (!this.flushTimer && room.hasPending())
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.room?.flush(); }, BUNDLE_MS);
  }

  async webSocketClose(ws) {
    const room = await this.ensureRoom();
    const p = room.onClose(ws);
    if (p) await this.armAlarm();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async armAlarm() {
    const next = this.room.expire();
    if (next) await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    await this.ensureRoom();
    await this.armAlarm();
  }
}
