// protocol.mjs -- the free-roam hub's room logic and input checks, shared by
// the Node hub (web/tools/roamhub.mjs) and the Cloudflare Worker + Durable
// Object hub (web/roamhub-worker/worker.js). Plain ES module: Uint8Array,
// DataView, TextEncoder, crypto.getRandomValues -- no Node or Workers APIs.
//
// Wire protocol (src/roam.c is the client; web/host/roam.js its browser transport)
//
//   text frames, JSON (control, reliable):
//     client -> hub  {"t":"hello","v":2,"room":"freeride","name":"..","resume":"<token>|",
//                     "client":"native|wasm","snap":2,"rider":R,"atv":A,"skin":-1,"collide":0|1}
//                    {"t":"look","rider":R,"atv":A,"skin":-1}      (the player's rider / ATV changed)
//                    {"t":"name","name":".."}
//     hub -> client  {"t":"welcome","v":2,"id":N,"resume":"<token>","resumed":0|1,"room":"..",
//                     "collide":0|1,"ghost":S,"max":M}
//                    {"t":"join","id":N,"name":"..","rider":R,"atv":A,"skin":S,"v":V,"client":".."}
//                    {"t":"look","id":N,"rider":R,"atv":A,"skin":S}
//                    {"t":"name","id":N,"name":".."}
//                    {"t":"leave","id":N}
//                    {"t":"error","why":".."}                       (then the hub closes)
//     A v1 client (no rider / atv) gets the same messages and ignores what it
//     does not know; its records are 52 bytes.
//
//   binary frames (state, unreliable when the Node hub simulates loss):
//     [u8 type=1][u8 src][u8 dst][u8 count] then count x { [u8 src][u8 len][len bytes] }
//     A client sends its own snapshot (src 0, dst 255, count 1). The hub checks
//     it, stamps the sender's id and forwards it to everyone else in the room,
//     several records bundled into one frame per destination.
//
//   snapshot record (little endian; src/roam.c snap_encode):
//     v1 (52): u32 seq, u32 t_ms, f32 pos[3], i16 quat[4], f32 vel[3], i16 avel[3],
//              i8 throttle, steer, brake, lean, u8 version (0 in v1), u8 flags
//     v2 (68): + u16 rpm, u8 thr, u8 load, u8 x2b0, u8 x2a8, u8 x2bc, u8 rider state,
//              i8 trick, u8 trick seq, u8 phase, u8 trick flags, u16 anim, u16 trick ms
//
// Only player state goes through: names, rider / ATV choices, poses. The hub
// never carries anything from the game's files.

export const PROTO = {
  version: 2,
  recV1: 52,
  recV2: 68,
  recMax: 128,           // a record longer than this is not ours
  maxText: 1024,         // client -> hub text frame
  maxBinary: 1024,       // client -> hub binary frame (one record is 74 bytes)
  maxRecsPerFrame: 4,
  maxPlayers: 8,         // the local rider + 7 rider slots (src/roam.c RT_MAX)
  maxRooms: 64,          // Node hub; the Worker has one Durable Object per room
  posLimit: 20000,       // m
  velLimit: 200,         // m/s
  rpmLimit: 30000,
  trickMax: 0x1d,
  nRiders: 24,
  nAtvs: 11,
  textRate: 10, textBurst: 20,      // per player, messages/s
  recRate: 45, recBurst: 30,        // per player, records/s (clients send 30)
  abuseLimit: 300,                  // dropped inputs before the hub closes a connection
};

const ROOM_RE = /^[A-Za-z0-9_-]{1,24}$/;
export const cleanRoom = (s) => (typeof s === 'string' && ROOM_RE.test(s) ? s : null);
export const cleanName = (s) =>
  String(s ?? '').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').slice(0, 20) || 'PLAYER';
const intIn = (v, lo, hi, def) => (Number.isInteger(v) && v >= lo && v <= hi ? v : def);

export function cleanLook(m) {
  return {
    rider: intIn(m?.rider, 0, PROTO.nRiders - 1, -1),
    atv: intIn(m?.atv, 0, PROTO.nAtvs - 1, -1),
    skin: intIn(m?.skin, -1, 255, -1),
  };
}

