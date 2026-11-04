// roam.js -- the browser side of free roam (src/roam.c): the page is the
// game's WebSocket transport, and draws the other players' name tags.
//
// With ?env=RECOMP_ROAM=127.0.0.1:<port>[;name=..] the game publishes its roam
// mailbox at WebHost.reserved[0] (web_main.c). This pumps that mailbox to one
// WebSocket to the hub (web/tools/roamhub.mjs), the same protocol the native
// build speaks (src/roam_net.c): text frames = JSON control, binary frames =
// snapshot bundles. Name tags are a DOM overlay over the canvas, at the
// screen positions the game writes into the mailbox each tick.
import { Host } from './abi.js';

// RoamMailbox (src/roam.h) on wasm32.
const MB = {
  magic: 0, version: 4, size: 8, state: 12, addr: 16, outCap: 80, inCap: 84,
  outHead: 88, outTail: 92, inHead: 96, inTail: 100, txBytes: 104, rxBytes: 108,
  nlabels: 112, labels: 116, labelSize: 32, out: 116 + 8 * 32,
};
const MAGIC = 0x4D414F52, KIND_TEXT = 1, KIND_BINARY = 2, KIND_EVENT = 3;
const MAX_TEXT = 4096, MAX_BINARY = 16384;
// label flags (src/roam.h): collisions on and the rider a ghost / solid
const LABEL_GHOST = 1, LABEL_SOLID = 2;

// A snapshot bundle from the hub: well formed, and every record's floats
// finite and in range (src/roam.c checks each record again before the game
// sees it; a bad frame is dropped here whole).
function bundleOk(p) {
  if (p.length < 4 || p[0] !== 1) return false;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let at = 4;
  for (let k = 0; k < p[3]; k++) {
    if (at + 2 > p.length) return false;
    const len = p[at + 1], r = at + 2;
    if (r + len > p.length || len < 52) return false;
    for (let i = 0; i < 3; i++) {
      const x = dv.getFloat32(r + 8 + 4 * i, true), v = dv.getFloat32(r + 28 + 4 * i, true);
      if (!Number.isFinite(x) || Math.abs(x) >= 20000 || !Number.isFinite(v) || Math.abs(v) >= 200) return false;
    }
    at = r + len;
  }
  return true;
}

