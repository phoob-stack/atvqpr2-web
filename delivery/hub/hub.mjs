// hub.mjs -- the free-roam hub. A copy of atvrecomp's web/tools/roamhub.mjs
// (same protocol, same room logic; MIT, this project's own code) with
// settings for running it behind a proxy. Players are opaque records to it:
// the delivery test title (web/app/hub.js) sends its own 18-byte snapshots.
//
//   node hub/hub.mjs [--port 8854] [--delay ms] [--jitter ms] [--loss %]
//                    [--bundle ms] [--grace s] [--log file] [--quiet]
//   env: HUB_PORT, HUB_HOST (127.0.0.1), HUB_ALLOW_REMOTE=1 (a non-loopback bind
//        and non-loopback peers: in a container behind Caddy/cloudflared only),
//        HUB_ORIGINS (comma list of allowed page origins; empty = any),
//        HUB_MAX_PLAYERS (64), HUB_TEST_HOOKS=1 (GET /drop?id=N, local tests)
//
// 127.0.0.1 by default (it refuses any other bind address and drops
// non-loopback peers unless HUB_ALLOW_REMOTE=1). Built-in Node modules only.
//
// Protocol
//   text frames, JSON (control, reliable):
//     client -> hub  {"t":"hello","v":1,"room":"freeride","name":"..","resume":"<token>|"}
//     hub -> client  {"t":"welcome","id":N,"resume":"<token>","resumed":0|1}
//                    {"t":"join","id":N,"name":".."}   (one per player already there, then for newcomers)
//                    {"t":"leave","id":N}
//   binary frames (state, unreliable when --loss is set):
//     [u8 type=1][u8 src][u8 dst][u8 count] then count x { [u8 src][u8 len][len bytes] }
//     A client sends one record (its own snapshot, src 0, dst 255). The hub stamps
//     the sender's id on it and forwards it to everyone else in the room, several
//     records bundled into one frame per destination every --bundle ms.
//   resume: a dropped connection keeps its id for --grace seconds; a hello with
//     the token it was given gets the same id back and the others see no leave/join.
//
// Network simulation (like nfsu2-web's vlanhub.py), applied per record and
// per destination: --delay ms one way, --jitter ms (uniform +-), --loss percent.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const env = process.env;
const PORT = Number(opt('--port', env.HUB_PORT ?? 8854));
const HOST = opt('--host', env.HUB_HOST ?? '127.0.0.1');
const ALLOW_REMOTE = env.HUB_ALLOW_REMOTE === '1';
const ORIGINS = String(env.HUB_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PLAYERS = Number(env.HUB_MAX_PLAYERS ?? 64);
const TEST_HOOKS = env.HUB_TEST_HOOKS === '1';
const DELAY = Number(opt('--delay', 0)), JITTER = Number(opt('--jitter', 0)), LOSS = Number(opt('--loss', 0)) / 100;
const BUNDLE = Number(opt('--bundle', 16)), GRACE = Number(opt('--grace', 10)) * 1000;
const LOG = opt('--log', null), QUIET = argv.includes('--quiet');
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !ALLOW_REMOTE) {
  console.error('hub: binds 127.0.0.1 only (HUB_ALLOW_REMOTE=1 for a container behind a proxy)');
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

class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.player = null;
    this.rxBytes = 0; this.txBytes = 0; this.rxRec = 0; this.txRec = 0; this.txFrames = 0; this.dropped = 0;
    sock.setNoDelay(true);
    sock.on('data', (d) => { this.rxBytes += d.length; this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => this.onclose());
    sock.on('error', () => {});
  }
  send(op, payload) {
    if (this.sock.destroyed) return;
    const f = frame(op, payload);
    this.txBytes += f.length; this.txFrames++;
    this.sock.write(f);
  }
  text(obj) { this.send(1, Buffer.from(JSON.stringify(obj))); }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 15, masked = b[1] & 128;
      let len = b[1] & 127, h = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); h = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); h = 10; }
      if (len > 1 << 20) { this.sock.destroy(); return; }
      const mh = masked ? 4 : 0;
      if (b.length < h + mh + len) return;
      const p = Buffer.from(b.subarray(h + mh, h + mh + len));
      if (masked) { const m = b.subarray(h, h + 4); for (let i = 0; i < len; i++) p[i] ^= m[i & 3]; }
      this.buf = b.subarray(h + mh + len);
      if (op === 1) this.ontext(p.toString('utf8'));
      else if (op === 2) this.onbinary(p);
      else if (op === 8) { this.send(8, Buffer.alloc(0)); this.sock.end(); return; }
      else if (op === 9) this.send(10, p);
    }
  }
  ontext(s) {
    let m;
    try { m = JSON.parse(s); } catch { return; }
    if (m.t === 'hello') hello(this, m);
    else if (m.t === 'name' && this.player) {
      this.player.name = clean(m.name); broadcast(this.player, { t: 'name', id: this.player.id, name: this.player.name });
    }
  }
  onbinary(p) {
    const pl = this.player;
    if (!pl || p.length < 4 || p[0] !== 1) return;
    let at = 4;
    for (let k = 0; k < p[3] && at + 2 <= p.length; k++) {
      const len = p[at + 1];
      if (at + 2 + len > p.length) break;
      const rec = p.subarray(at + 2, at + 2 + len);
      pl.recs++; this.rxRec++;
      for (const other of room.values()) if (other !== pl && other.conn) route(pl, other, rec);
      at += 2 + len;
    }
  }
  onclose() {
    const pl = this.player;
    if (!pl || pl.conn !== this) return;
    pl.conn = null;
    pl.lostAt = Date.now();
    log(`#${pl.id} ${pl.name}: connection closed; keeping the id ${GRACE / 1000} s for a resume`);
    pl.graceTimer = setTimeout(() => {
      room.delete(pl.id);
      log(`#${pl.id} ${pl.name} left (no resume)`);
      broadcast(pl, { t: 'leave', id: pl.id });
    }, GRACE);
  }
}