export function newToken() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// A record from a client: null if it is sane, else why not.
export function checkRecord(rec) {
  if (!(rec instanceof Uint8Array)) return 'type';
  if (rec.length < PROTO.recV1 || rec.length > PROTO.recMax) return 'length';
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  for (let i = 0; i < 3; i++) {
    const p = dv.getFloat32(8 + 4 * i, true);
    if (!Number.isFinite(p) || Math.abs(p) >= PROTO.posLimit) return 'position';
    const v = dv.getFloat32(28 + 4 * i, true);
    if (!Number.isFinite(v) || Math.abs(v) >= PROTO.velLimit) return 'velocity';
  }
  let n = 0;
  for (let i = 0; i < 4; i++) { const q = dv.getInt16(20 + 2 * i, true) / 32767; n += q * q; }
  if (n < 0.25) return 'rotation';
  if (rec.length >= PROTO.recV2 && rec[50] >= 2) {
    if (dv.getUint16(52, true) >= PROTO.rpmLimit) return 'rpm';
    const t = dv.getInt8(60);
    if (t < -1 || t > PROTO.trickMax) return 'trick';
  }
  return null;
}

// A client's binary frame -> its records, or { error }.
export function parseClientFrame(buf) {
  if (!(buf instanceof Uint8Array)) return { error: 'type' };
  if (buf.length > PROTO.maxBinary) return { error: 'frame too big' };
  if (buf.length < 4 || buf[0] !== 1) return { error: 'not a bundle' };
  const count = buf[3], recs = [];
  if (count > PROTO.maxRecsPerFrame) return { error: 'too many records' };
  let at = 4;
  for (let k = 0; k < count; k++) {
    if (at + 2 > buf.length) return { error: 'truncated' };
    const len = buf[at + 1];
    if (at + 2 + len > buf.length) return { error: 'truncated' };
    recs.push(buf.slice(at + 2, at + 2 + len));
    at += 2 + len;
  }
  return { recs };
}

// One frame to player dst: [[src, rec], ...] (at most 255 records).
export function buildBundle(dst, list) {
  let n = 4;
  for (const [, rec] of list) n += 2 + rec.length;
  const out = new Uint8Array(n);
  out[0] = 1; out[1] = 0; out[2] = dst; out[3] = list.length;
  let at = 4;
  for (const [src, rec] of list) { out[at] = src; out[at + 1] = rec.length; out.set(rec, at + 2); at += 2 + rec.length; }
  return out;
}

export class TokenBucket {
  constructor(rate, burst, now) { this.rate = rate; this.burst = burst; this.tokens = burst; this.t = now; }
  take(now, n = 1) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.t) / 1000) * this.rate);
    this.t = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

// One room. The transport gives it:
//   send(conn, data)      data: string (JSON text frame) or Uint8Array (binary)
//   close(conn, code, why)
//   now()                 ms
//   log(line)
//   route(src, dst, rec)  optional: the Node hub's delay / jitter / loss; default: queue for the next flush
//   onChange(player)      optional: a player's persistent fields changed (the Worker saves them)
export class Room {
  constructor(name, opt) {
    this.name = name;
    this.opt = {
      maxPlayers: PROTO.maxPlayers, graceMs: 10000, collide: 0, ghost: 3,
      now: () => Date.now(), log: () => {}, send: () => {}, close: () => {}, ...opt,
    };
    this.players = new Map();      // id -> player
    this.byToken = new Map();      // token -> player
    this.byConn = new Map();       // conn -> player
    this.nextId = 1;
    this.stats = { badRecords: 0, badFrames: 0, rateDropped: 0, refused: 0 };
  }

  get size() { return this.players.size; }
  connected() { let n = 0; for (const p of this.players.values()) if (p.conn) n++; return n; }
  playerOf(conn) { return this.byConn.get(conn) ?? null; }

  text(conn, obj) { this.opt.send(conn, JSON.stringify(obj)); }
  broadcast(from, obj) { const s = JSON.stringify(obj); for (const p of this.players.values()) if (p !== from && p.conn) this.opt.send(p.conn, s); }
  joinMsg(p) { return { t: 'join', id: p.id, name: p.name, rider: p.look.rider, atv: p.look.atv, skin: p.look.skin, v: p.v, client: p.client }; }
  persistent(p) { return { id: p.id, name: p.name, token: p.token, look: p.look, client: p.client, v: p.v, lostAt: p.lostAt ?? 0 }; }

