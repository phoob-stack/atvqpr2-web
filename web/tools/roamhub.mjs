// roamhub.mjs -- the free-roam hub for Free Ride (src/roam.c, ROAM-RE.md):
// every player (native atv2_recomp.exe with RECOMP_ROAM=<hub>, or the browser
// build with ?roam=<hub> / ?env=RECOMP_ROAM=<hub>) opens one WebSocket here.
// Node built-ins only (no npm install); web/roamhub-worker/protocol.mjs beside
// it holds the room logic, the protocol and the input checks (copy both).
//
//   node roamhub.mjs [--port 8850] [--bind 127.0.0.1] [--trust-proxy cf]
//        [--origins https://a,https://b] [--allow-no-origin 0|1]
//        [--max-players N] [--max-rooms N] [--room-players N] [--max-conns-per-ip N]
//        [--idle-timeout s] [--grace s] [--collide 0|1] [--ghost s]
//        [--delay ms] [--jitter ms] [--loss %] [--bundle ms] [--log file] [--quiet]
//
// Binding: 127.0.0.1 unless --bind says otherwise (a warning is logged for any
// other address). Hosted (deploy\pterodactyl's egg), behind Cloudflare
// (hub.atvqpr2.com, orange cloud, SSL Flexible: browsers use wss://, the hub
// gets plain ws):
//   node roamhub.mjs --port <SERVER_PORT> --bind 0.0.0.0 --trust-proxy cf
//        --origins https://atvqpr2.com,https://www.atvqpr2.com --max-players 32
//        --max-rooms 8 --max-conns-per-ip 4 --idle-timeout 120 --allow-no-origin 0|1
//
// Limits (a refused upgrade gets an HTTP status; a refused hello an error
// message, then a close): the Origin header must be in --origins (a missing
// Origin -- the native game sends none -- only with --allow-no-origin 1; on a
// loopback bind without --origins any origin and none are accepted, for local
// tests; a public bind without --origins allows https://atvqpr2.com and
// https://www.atvqpr2.com); connections per IP (--trust-proxy cf: the
// CF-Connecting-IP header, else the socket's peer; forwarding headers are
// ignored without the flag); players in all rooms together (--max-players),
// rooms (--max-rooms), riders per room (8, the game's limit); a hello within
// 10 s; nothing received for --idle-timeout s closes the connection (clients
// send a keepalive every 10 s); frame sizes, message and record rates and
// every record's floats (protocol.mjs). The hub relays player state only --
// names, rider / ATV choices, poses -- never anything from the game.
//
// GET / (no upgrade): "atv2 roamhub v2: N players, M rooms" (text/plain, no
// names or addresses). GET /status.json: the same counts as JSON for the
// project site's status line (CORS for the allowed origins only); loopback
// binds serve a detailed /status.json instead, and the /drop test aid.
//
// Rooms: a hello names its room (else the URL path /room/<name>, else
// "freeride"). --collide 1 turns collisions on for every room.
//
// Network simulation for tests (like nfsu2-web's vlanhub.py), per record and
// destination: --delay ms one way, --jitter ms (uniform +-), --loss percent.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { Room, PROTO, cleanRoom } from '../roamhub-worker/protocol.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag01 = (k) => { const i = argv.indexOf(k); if (i < 0) return false; const v = argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v === '1' || v === 'true'; };
const PORT = Number(opt('--port', 8850));
const BIND = opt('--bind', opt('--host', '127.0.0.1'));
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(BIND);
const TRUST = opt('--trust-proxy', '');
const ORIGINS = (opt('--origins', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const ALLOW_NO_ORIGIN = flag01('--allow-no-origin');
const DELAY = Number(opt('--delay', 0)), JITTER = Number(opt('--jitter', 0)), LOSS = Number(opt('--loss', 0)) / 100;
const BUNDLE = Number(opt('--bundle', 16)), GRACE = Number(opt('--grace', 10)) * 1000;
const COLLIDE = Number(opt('--collide', 0)) === 1, GHOST = Number(opt('--ghost', 3));
const ROOM_PLAYERS = Math.min(PROTO.maxPlayers, Number(opt('--room-players', PROTO.maxPlayers)));
const MAX_PLAYERS = Number(opt('--max-players', 64));          // all rooms together
const MAX_ROOMS = Number(opt('--max-rooms', PROTO.maxRooms));
const MAX_PER_IP = Number(opt('--max-conns-per-ip', LOOPBACK ? 64 : 4));
const IDLE_MS = Number(opt('--idle-timeout', 120)) * 1000;
const LOG = opt('--log', null), QUIET = argv.includes('--quiet');
for (const [k, v] of [['--port', PORT], ['--max-players', MAX_PLAYERS], ['--max-rooms', MAX_ROOMS], ['--max-conns-per-ip', MAX_PER_IP], ['--idle-timeout', IDLE_MS]])
  if (!Number.isFinite(v) || v <= 0) { console.error(`roamhub: bad ${k}`); process.exit(2); }
if (TRUST && TRUST !== 'cf') { console.error('roamhub: --trust-proxy knows only "cf" (CF-Connecting-IP)'); process.exit(2); }
for (const o of ORIGINS) if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o)) { console.error(`roamhub: bad origin ${o}`); process.exit(2); }
if (LOG) writeFileSync(LOG, '');
const t0 = Date.now();
function log(s) {
  const line = `[${((Date.now() - t0) / 1000).toFixed(3)}] ${s}`;
  if (!QUIET) console.log(line);
  if (LOG) appendFileSync(LOG, line + '\n');
}
// Origins: the listed ones; a public bind without --origins: the site's own.
const ORIGIN_LIST = ORIGINS.length ? ORIGINS : LOOPBACK ? null : ['https://atvqpr2.com', 'https://www.atvqpr2.com'];
if (!LOOPBACK) {
  const w = `WARNING: bound to ${BIND}: reachable beyond this machine (origins ${ORIGIN_LIST.join(' ')}${ALLOW_NO_ORIGIN ? ' + none' : ''})`;
  console.warn(`roamhub: ${w}`);
  if (LOG) appendFileSync(LOG, w + '\n');
}
function originOk(o) {
  if (!o) return ALLOW_NO_ORIGIN || !ORIGIN_LIST;
  return !ORIGIN_LIST || ORIGIN_LIST.includes(o);
}
function clientIp(req, sock) {
  if (TRUST === 'cf') {
    const h = req.headers['cf-connecting-ip'];
    if (typeof h === 'string' && /^[0-9a-fA-F.:]{3,45}$/.test(h)) return h;
  }
  return (sock.remoteAddress ?? '?').replace(/^::ffff:/, '');
}
const perIp = new Map();          // ip -> open connections
const allConns = new Set();
function totalPlayers() { let n = 0; for (const r of rooms.values()) n += r.size; return n; }

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
    maxPlayers: ROOM_PLAYERS, graceMs: GRACE, collide: COLLIDE ? 1 : 0, ghost: GHOST,
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
  constructor(sock, ip, pathRoom) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.room = null; this.ip = ip; this.pathRoom = pathRoom;
    this.rxBytes = 0; this.txBytes = 0; this.rxRec = 0; this.txRec = 0; this.txFrames = 0; this.dropped = 0;
    this.lastRx = Date.now();
    allConns.add(this);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    sock.setNoDelay(true);
    this.helloTimer = setTimeout(() => { if (!this.room) this.closeWith(4003, 'no hello'); }, 10000);
    sock.on('data', (d) => {
      this.rxBytes += d.length; this.lastRx = Date.now();
      if (this.buf.length + d.length > (1 << 17)) { this.sock.destroy(); return; }   // never completes a frame
      this.buf = Buffer.concat([this.buf, d]); this.parse();
    });
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
      const name = cleanRoom(m.room ?? this.pathRoom ?? 'freeride');
      const room = name ? roomFor(name) : null;
      const resuming = room && typeof m.resume === 'string' && room.byToken.has(m.resume);
      const why = !name ? 'bad room name' : !room ? 'too many rooms' : !resuming && totalPlayers() >= MAX_PLAYERS ? 'the hub is full' : null;
      if (why) {
        this.send(1, Buffer.from(JSON.stringify({ t: 'error', why })));
        this.closeWith(4002, why);
        if (room && !room.size) rooms.delete(room.name);
        return;
      }
      this.room = room;
      clearTimeout(this.helloTimer);
    }
    this.room.onText(this, s);
  }
  onbinary(p) {
    if (!this.room) return;
    const pl = this.room.onBinary(this, p);
    if (pl) this.rxRec = pl.recs;
  }
  onclose() {
    clearTimeout(this.helloTimer);
    if (!allConns.delete(this)) return;
    const n = (perIp.get(this.ip) ?? 1) - 1;
    if (n > 0) perIp.set(this.ip, n); else perIp.delete(this.ip);
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

// Test aid (--inject-bad): every 2 s every player gets, from a made-up player
// 250, records the hub itself would never forward -- NaN position, absurd
// velocity, zero quaternion, trick id out of range -- to exercise the
// clients' own checks (src/roam.c snap_decode, web/host/roam.js bundleOk).
if (argv.includes('--inject-bad')) {
  setInterval(() => {
    const bad = [];
    for (const kind of ['nan', 'vel', 'quat', 'trick']) {
      const r = new Uint8Array(PROTO.recV2), dv = new DataView(r.buffer);
      dv.setUint32(0, Date.now() & 0xffff, true);
      for (let i = 0; i < 3; i++) dv.setFloat32(8 + 4 * i, kind === 'nan' && i === 1 ? NaN : 50, true);
      dv.setInt16(26, kind === 'quat' ? 0 : 32767, true);
      dv.setFloat32(28, kind === 'vel' ? 1e9 : 0, true);
      r[50] = 2; dv.setInt8(60, kind === 'trick' ? 99 : -1);
      bad.push([250, r]);
    }
    for (const room of rooms.values()) for (const p of room.players.values()) if (p.conn) p.pending.push(...bad);
  }, 2000);
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
      const c = pl.conn, key = pl.token;   // per player (an id can come back for someone else)
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
  const u = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (LOOPBACK && u.pathname === '/drop') {
    // Test aid: GET /drop?id=N[&room=R] cuts player N's connection (as a network
    // drop would); the client reconnects and resumes with its token.
    const r = rooms.get(cleanRoom(u.searchParams.get('room') ?? 'freeride') ?? '');
    const pl = r?.players.get(Number(u.searchParams.get('id')));
    if (pl?.conn) { log(`${r.name} #${pl.id} ${pl.name}: connection cut (/drop)`); pl.conn.sock.destroy(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: !!pl }));
    return;
  }
  if (LOOPBACK && u.pathname === '/status.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      hub: 'atv2 roam', v: PROTO.version, delay: DELAY, jitter: JITTER, loss: LOSS * 100, collide: COLLIDE,
      rooms: [...rooms.values()].map((r) => ({ name: r.name, stats: r.stats,
        players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, connected: !!p.conn, rider: p.look.rider, atv: p.look.atv, v: p.v, bad: p.bad })) })),
    }));
    return;
  }
  if (u.pathname === '/status.json') {
    // The site's status line: counts only (no names, no addresses), readable by the allowed origins.
    const origin = req.headers.origin;
    const head = { 'content-type': 'application/json', 'cache-control': 'public, max-age=5', vary: 'Origin' };
    if (origin && ORIGIN_LIST && ORIGIN_LIST.includes(origin)) head['access-control-allow-origin'] = origin;
    res.writeHead(200, head);
    res.end(JSON.stringify({ online: true, hub: 'atv2 roam', v: PROTO.version, players: totalPlayers(), rooms: rooms.size,
      uptime: Math.round(process.uptime()), roomPlayers: [...rooms.values()].map((r) => r.size) }));
    return;
  }
  // "Is it up?" -- counts only (no names, no addresses).
  res.writeHead(u.pathname === '/' ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(u.pathname === '/' ? `atv2 roamhub v${PROTO.version}: ${totalPlayers()} players, ${rooms.size} rooms\n` : 'not found\n');
});
srv.on('upgrade', (req, sock) => {
  const refuse = (code, why) => { try { sock.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ } };
  sock.on('error', () => {});
  const ip = clientIp(req, sock);
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') { refuse(400, 'Bad Request'); return; }
  if (!originOk(req.headers.origin)) { log(`refused ${ip}: origin ${req.headers.origin ?? '(none)'}`); refuse(403, 'Forbidden'); return; }
  if ((perIp.get(ip) ?? 0) >= MAX_PER_IP) { log(`refused ${ip}: ${MAX_PER_IP} connections already`); refuse(429, 'Too Many Requests'); return; }
  if (allConns.size >= MAX_PLAYERS + 16) { refuse(503, 'Service Unavailable'); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const m = /^\/room\/([^/?]+)/.exec(req.url ?? '');
  let pathRoom = null;
  try { pathRoom = m ? cleanRoom(decodeURIComponent(m[1])) : null; } catch { pathRoom = null; }
  new Conn(sock, ip, pathRoom);
});
// Idle connections (nothing received for --idle-timeout) are closed.
setInterval(() => {
  const now = Date.now();
  for (const c of allConns) if (now - c.lastRx > IDLE_MS) { log(`${c.ip}: idle ${IDLE_MS / 1000} s, closed`); c.lastRx = now; c.closeWith(4004, 'idle'); }
}, 1000);
function shutdown(sig) {
  log(`${sig}: closing ${allConns.size} connection(s)`);
  for (const c of allConns) c.closeWith(1001, 'hub stopping');
  srv.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
srv.listen(PORT, BIND, () => log(`roamhub on ws://${BIND}:${PORT}/ (v${PROTO.version}; origins ${ORIGIN_LIST ? ORIGIN_LIST.join(' ') : 'any'}` +
  `${ALLOW_NO_ORIGIN ? ' + none' : ''}; proxy ${TRUST || 'none'}; ${MAX_PLAYERS} players, ${MAX_ROOMS} rooms of ${ROOM_PLAYERS}, ` +
  `${MAX_PER_IP} conns/IP, idle ${IDLE_MS / 1000} s; delay ${DELAY} ms, jitter +-${JITTER} ms, loss ${LOSS * 100}%, bundle ${BUNDLE} ms, ` +
  `resume grace ${GRACE / 1000} s, collisions ${COLLIDE ? 'on' : 'off'}, ghost ${GHOST} s)`));
