// test.mjs -- tests for the free-roam hub, all local:
//   1. protocol.mjs: record / frame checks, token bucket;
//   2. the Room logic with fake connections (join, look, full, resume, grace,
//      routing, bundling, rate limits, bad input);
//   3. worker.js's Durable Object with a mocked ctx (hibernation: sockets'
//      attachments and storage read back after the object is dropped; alarms);
//   4. the Node hub (web/tools/roamhub.mjs) as a process on 127.0.0.1, with
//      Node's own WebSocket client.
//
//   node web/roamhub-worker/test.mjs [--port 8862]
//
// Nothing is downloaded and nothing leaves 127.0.0.1.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROTO, Room, checkRecord, parseClientFrame, buildBundle, TokenBucket, cleanRoom, cleanName, cleanLook } from './protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1] || 8862);
let pass = 0, fail = 0;
function ok(cond, what) { if (cond) pass++; else { fail++; console.log('FAIL', what); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A snapshot record as src/roam.c writes it.
function record({ pos = [50, -8, -280], vel = [1, 0, 2], q = [0, 0, 0, 1], v2 = true, rpm = 3000, trick = -1, seq = 1 } = {}) {
  const r = new Uint8Array(v2 ? PROTO.recV2 : PROTO.recV1), dv = new DataView(r.buffer);
  dv.setUint32(0, seq, true); dv.setUint32(4, 1000 + seq * 33, true);
  pos.forEach((x, i) => dv.setFloat32(8 + 4 * i, x, true));
  q.forEach((x, i) => dv.setInt16(20 + 2 * i, Math.round(x * 32767), true));
  vel.forEach((x, i) => dv.setFloat32(28 + 4 * i, x, true));
  if (v2) { r[50] = 2; dv.setUint16(52, rpm, true); dv.setInt8(60, trick); }
  return r;
}
const clientFrame = (...recs) => buildBundle(255, recs.map((r) => [0, r]));

// ---- 1. protocol --------------------------------------------------------------------
{
  ok(checkRecord(record()) === null, 'v2 record ok');
  ok(checkRecord(record({ v2: false })) === null, 'v1 record ok');
  ok(checkRecord(record({ pos: [NaN, 0, 0] })) === 'position', 'NaN position');
  ok(checkRecord(record({ pos: [0, Infinity, 0] })) === 'position', 'inf position');
  ok(checkRecord(record({ pos: [0, 0, 1e6] })) === 'position', 'far position');
  ok(checkRecord(record({ vel: [0, NaN, 0] })) === 'velocity', 'NaN velocity');
  ok(checkRecord(record({ vel: [999, 0, 0] })) === 'velocity', 'absurd velocity');
  ok(checkRecord(record({ q: [0, 0, 0, 0] })) === 'rotation', 'zero quaternion');
  ok(checkRecord(record({ rpm: 60000 })) === 'rpm', 'absurd rpm');
  ok(checkRecord(record({ trick: 77 })) === 'trick', 'trick out of range');
  ok(checkRecord(new Uint8Array(20)) === 'length', 'short record');
  ok(checkRecord(new Uint8Array(200)) === 'length', 'long record');
  ok(parseClientFrame(new Uint8Array(PROTO.maxBinary + 1)).error === 'frame too big', 'big frame');
  ok(parseClientFrame(new Uint8Array([2, 0, 0, 0])).error === 'not a bundle', 'wrong type');
  ok(parseClientFrame(new Uint8Array([1, 0, 255, 9])).error === 'too many records', 'record count');
  ok(parseClientFrame(new Uint8Array([1, 0, 255, 1, 0, 68, 1, 2])).error === 'truncated', 'truncated');
  ok(parseClientFrame(clientFrame(record())).recs.length === 1, 'one record');
  const tb = new TokenBucket(10, 2, 0);
  ok(tb.take(0) && tb.take(0) && !tb.take(0) && tb.take(150), 'token bucket');
  ok(cleanRoom('freeride') === 'freeride' && cleanRoom('a b') === null && cleanRoom('x'.repeat(30)) === null, 'room names');
  ok(cleanName('A"B\\C\u0001D') === 'ABCD' && cleanName('') === 'PLAYER', 'names');
  const lk = cleanLook({ rider: 99, atv: 3, skin: 'x' });
  ok(lk.rider === -1 && lk.atv === 3 && lk.skin === -1, 'look ranges');
}

// ---- 2. Room with fake connections -------------------------------------------------------
function fakeHub(opt = {}) {
  let t = 1000;
  const sent = new Map(), closed = new Map();
  const room = new Room('freeride', {
    now: () => t, graceMs: 5000, collide: 1,
    send: (c, d) => { if (!sent.has(c)) sent.set(c, []); sent.get(c).push(d); },
    close: (c, code) => closed.set(c, code), ...opt,
  });
  const texts = (c) => (sent.get(c) ?? []).filter((d) => typeof d === 'string').map((d) => JSON.parse(d));
  const bins = (c) => (sent.get(c) ?? []).filter((d) => typeof d !== 'string');
  return { room, sent, closed, texts, bins, advance: (ms) => { t += ms; } };
}
{
  const h = fakeHub();
  const a = {}, b = {}, c = {};
  h.room.onText(a, JSON.stringify({ t: 'hello', v: 2, name: 'ALPHA', rider: 14, atv: 0, client: 'native' }));
  const wa = h.texts(a)[0];
  ok(wa.t === 'welcome' && wa.id === 1 && wa.collide === 1 && wa.v === 2 && wa.resume.length === 24, 'welcome');
  h.room.onText(b, JSON.stringify({ t: 'hello', v: 2, name: 'BRAVO', rider: 5, atv: 3, client: 'wasm' }));
  const jb = h.texts(b).find((m) => m.t === 'join');
  ok(jb && jb.id === 1 && jb.rider === 14 && jb.atv === 0, 'newcomer learns the others and their look');
  const ja = h.texts(a).find((m) => m.t === 'join');
  ok(ja && ja.id === 2 && ja.rider === 5 && ja.atv === 3 && ja.name === 'BRAVO', 'others learn the newcomer');
  h.room.onText(b, JSON.stringify({ t: 'look', rider: 7, atv: 9 }));
  const la = h.texts(a).find((m) => m.t === 'look');
  ok(la && la.id === 2 && la.rider === 7 && la.atv === 9, 'look change broadcast');
  h.room.onText(b, JSON.stringify({ t: 'look', rider: 70, atv: 9 }));
  ok(h.texts(a).filter((m) => m.t === 'look').length === 1, 'bad look ignored');
  h.room.onText(a, JSON.stringify({ t: 'hello', name: 'AGAIN' }));
  ok(h.room.players.get(1).name === 'ALPHA', 'second hello ignored');
  // records
  h.room.onBinary(a, clientFrame(record({ seq: 1 })));
  h.room.onBinary(a, clientFrame(record({ pos: [NaN, 0, 0], seq: 2 })));
  h.room.onBinary(a, clientFrame(record({ seq: 3 })));
  h.room.flush();
  const fb = h.bins(b);
  ok(fb.length === 1 && fb[0][3] === 2 && fb[0][4] === 1 && fb[0][5] === PROTO.recV2, 'records stamped, bad one dropped, bundled');
  ok(h.bins(a).length === 0, 'no echo to the sender');
  ok(h.room.players.get(1).bad === 1 && h.room.stats.badRecords === 1, 'bad record counted');
  // room full
  const hf = fakeHub({ maxPlayers: 2 });
  hf.room.onText(a, JSON.stringify({ t: 'hello' })); hf.room.onText(b, JSON.stringify({ t: 'hello' }));
  hf.room.onText(c, JSON.stringify({ t: 'hello' }));
  ok(hf.texts(c)[0].t === 'error' && hf.closed.get(c) === 4001 && hf.room.size === 2, 'room full refused');
  // resume within the grace
  const tok = h.room.players.get(2).token;
  h.room.onClose(b);
  ok(h.room.players.get(2).conn === null, 'closed: kept for grace');
  h.advance(3000); h.room.expire();
  const b2 = {};
  h.room.onText(b2, JSON.stringify({ t: 'hello', resume: tok, name: 'X' }));
  const wb2 = h.texts(b2)[0];
  ok(wb2.t === 'welcome' && wb2.id === 2 && wb2.resumed === 1, 'resumed same id');
  ok(!h.texts(a).some((m) => m.t === 'leave'), 'no leave on resume');
  // grace expiry
  h.room.onClose(b2);
  h.advance(4000); ok(h.room.expire() > 0 && h.room.players.has(2), 'grace not over');
  h.advance(1500); h.room.expire();
  ok(!h.room.players.has(2) && h.texts(a).some((m) => m.t === 'leave' && m.id === 2), 'left after grace');
  // rate limit: a flood of records is cut, then the connection closed
  const hr = fakeHub();
  const x = {}, y = {};
  hr.room.onText(x, JSON.stringify({ t: 'hello' })); hr.room.onText(y, JSON.stringify({ t: 'hello' }));
  for (let i = 0; i < 400; i++) hr.room.onBinary(x, clientFrame(record({ seq: i })));
  hr.room.flush();
  const got = hr.bins(y).reduce((n, f) => n + f[3], 0);
  ok(got === PROTO.recBurst, `record rate limited (${got} of 400 forwarded)`);
  ok(hr.closed.get(x) === 4008, 'flooder closed');
  // oversized text and garbage
  const hg = fakeHub(); const g = {};
  hg.room.onText(g, JSON.stringify({ t: 'hello' }));
  hg.room.onText(g, 'x'.repeat(PROTO.maxText + 1));
  hg.room.onText(g, '{not json');
  hg.room.onBinary(g, new Uint8Array(5000));
  ok(hg.room.stats.badFrames === 3, 'bad frames counted');
}

// ---- 3. the Durable Object, mocked ----------------------------------------------------------
{
  class FakeWs {
    constructor() { this.out = []; this.att = null; this.closedWith = null; }
    send(d) { this.out.push(d); }
    close(code) { this.closedWith = code; }
    serializeAttachment(a) { this.att = JSON.parse(JSON.stringify(a)); }
    deserializeAttachment() { return this.att; }
  }
  const store = new Map();
  let alarm = 0;
  const sockets = [];
  const ctx = {
    getWebSockets: () => sockets.filter((s) => s.closedWith == null),
    acceptWebSocket: (s) => sockets.push(s),
    storage: {
      get: async (k) => store.get(k), put: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
      delete: async (k) => store.delete(k),
      list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))),
      setAlarm: async (t) => { alarm = t; },
    },
  };
  const { RoamRoom } = await import('./worker.js');
  const env = { MAX_PLAYERS: '8', GRACE_S: '1', COLLIDE: '1', GHOST_S: '3' };
  let dobj = new RoamRoom(ctx, env);
  const wa = new FakeWs(), wb = new FakeWs();
  sockets.push(wa, wb);
  await dobj.ensureRoom('freeride');
  await dobj.webSocketMessage(wa, JSON.stringify({ t: 'hello', v: 2, name: 'ALPHA', rider: 1, atv: 2 }));
  await dobj.webSocketMessage(wb, JSON.stringify({ t: 'hello', v: 2, name: 'BRAVO', rider: 3, atv: 4 }));
  ok(wa.att?.id === 1 && wb.att?.id === 2 && wa.att.look.rider === 1, 'DO: players on the socket attachments');
  await dobj.webSocketMessage(wa, clientFrame(record()).buffer);
  await sleep(40);
  ok(wb.out.some((d) => typeof d !== 'string' && d[2] === 2 && d[4] === 1), 'DO: record bundled to the other player');
  // hibernation: the object is dropped and rebuilt from the attachments
  dobj = new RoamRoom(ctx, env);
  await dobj.webSocketMessage(wb, JSON.stringify({ t: 'look', rider: 9, atv: 10 }));
  ok(dobj.room.players.size === 2 && wa.out.some((d) => typeof d === 'string' && d.includes('"t":"look"') && d.includes('"rider":9')),
    'DO: after hibernation the room is read back and a look reaches the other player');
  await dobj.webSocketMessage(wb, clientFrame(record({ vel: [Infinity, 0, 0] })).buffer);
  ok(dobj.room.stats.badRecords === 1, 'DO: bad record dropped');
  // a drop: grace in storage, alarm, resume across a hibernation
  wb.closedWith = 1006;
  await dobj.webSocketClose(wb);
  ok(store.has('p:2') && alarm > Date.now(), 'DO: grace player in storage, alarm set');
  dobj = new RoamRoom(ctx, env);
  const wb2 = new FakeWs(); sockets.push(wb2);
  await dobj.webSocketMessage(wb2, JSON.stringify({ t: 'hello', resume: store.get('p:2').token }));
  ok(JSON.parse(wb2.out[0]).resumed === 1 && JSON.parse(wb2.out[0]).id === 2, 'DO: resumed after hibernation');
  wb2.closedWith = 1006;
  await dobj.webSocketClose(wb2);
  await sleep(1100);
  await dobj.alarm();
  ok(!dobj.room.players.has(2) && wa.out.some((d) => typeof d === 'string' && d.includes('"t":"leave"')), 'DO: alarm ends the grace');
  // the Worker's entry: routing and checks (no Durable Object needed for these)
  const worker = (await import('./worker.js')).default;
  const r404 = await worker.fetch(new Request('http://x/other'), {});
  const r400 = await worker.fetch(new Request('http://x/roam/bad%20name', { headers: { Upgrade: 'websocket' } }), {});
  const r426 = await worker.fetch(new Request('http://x/roam/freeride'), {});
  const r403 = await worker.fetch(new Request('http://x/roam/freeride', { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }),
    { ALLOWED_ORIGINS: 'https://good.example' });
  const r429 = await worker.fetch(new Request('http://x/roam/freeride', { headers: { Upgrade: 'websocket' } }),
    { RL: { limit: async () => ({ success: false }) } });
  let routed = null;
  await worker.fetch(new Request('http://x/roam/lobby2', { headers: { Upgrade: 'websocket' } }),
    { ROOMS: { idFromName: (n) => `id:${n}`, get: (id) => ({ fetch: async (rq) => { routed = [id, rq.headers.get('X-Roam-Room')]; return new Response('ok'); } }) } });
  ok(r404.status === 404 && r400.status === 400 && r426.status === 426 && r403.status === 403 && r429.status === 429, 'Worker: entry checks');
  ok(routed && routed[0] === 'id:lobby2' && routed[1] === 'lobby2', 'Worker: one Durable Object per room');
}