  // Rebuild a player after the transport restarted (Worker hibernation): conn may be null (in its grace).
  restore(saved, conn) {
    const p = { ...saved, conn: conn ?? null, pending: [], recs: 0, bad: 0, dropped: 0 };
    const now = this.opt.now();
    p.textRl = new TokenBucket(PROTO.textRate, PROTO.textBurst, now);
    p.recRl = new TokenBucket(PROTO.recRate, PROTO.recBurst, now);
    this.players.set(p.id, p);
    this.byToken.set(p.token, p);
    if (conn) this.byConn.set(conn, p);
    if (p.id >= this.nextId) this.nextId = p.id % 250 + 1;
    return p;
  }

  hello(conn, m) {
    const now = this.opt.now();
    let p = typeof m.resume === 'string' && m.resume ? this.byToken.get(m.resume) : null;
    if (p && this.players.get(p.id) === p) {
      if (p.conn && p.conn !== conn) { this.byConn.delete(p.conn); this.opt.close(p.conn, 4000, 'resumed elsewhere'); }
      p.conn = conn; this.byConn.set(conn, p);
      const lost = p.lostAt ? ((now - p.lostAt) / 1000).toFixed(1) : '0';
      p.lostAt = 0;
      const look = cleanLook(m);
      if (look.rider >= 0 && look.atv >= 0) p.look = look;
      this.text(conn, this.welcome(p, 1));
      for (const o of this.players.values()) if (o !== p) this.text(conn, this.joinMsg(o));
      this.opt.log(`${this.name} #${p.id} ${p.name}: resumed after ${lost} s (${p.client})`);
      this.opt.onChange?.(p);
      return p;
    }
    if (this.players.size >= this.opt.maxPlayers) {
      this.stats.refused++;
      this.text(conn, { t: 'error', why: `room ${this.name} is full (${this.opt.maxPlayers} players)` });
      this.opt.close(conn, 4001, 'room full');
      return null;
    }
    let id = this.nextId;
    while (this.players.has(id)) id = id % 250 + 1;
    this.nextId = id % 250 + 1;
    p = {
      id, name: cleanName(m.name), token: newToken(), conn, look: cleanLook(m),
      client: String(m.client ?? '?').replace(/[^a-z0-9]/gi, '').slice(0, 12) || '?',
      v: intIn(m.v, 1, 99, 1), pending: [], recs: 0, bad: 0, dropped: 0, lostAt: 0,
      textRl: new TokenBucket(PROTO.textRate, PROTO.textBurst, now),
      recRl: new TokenBucket(PROTO.recRate, PROTO.recBurst, now),
    };
    this.players.set(id, p);
    this.byToken.set(p.token, p);
    this.byConn.set(conn, p);
    this.text(conn, this.welcome(p, 0));
    for (const o of this.players.values()) if (o !== p) this.text(conn, this.joinMsg(o));
    this.broadcast(p, this.joinMsg(p));
    this.opt.log(`${this.name} #${id} ${p.name} joined (${p.client}, v${p.v}, rider ${p.look.rider}, ATV ${p.look.atv}); ${this.players.size} in the room`);
    this.opt.onChange?.(p);
    return p;
  }

  welcome(p, resumed) {
    return { t: 'welcome', v: PROTO.version, id: p.id, resume: p.token, resumed, room: this.name,
      collide: this.opt.collide ? 1 : 0, ghost: this.opt.ghost, max: this.opt.maxPlayers };
  }

  abuse(conn, p, why) {
    p.dropped++;
    if (p.dropped === PROTO.abuseLimit) {
      this.opt.log(`${this.name} #${p.id} ${p.name}: closed (${why}, ${p.dropped} inputs dropped)`);
      this.opt.close(conn, 4008, 'too much bad input');
    }
  }

