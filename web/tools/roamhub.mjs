// roamhub.mjs -- the free-roam hub for Free Ride (src/roam.c, ROAM-RE.md):
// every player (native atv2_recomp.exe with RECOMP_ROAM=127.0.0.1:<port>, or the
// browser build with ?env=RECOMP_ROAM=127.0.0.1:<port>) opens one WebSocket here.
//
//   node web/tools/roamhub.mjs [--port 8850] [--delay ms] [--jitter ms] [--loss %]
//                              [--bundle ms] [--grace s] [--collide 0|1] [--ghost s]
//                              [--max-players N] [--max-rooms N] [--log file] [--quiet]
//
// 127.0.0.1 only (it refuses any other bind address and drops non-loopback
// peers). Built-in Node modules only. The room logic, the protocol and the
// input checks are web/roamhub-worker/protocol.mjs, shared with the
// Cloudflare Worker version of this hub (web/roamhub-worker/worker.js); the
// protocol is described there.
//
// Rooms: a hello names its room ("freeride" by default); up to --max-rooms
// rooms of --max-players players. --collide 1 turns collisions on for every
// room (the welcome tells the clients; a client can also ask with collide=1).
//
// Network simulation (like nfsu2-web's vlanhub.py), applied per record and
// per destination: --delay ms one way, --jitter ms (uniform +-), --loss percent.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { Room, PROTO, cleanRoom } from '../roamhub-worker/protocol.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('--port', 8850));
const HOST = opt('--host', '127.0.0.1');
const DELAY = Number(opt('--delay', 0)), JITTER = Number(opt('--jitter', 0)), LOSS = Number(opt('--loss', 0)) / 100;
const BUNDLE = Number(opt('--bundle', 16)), GRACE = Number(opt('--grace', 10)) * 1000;
const COLLIDE = Number(opt('--collide', 0)) === 1, GHOST = Number(opt('--ghost', 3));
const MAX_PLAYERS = Math.min(PROTO.maxPlayers, Number(opt('--max-players', PROTO.maxPlayers)));
const MAX_ROOMS = Number(opt('--max-rooms', PROTO.maxRooms));
const LOG = opt('--log', null), QUIET = argv.includes('--quiet');
if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.error('roamhub: binds 127.0.0.1 only');
  process.exit(2);
}
if (LOG) writeFileSync(LOG, '');
const t0 = Date.now();
function log(s) {
  const line = `[${((Date.now() - t0) / 1000).toFixed(3)}] ${s}`;
  if (!QUIET) console.log(line);
  if (LOG) appendFileSync(LOG, line + '\n');
}

// ---- WebSocket framing (RFC 6455, server side) --------------------------------
function frame(op, payload) {
  const n = payload.length;
  const h = n < 126 ? Buffer.from([0x80 | op, n]) :
    n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) :
      (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([h, payload]);
}

const rooms = new Map();          // name -> Room
function roomFor(name) {
  let r = rooms.get(name);
  if (r) return r;
  if (rooms.size >= MAX_ROOMS) return null;
  r = new Room(name, {
    maxPlayers: MAX_PLAYERS, graceMs: GRACE, collide: COLLIDE ? 1 : 0, ghost: GHOST,
    now: () => Date.now(), log,
    send: (conn, data) => conn.send(typeof data === 'string' ? 1 : 2, typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
    close: (conn, code, why) => conn.closeWith(code, why),
    route,
    onLeave: () => { if (!r.size) { rooms.delete(name); log(`room ${name} closed`); } },
  });
  rooms.set(name, r);
  log(`room ${name} opened (${rooms.size} room(s); collisions ${COLLIDE ? 'on' : 'off'})`);
  return r;
}

class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.room = null;
    this.rxBytes = 0; this.txBytes = 0; this.rxRec = 0; this.txRec = 0; this.txFrames = 0; this.dropped = 0;
    sock.setNoDelay(true);
    sock.on('data', (d) => { this.rxBytes += d.length; this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => this.onclose());
    sock.on('error', () => {});
  }
  get player() { return this.room?.playerOf(this) ?? null; }
  send(op, payload) {
    if (this.sock.destroyed) return;
    const f = frame(op, payload);
    this.txBytes += f.length; this.txFrames++;
    this.sock.write(f);
  }
  closeWith(code, why) {
    if (this.sock.destroyed) return;
    const b = Buffer.alloc(2 + Buffer.byteLength(why)); b.writeUInt16BE(code, 0); b.write(why, 2);
    this.send(8, b);
    this.sock.end();
    setTimeout(() => this.sock.destroy(), 200);
  }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 15, masked = b[1] & 128;
      let len = b[1] & 127, h = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); h = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); h = 10; }
      if (len > 1 << 16) { this.closeWith(1009, 'frame too big'); this.sock.destroy(); return; }
      const mh = masked ? 4 : 0;
      if (b.length < h + mh + len) return;
      const p = Buffer.from(b.subarray(h + mh, h + mh + len));
      if (masked) { const m = b.subarray(h, h + 4); for (let i = 0; i < len; i++) p[i] ^= m[i & 3]; }
      this.buf = b.subarray(h + mh + len);
      if (op === 1) this.ontext(p.toString('utf8'));
      else if (op === 2) this.onbinary(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
      else if (op === 8) { this.send(8, Buffer.alloc(0)); this.sock.end(); return; }
      else if (op === 9) this.send(10, p);
    }
  }
  ontext(s) {
    if (!this.room) {
      // The first message must be a hello; it picks the room.
      let m;
      try { m = s.length <= PROTO.maxText ? JSON.parse(s) : null; } catch { m = null; }
      if (!m || m.t !== 'hello') return;
      const name = cleanRoom(m.room ?? 'freeride');
      const room = name && roomFor(name);
      if (!room) {
        this.send(1, Buffer.from(JSON.stringify({ t: 'error', why: name ? 'too many rooms' : 'bad room name' })));
        this.closeWith(4002, 'no room');
        return;
      }
      this.room = room;
    }
    this.room.onText(this, s);
  }
  onbinary(p) {
    if (!this.room) return;
    const pl = this.room.onBinary(this, p);
    if (pl) this.rxRec = pl.recs;
  }
  onclose() {
    this.room?.onClose(this);
  }
}