const clean = (s) => String(s ?? '').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').slice(0, 20) || 'PLAYER';

// ---- room ---------------------------------------------------------------------
const room = new Map();          // id -> player
const byToken = new Map();       // resume token -> player
let nextId = 1;

function hello(conn, m) {
  let pl = m.resume ? byToken.get(String(m.resume)) : null;
  if (pl && room.get(pl.id) === pl) {
    clearTimeout(pl.graceTimer);
    if (pl.conn && pl.conn !== conn) pl.conn.sock.destroy();
    pl.conn = conn; conn.player = pl;
    conn.text({ t: 'welcome', id: pl.id, resume: pl.token, resumed: 1 });
    for (const o of room.values()) if (o !== pl) conn.text({ t: 'join', id: o.id, name: o.name });
    log(`#${pl.id} ${pl.name}: resumed after ${pl.lostAt ? ((Date.now() - pl.lostAt) / 1000).toFixed(1) : 0} s (${m.client ?? '?'})`);
    return;
  }
  if (room.size >= MAX_PLAYERS) { conn.text({ t: 'full' }); conn.sock.end(); return; }
  let id = nextId;
  while (room.has(id)) id = id % 250 + 1;
  nextId = id % 250 + 1;
  pl = { id, name: clean(m.name), token: randomBytes(12).toString('hex'), conn, recs: 0, pending: [], client: m.client ?? '?' };
  conn.player = pl;
  room.set(id, pl);
  byToken.set(pl.token, pl);
  conn.text({ t: 'welcome', id, resume: pl.token, resumed: 0 });
  for (const o of room.values()) if (o !== pl) conn.text({ t: 'join', id: o.id, name: o.name });
  broadcast(pl, { t: 'join', id, name: pl.name });
  log(`#${id} ${pl.name} joined (${pl.client}, ${conn.sock.remoteAddress}:${conn.sock.remotePort}); ${room.size} in the room`);
}

function broadcast(from, obj) {
  for (const o of room.values()) if (o !== from && o.conn) o.conn.text(obj);
}

// ---- forwarding with delay / jitter / loss, bundled per destination -------------
const due = [];                  // { at, dst, src, rec }
let simDropped = 0, simSent = 0;
function route(src, dst, rec) {
  if (LOSS > 0 && Math.random() < LOSS) { simDropped++; dst.conn.dropped++; return; }
  const d = DELAY + (JITTER ? (Math.random() * 2 - 1) * JITTER : 0);
  if (d <= 0) dst.pending.push([src.id, rec]);
  else due.push({ at: performance.now() + d, dst, src: src.id, rec });
}