  // A text frame from conn. Returns the player or null.
  onText(conn, s) {
    const p = this.playerOf(conn);
    if (typeof s !== 'string' || s.length > PROTO.maxText) {
      this.stats.badFrames++;
      if (p) this.abuse(conn, p, 'text frame too big'); else this.opt.close(conn, 1009, 'frame too big');
      return null;
    }
    if (p && !p.textRl.take(this.opt.now())) { this.stats.rateDropped++; this.abuse(conn, p, 'text rate'); return p; }
    let m;
    try { m = JSON.parse(s); } catch { this.stats.badFrames++; if (p) this.abuse(conn, p, 'bad JSON'); return p; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return p;
    if (m.t === 'hello') {
      if (p) return p;                         // one hello per connection
      return this.hello(conn, m);
    }
    if (!p) return null;
    if (m.t === 'look') {
      const look = cleanLook(m);
      if (look.rider < 0 || look.atv < 0) return p;
      if (look.rider === p.look.rider && look.atv === p.look.atv && look.skin === p.look.skin) return p;
      p.look = look;
      this.broadcast(p, { t: 'look', id: p.id, ...look });
      this.opt.log(`${this.name} #${p.id} ${p.name}: rider ${look.rider}, ATV ${look.atv}`);
      this.opt.onChange?.(p);
    } else if (m.t === 'name') {
      p.name = cleanName(m.name);
      this.broadcast(p, { t: 'name', id: p.id, name: p.name });
      this.opt.onChange?.(p);
    }
    return p;
  }

  // A binary frame from conn: its records checked, stamped and routed.
  onBinary(conn, buf) {
    const p = this.playerOf(conn);
    if (!p) return null;
    const f = parseClientFrame(buf);
    if (f.error) { this.stats.badFrames++; this.abuse(conn, p, f.error); return p; }
    const now = this.opt.now();
    for (const rec of f.recs) {
      if (!p.recRl.take(now)) { this.stats.rateDropped++; this.abuse(conn, p, 'record rate'); continue; }
      const why = checkRecord(rec);
      if (why) {
        p.bad++; this.stats.badRecords++;
        if (p.bad <= 3) this.opt.log(`${this.name} #${p.id} ${p.name}: record dropped (${why})`);
        this.abuse(conn, p, 'bad records');
        continue;
      }
      p.recs++;
      for (const o of this.players.values())
        if (o !== p && o.conn) (this.opt.route ? this.opt.route(p, o, rec) : o.pending.push([p.id, rec]));
    }
    return p;
  }

  // The connection is gone: the player keeps its id for graceMs.
  onClose(conn) {
    const p = this.playerOf(conn);
    this.byConn.delete(conn);
    if (!p || p.conn !== conn) return null;
    p.conn = null;
    p.pending.length = 0;
    p.lostAt = this.opt.now();
    this.opt.log(`${this.name} #${p.id} ${p.name}: connection closed; keeping the id ${this.opt.graceMs / 1000} s for a resume`);
    this.opt.onChange?.(p);
    return p;
  }

  // Players whose grace ran out leave. Returns when the next one runs out (ms) or 0.
  expire() {
    const now = this.opt.now();
    let next = 0;
    for (const p of [...this.players.values()]) {
      if (p.conn || !p.lostAt) continue;
      const end = p.lostAt + this.opt.graceMs;
      if (end <= now) {
        this.players.delete(p.id);
        this.byToken.delete(p.token);
        this.opt.log(`${this.name} #${p.id} ${p.name} left (no resume)`);
        this.broadcast(p, { t: 'leave', id: p.id });
        this.opt.onLeave?.(p);
      } else if (!next || end < next) next = end;
    }
    return next;
  }

  // Bundle what is queued: one frame per destination. Returns the frames sent.
  flush() {
    let frames = 0;
    for (const p of this.players.values()) {
      if (!p.pending.length) continue;
      if (!p.conn) { p.pending.length = 0; continue; }
      while (p.pending.length) {
        const batch = p.pending.splice(0, 255);
        this.opt.send(p.conn, buildBundle(p.id, batch));
        p.txRecs = (p.txRecs ?? 0) + batch.length;
        frames++;
      }
    }
    return frames;
  }

  hasPending() { for (const p of this.players.values()) if (p.pending.length) return true; return false; }
}
