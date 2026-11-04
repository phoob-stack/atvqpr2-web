// hub.js - the free-roam hub client (hub/hub.mjs; the protocol is a copy of
// atvrecomp's web/tools/roamhub.mjs):
//   text:   -> {"t":"hello","v":1,"room":..,"name":..,"resume":..}
//           <- {"t":"welcome","id","resume","resumed"} {"t":"join","id","name"} {"t":"leave","id"}
//   binary: -> [1][0][255][1] [0][len][record]       our snapshot
//           <- [1][0][dst][n] n x ([src][len][record])
// Our record (18 bytes): f32 x, f32 y, f32 heading, f32 speed, u8 color, u8 laps.
export const RECORD_BYTES = 18;

export function connectHub(url, { name = 'PLAYER', room = 'boxquad', onChange = () => {} } = {}) {
  const peers = new Map();         // id -> { id, name, x, y, heading, speed, color, laps, at }
  const hub = { id: 0, connected: false, peers, sent: 0, received: 0, closed: false, ws: null };
  let resume = '';
  let retry = 500;

  function open() {
    if (hub.closed) return;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    hub.ws = ws;
    ws.onopen = () => { retry = 500; ws.send(JSON.stringify({ t: 'hello', v: 1, room, name, resume, client: 'boxquad-web' })); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'welcome') { hub.id = m.id; resume = m.resume; hub.connected = true; if (!m.resumed) peers.clear(); }
        else if (m.t === 'join') { const p = peers.get(m.id) ?? { id: m.id }; p.name = m.name; peers.set(m.id, p); }
        else if (m.t === 'leave') peers.delete(m.id);
        else if (m.t === 'name') { const p = peers.get(m.id); if (p) p.name = m.name; }
        onChange(hub);
        return;
      }
      const b = new Uint8Array(ev.data);
      if (b.length < 4 || b[0] !== 1) return;
      const dv = new DataView(ev.data);
      let at = 4;
      for (let k = 0; k < b[3] && at + 2 <= b.length; k++) {
        const src = b[at], len = b[at + 1];
        if (at + 2 + len > b.length) break;
        if (len >= RECORD_BYTES) {
          const o = at + 2;
          const p = peers.get(src) ?? { id: src, name: `#${src}` };
          p.x = dv.getFloat32(o, true); p.y = dv.getFloat32(o + 4, true);
          p.heading = dv.getFloat32(o + 8, true); p.speed = dv.getFloat32(o + 12, true);
          p.color = b[o + 16]; p.laps = b[o + 17]; p.at = performance.now();
          peers.set(src, p);
          hub.received++;
        }
        at += 2 + len;
      }
    };
    ws.onclose = () => {
      hub.connected = false;
      onChange(hub);
      if (!hub.closed) { setTimeout(open, retry); retry = Math.min(retry * 2, 8000); }
    };
    ws.onerror = () => {};
  }
  open();

  const frame = new ArrayBuffer(6 + RECORD_BYTES);
  const fv = new DataView(frame), fb = new Uint8Array(frame);
  fb.set([1, 0, 255, 1, 0, RECORD_BYTES]);
  hub.send = (s) => {
    if (!hub.connected || hub.ws?.readyState !== 1) return;
    fv.setFloat32(6, s.x, true); fv.setFloat32(10, s.y, true); fv.setFloat32(14, s.heading, true); fv.setFloat32(18, s.speed, true);
    fb[22] = s.color & 255; fb[23] = s.laps & 255;
    hub.ws.send(frame);
    hub.sent++;
  };
  hub.close = () => { hub.closed = true; hub.ws?.close(); };
  return hub;
}