setInterval(() => {
  const now = performance.now();
  for (let i = 0; i < due.length;) {
    if (due[i].at <= now) { const e = due[i]; due[i] = due[due.length - 1]; due.pop(); if (room.get(e.dst.id) === e.dst) e.dst.pending.push([e.src, e.rec]); }
    else i++;
  }
}, 1);

setInterval(() => {
  for (const pl of room.values()) {
    if (!pl.pending.length || !pl.conn) { pl.pending.length = 0; continue; }
    while (pl.pending.length) {
      const batch = pl.pending.splice(0, 255);
      const parts = [Buffer.from([1, 0, pl.id, batch.length])];
      for (const [src, rec] of batch) { parts.push(Buffer.from([src, rec.length])); parts.push(rec); }
      pl.conn.send(2, Buffer.concat(parts));
      pl.conn.txRec += batch.length; simSent += batch.length;
    }
  }
}, BUNDLE);

// ---- stats ----------------------------------------------------------------------
let last = { t: Date.now() };
setInterval(() => {
  const dt = (Date.now() - last.t) / 1000;
  const lines = [];
  for (const pl of room.values()) {
    const c = pl.conn;
    if (!c) { lines.push(`#${pl.id} ${pl.name}: (disconnected)`); continue; }
    const p = last[pl.id] ?? { rx: 0, tx: 0, rr: 0, tr: 0, tf: 0, dr: 0 };
    lines.push(`#${pl.id} ${pl.name} (${pl.client}): in ${((c.rxRec - p.rr) / dt).toFixed(1)} snap/s ${((c.rxBytes - p.rx) / dt / 1024).toFixed(2)} KB/s, ` +
      `out ${((c.txRec - p.tr) / dt).toFixed(1)} rec/s in ${((c.txFrames - p.tf) / dt).toFixed(1)} frames/s ${((c.txBytes - p.tx) / dt / 1024).toFixed(2)} KB/s, dropped ${c.dropped - p.dr}`);
    last[pl.id] = { rx: c.rxBytes, tx: c.txBytes, rr: c.rxRec, tr: c.txRec, tf: c.txFrames, dr: c.dropped };
  }
  last.t = Date.now();
  if (lines.length) log(`stats over ${dt.toFixed(0)} s: ${room.size} player(s), queued ${due.length}\n  ` + lines.join('\n  '));
}, 10000);

// ---- server -----------------------------------------------------------------------
const srv = createServer((req, res) => {
  // Test aid: GET /drop?id=N cuts player N's connection (as a network drop would);
  // the client reconnects and resumes with its token.
  const u = new URL(req.url, 'http://127.0.0.1');
  if (TEST_HOOKS && u.pathname === '/drop') {
    const pl = room.get(Number(u.searchParams.get('id')));
    if (pl?.conn) { log(`#${pl.id} ${pl.name}: connection cut (/drop)`); pl.conn.sock.destroy(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: !!pl }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ hub: 'atv2 roam', players: [...room.values()].map((p) => ({ id: p.id, name: p.name, connected: !!p.conn })),
    delay: DELAY, jitter: JITTER, loss: LOSS * 100 }));
});
srv.on('upgrade', (req, sock) => {
  const ra = sock.remoteAddress ?? '';
  if (!ALLOW_REMOTE && !(ra === '127.0.0.1' || ra === '::ffff:127.0.0.1' || ra === '::1')) { sock.destroy(); return; }
  if (ORIGINS.length && !ORIGINS.includes(String(req.headers.origin ?? ''))) { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  new Conn(sock);
});
const shutdown = () => { srv.close(); for (const pl of room.values()) pl.conn?.sock.destroy(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
srv.listen(PORT, HOST === 'localhost' ? '127.0.0.1' : HOST, () => log(`hub on ws://127.0.0.1:${PORT}/ (delay ${DELAY} ms, jitter +-${JITTER} ms, loss ${LOSS * 100}%, bundle ${BUNDLE} ms, resume grace ${GRACE / 1000} s)`));