export function startRoam({ memory, hostPtr, env, canvas, log, display }) {
  const spec = env.RECOMP_ROAM;
  if (!spec || spec === '0') return null;
  const addr = spec.split(/[;,]/).find((t) => !t.includes('=')) ?? '';
  const st = { ws: null, mb: 0, open: false, tx: 0, rx: 0, txMsgs: 0, rxMsgs: 0, connects: 0, oversize: 0 };
  let u8, i32, dv;
  const views = () => {
    if (!u8 || u8.buffer !== memory.buffer) {
      u8 = new Uint8Array(memory.buffer); i32 = new Int32Array(memory.buffer); dv = new DataView(memory.buffer);
    }
  };
  const u32 = (off) => Atomics.load(i32, (st.mb + off) >>> 2) >>> 0;
  const setU32 = (off, v) => Atomics.store(i32, (st.mb + off) >>> 2, v | 0);

  // Ring put/get, as ring_put/ring_get in roam.c: [u16 len][u8 kind][payload].
  function inPut(kind, bytes) {
    views();
    const cap = u32(MB.inCap), base = st.mb + MB.out + u32(MB.outCap);
    const h = u32(MB.inHead), t = u32(MB.inTail), n = bytes.length;
    if (n > 0xffff || (h - t) + 3 + n > cap) return false;
    const hdr = [n & 255, n >> 8, kind];
    for (let i = 0; i < 3; i++) u8[base + (h + i) % cap] = hdr[i];
    for (let i = 0; i < n; i++) u8[base + (h + 3 + i) % cap] = bytes[i];
    setU32(MB.inHead, h + 3 + n);
    return true;
  }
  function outGet() {
    views();
    const cap = u32(MB.outCap), base = st.mb + MB.out;
    const h = u32(MB.outHead), t = u32(MB.outTail);
    if (h === t) return null;
    const n = u8[base + t % cap] | (u8[base + (t + 1) % cap] << 8), kind = u8[base + (t + 2) % cap];
    const p = new Uint8Array(n);
    for (let i = 0; i < n; i++) p[i] = u8[base + (t + 3 + i) % cap];
    setU32(MB.outTail, t + 3 + n);
    return { kind, p };
  }

  function connect() {
    let ws;
    try { ws = new WebSocket(`ws://${addr}/roam`); } catch (e) { log(`[roam] ${e.message}`); setTimeout(connect, 1000); return; }
    ws.binaryType = 'arraybuffer';
    st.ws = ws; setU32(MB.state, 1);
    ws.onopen = () => {
      st.open = true; st.connects++; setU32(MB.state, 2);
      log(`[roam] connected to ws://${addr}/`);
      inPut(KIND_EVENT, new TextEncoder().encode('open'));
    };
    ws.onmessage = (e) => {
      const p = typeof e.data === 'string' ? new TextEncoder().encode(e.data) : new Uint8Array(e.data);
      st.rx += p.length; st.rxMsgs++;
      // Frame size limits (src/roam.h ROAM_MAX_TEXT / ROAM_MAX_BINARY): bigger is not ours.
      if (p.length > (typeof e.data === 'string' ? MAX_TEXT : MAX_BINARY)) { st.oversize++; return; }
      if (typeof e.data !== 'string' && !bundleOk(p)) { st.badFrames = (st.badFrames ?? 0) + 1; return; }
      if (!inPut(typeof e.data === 'string' ? KIND_TEXT : KIND_BINARY, p)) log('[roam] mailbox full: frame dropped');
    };
    ws.onclose = () => {
      if (st.open) { log('[roam] connection lost; reconnecting'); inPut(KIND_EVENT, new TextEncoder().encode('close')); }
      st.open = false; st.ws = null; setU32(MB.state, 1);
      setTimeout(connect, 1000);
    };
    ws.onerror = () => {};
  }

  // Name tags.
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:5';
  document.body.appendChild(layer);
  const tags = [];
  function drawTags() {
    views();
    const n = Math.min(8, u32(MB.nlabels));
    const r = canvas.getBoundingClientRect();
    const aspect = display?.widescreen ? 16 / 9 : 4 / 3;
    let w = r.width, h = w / aspect;
    if (h > r.height) { h = r.height; w = h * aspect; }
    const x0 = r.left + (r.width - w) / 2, y0 = r.top + (r.height - h) / 2;
    for (let i = 0; i < 8; i++) {
      let el = tags[i];
      if (!el) {
        el = tags[i] = document.createElement('div');
        el.style.cssText = 'position:fixed;transform:translate(-50%,-100%);font:bold 14px system-ui,sans-serif;color:#fff;' +
          'text-shadow:0 0 3px #000,0 0 2px #000;white-space:nowrap;background:rgba(0,0,0,.25);padding:1px 6px;border-radius:4px';
        layer.appendChild(el);
      }
      if (i >= n) { el.style.display = 'none'; continue; }
      const o = st.mb + MB.labels + i * MB.labelSize;
      const lx = dv.getFloat32(o, true), ly = dv.getFloat32(o + 4, true), lz = dv.getFloat32(o + 8, true);
      let name = '';
      for (let k = 0; k < 19 && u8[o + 12 + k]; k++) name += String.fromCharCode(u8[o + 12 + k]);
      const fl = u8[o + 31];
      el.style.display = '';
      el.textContent = name;
      // the ghost cue: light blue, italic and see-through while a ghost, yellow once solid
      el.style.color = fl & LABEL_GHOST ? '#8cc8ff' : fl & LABEL_SOLID ? '#ffd040' : '#fff';
      el.style.fontStyle = fl & LABEL_GHOST ? 'italic' : 'normal';
      el.style.left = `${x0 + lx * w}px`;
      el.style.top = `${y0 + ly * h}px`;
      el.style.opacity = String(Math.max(0.35, Math.min(1, 1.6 - lz / 60)) * (fl & LABEL_GHOST ? 0.7 : 1));
    }
    requestAnimationFrame(drawTags);
  }

  // Wait for the game to publish the mailbox, then pump every 4 ms.
  const hv = () => new Int32Array(memory.buffer, hostPtr, Host.words);
  const wait = setInterval(() => {
    const p = hv()[Host.at.reserved] >>> 0;
    if (!p) return;
    clearInterval(wait);
    st.mb = p; views();
    if (u32(MB.magic) !== MAGIC) { log(`[roam] mailbox at 0x${p.toString(16)} has a bad magic`); return; }
    if (u32(MB.version) !== 2) { log(`[roam] mailbox version ${u32(MB.version)}; this page knows version 2`); return; }
    log(`[roam] mailbox at 0x${p.toString(16)}; hub ws://${addr}/`);
    connect();
    setInterval(() => {
      for (let m; (m = outGet());) {
        if (!st.ws || st.ws.readyState !== 1) continue;      // dropped while down; the game re-sends hello on open
        st.ws.send(m.kind === KIND_TEXT ? new TextDecoder().decode(m.p) : m.p);
        st.tx += m.p.length; st.txMsgs++;
      }
    }, 4);
    requestAnimationFrame(drawTags);
  }, 100);
  window.atv = window.atv ?? {};
  window.atv.roam = st;
  return st;
}