// ---- forwarding with delay / jitter / loss, bundled per destination -------------
const due = [];                  // { at, dst, src, rec, room }
let simDropped = 0;
function route(src, dst, rec) {
  if (LOSS > 0 && Math.random() < LOSS) { simDropped++; dst.conn.dropped++; return; }
  const d = DELAY + (JITTER ? (Math.random() * 2 - 1) * JITTER : 0);
  if (d <= 0) dst.pending.push([src.id, rec]);
  else due.push({ at: performance.now() + d, dst, src: src.id, rec });
}

setInterval(() => {
  const now = performance.now();
  for (let i = 0; i < due.length;) {
    if (due[i].at <= now) { const e = due[i]; due[i] = due[due.length - 1]; due.pop(); if (e.dst.conn) e.dst.pending.push([e.src, e.rec]); }
    else i++;
  }
}, 1);

setInterval(() => {
  for (const r of rooms.values()) {
    for (const p of r.players.values()) if (p.conn && p.pending.length) p.conn.txRec += p.pending.length;
    r.flush();
  }
}, BUNDLE);

setInterval(() => { for (const r of [...rooms.values()]) r.expire(); }, 250);

// ---- stats ----------------------------------------------------------------------
let last = { t: Date.now() };
setInterval(() => {
  const dt = (Date.now() - last.t) / 1000;
  const lines = [];
  for (const r of rooms.values()) {
    for (const pl of r.players.values()) {
      const c = pl.conn, key = `${r.name}#${pl.id}`;
      if (!c) { lines.push(`${r.name} #${pl.id} ${pl.name}: (disconnected)`); continue; }
      const p = last[key] ?? { rx: 0, tx: 0, rr: 0, tr: 0, tf: 0, dr: 0 };
      lines.push(`${r.name} #${pl.id} ${pl.name} (${pl.client} v${pl.v}): in ${((pl.recs - p.rr) / dt).toFixed(1)} snap/s ${((c.rxBytes - p.rx) / dt / 1024).toFixed(2)} KB/s, ` +
        `out ${((c.txRec - p.tr) / dt).toFixed(1)} rec/s in ${((c.txFrames - p.tf) / dt).toFixed(1)} frames/s ${((c.txBytes - p.tx) / dt / 1024).toFixed(2)} KB/s, ` +
        `sim-dropped ${c.dropped - p.dr}, bad records ${pl.bad}, input dropped ${pl.dropped}`);
      last[key] = { rx: c.rxBytes, tx: c.txBytes, rr: pl.recs, tr: c.txRec, tf: c.txFrames, dr: c.dropped };
    }
  }
  last.t = Date.now();
  if (lines.length) log(`stats over ${dt.toFixed(0)} s: ${rooms.size} room(s), queued ${due.length}\n  ` + lines.join('\n  '));
}, 10000);

// ---- server -----------------------------------------------------------------------
const srv = createServer((req, res) => {
  // Test aid: GET /drop?id=N[&room=R] cuts player N's connection (as a network
  // drop would); the client reconnects and resumes with its token.
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/drop') {
    const r = rooms.get(cleanRoom(u.searchParams.get('room') ?? 'freeride') ?? '');
    const pl = r?.players.get(Number(u.searchParams.get('id')));
    if (pl?.conn) { log(`${r.name} #${pl.id} ${pl.name}: connection cut (/drop)`); pl.conn.sock.destroy(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: !!pl }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({
    hub: 'atv2 roam', v: PROTO.version, delay: DELAY, jitter: JITTER, loss: LOSS * 100, collide: COLLIDE,
    rooms: [...rooms.values()].map((r) => ({ name: r.name, stats: r.stats,
      players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, connected: !!p.conn, rider: p.look.rider, atv: p.look.atv, v: p.v, bad: p.bad })) })),
  }));
});
srv.on('upgrade', (req, sock) => {
  const ra = sock.remoteAddress ?? '';
  if (!(ra === '127.0.0.1' || ra === '::ffff:127.0.0.1' || ra === '::1')) { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  new Conn(sock);
});
srv.listen(PORT, '127.0.0.1', () => log(`roamhub v${PROTO.version} on ws://127.0.0.1:${PORT}/ (delay ${DELAY} ms, jitter +-${JITTER} ms, loss ${LOSS * 100}%, ` +
  `bundle ${BUNDLE} ms, resume grace ${GRACE / 1000} s, collisions ${COLLIDE ? 'on' : 'off'}, ghost ${GHOST} s, ${MAX_PLAYERS} players x ${MAX_ROOMS} rooms)`));