// ---- 4. the Node hub as a process -------------------------------------------------------------
{
  const hub = spawn(process.execPath, [join(here, '..', 'tools', 'roamhub.mjs'), '--port', String(PORT), '--quiet', '--collide', '1',
    '--max-players', '3', '--grace', '1'], { stdio: 'ignore' });
  try {
    await sleep(500);
    const open = (name, look) => new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/roam`);
      ws.binaryType = 'arraybuffer';
      ws.msgs = []; ws.bins = [];
      ws.onmessage = (e) => { if (typeof e.data === 'string') ws.msgs.push(JSON.parse(e.data)); else ws.bins.push(new Uint8Array(e.data)); };
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', v: 2, room: 'freeride', name, client: 'test', ...look })); res(ws); };
      ws.onerror = rej;
    });
    const a = await open('ALPHA', { rider: 14, atv: 0 });
    const b = await open('BRAVO', { rider: 5, atv: 3 });
    await sleep(150);
    ok(a.msgs[0]?.t === 'welcome' && a.msgs[0].collide === 1, 'hub: welcome with the room setting');
    ok(b.msgs.some((m) => m.t === 'join' && m.rider === 14 && m.atv === 0), 'hub: look in join');
    for (let i = 0; i < 10; i++) a.send(clientFrame(record({ seq: i + 1 })));
    a.send(clientFrame(record({ pos: [NaN, 0, 0], seq: 11 })));
    a.send(clientFrame(record({ seq: 12, v2: false })));
    await sleep(200);
    const n = b.bins.reduce((k, f) => k + f[3], 0);
    ok(n === 11, `hub: 11 good records forwarded (${n}), NaN one dropped`);
    b.send(JSON.stringify({ t: 'look', rider: 8, atv: 8 }));
    await sleep(100);
    ok(a.msgs.some((m) => m.t === 'look' && m.rider === 8), 'hub: look change');
    const c = await open('CHARLIE', {});
    const d = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/roam`);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: 'DELTA' }));
      ws.onmessage = (e) => res(JSON.parse(e.data));
    });
    ok(d.t === 'error' && /full/.test(d.why), 'hub: room full');
    const big = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/roam`);
      ws.onopen = () => ws.send('x'.repeat(70000));
      ws.onclose = (e) => res(e.code);
    });
    ok(big === 1009 || big === 1006, `hub: oversized frame closes (${big})`);
    const info = await (await fetch(`http://127.0.0.1:${PORT}/`)).json();
    ok(info.rooms[0].players.length === 3 && info.rooms[0].stats.badRecords === 1, 'hub: status page');
    c.close();
    a.close(); b.close();
  } finally {
    hub.kill();
  }
}

await sleep(300);   // let the sockets close before exiting
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
