// title.js - the placeholder title's page side: runs title.wasm (physics,
// laps, mesh transform), draws with canvas 2D, and gets every asset through
// the asset manager (assets.get(path)): the start set before the first frame,
// the sand texture only when the camera first comes near the sand zone.
import { connectHub } from './hub.js';

const PALETTE = [[220, 70, 40], [40, 120, 220], [40, 170, 80], [200, 160, 30], [160, 60, 200], [30, 180, 180], [230, 110, 160], [120, 120, 120]];

function parseTexture(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x58455444) throw new Error('not a DTEX texture');
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true);
  return new ImageData(new Uint8ClampedArray(buf, 16, w * h * 4), w, h);
}
function parseMesh(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x48534D44) throw new Error('not a DMSH mesh');
  const nv = dv.getUint32(8, true), nf = dv.getUint32(12, true);
  const verts = new Float32Array(buf.slice(16, 16 + nv * 12));
  const faces = [];
  let o = 16 + nv * 12;
  for (let i = 0; i < nf; i++, o += 12) {
    faces.push({ v: [0, 1, 2, 3].map((k) => dv.getUint16(o + 2 * k, true)), rgb: [dv.getUint8(o + 8), dv.getUint8(o + 9), dv.getUint8(o + 10)] });
  }
  return { nv, verts, faces };
}

/** Shown under the canvas by the runner. */
export const help = 'Arrow keys or WASD to drive. North of the start the ground turns to sand: its texture is fetched the first time you get near.';

export async function start({ assets, module, canvas, hud, hubUrl, name = 'PLAYER' }) {
  const t0 = performance.now();
  const { exports: ex } = await WebAssembly.instantiate(module, {});
  const cfg = await assets.json('config/title.json');
  // The start set (already fetched by the launcher; from OPFS here).
  const [trackBuf, meshBuf, grassBuf, dirtBuf] = await Promise.all(
    ['meshes/track.bin', 'meshes/quad.bin', 'textures/grass.rgba', 'textures/dirt.rgba'].map((p) => assets.arrayBuffer(p)));
  const tp = ex.alloc(trackBuf.byteLength);
  new Uint8Array(ex.memory.buffer, tp, trackBuf.byteLength).set(new Uint8Array(trackBuf));
  if (ex.track_load(tp, trackBuf.byteLength) < 3) throw new Error('title.wasm refused meshes/track.bin');
  const trackPts = new Float32Array(trackBuf.slice(16));
  const trackW = ex.track_width();
  ex.reset();
  const mesh = parseMesh(meshBuf);
  const vIn = ex.alloc(mesh.nv * 12), vOut = ex.alloc(mesh.nv * 12);
  new Float32Array(ex.memory.buffer, vIn, mesh.nv * 3).set(mesh.verts);

  const ctx = canvas.getContext('2d');
  const pattern = async (buf) => {
    const p = ctx.createPattern(await createImageBitmap(parseTexture(buf)), 'repeat');
    p.setTransform(new DOMMatrix().scale(cfg.worldPerTexel));
    return p;
  };
  const tex = { grass: await pattern(grassBuf), dirt: await pattern(dirtBuf), sand: null };
  const sand = { requested: false, ready: false, percent: 0, at: null, error: null };
  function wantSand() {
    if (sand.requested) return;
    sand.requested = true;
    sand.requestedAt = performance.now();
    // the texture's on-demand group (manifest `group`), when the manifest has one; else just the file
    const group = assets.groupOf?.(cfg.sandZone.texture);
    sand.group = group ?? null;
    (group ? assets.loadGroup(group, { onProgress: (d) => { sand.percent = d.percent; } }).then(() => assets.get(cfg.sandZone.texture))
      : assets.get(cfg.sandZone.texture, { onProgress: (d) => { sand.percent = d.percent; } }))
      .then((f) => f.arrayBuffer()).then(pattern)
      .then((p) => { tex.sand = p; sand.ready = true; sand.at = performance.now(); })
      .catch((e) => { sand.error = e.message; });
  }

  const color = Math.floor(Math.random() * PALETTE.length);
  const hub = hubUrl ? connectHub(hubUrl, { name }) : null;

  const keys = new Set();
  const input = { throttle: 0, steer: 0, forced: null };
  addEventListener('keydown', (e) => { keys.add(e.key.toLowerCase()); if (e.key.startsWith('Arrow')) e.preventDefault(); });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  const carView = () => {
    const f = new Float32Array(ex.memory.buffer, ex.state(), 12), i = new Int32Array(ex.memory.buffer, ex.state() + 48, 4);
    return { x: f[0], y: f[1], heading: f[2], speed: f[3], lapTime: f[5], bestLap: f[6], offTrack: f[8] > 0, lastLap: f[10], laps: i[2], frames: i[3] };
  };

  let cam = { x: 0, y: 0, rot: 0 };
  { const c = carView(); cam = { x: c.x, y: c.y, rot: -Math.PI / 2 - c.heading }; }
  let last = performance.now(), frames = 0, lastSend = 0, running = true;
  const SCALE = 12;

  function drawBox(px, py, heading, rgb) {
    ex.mesh_xform(vIn, vOut, mesh.nv, px, py, heading, cam.x, cam.y, cam.rot, SCALE, 0.55);
    const o = new Float32Array(ex.memory.buffer, vOut, mesh.nv * 3);
    const faces = mesh.faces.map((f) => ({ f, d: f.v.reduce((a, v) => a + o[v * 3 + 2], 0) / 4 })).sort((a, b) => a.d - b.d);
    for (const { f } of faces) {
      const base = f.rgb;
      const c = rgb && base[0] > 120 ? rgb.map((x) => Math.round((x * base[0]) / 220)) : base;   // body faces take the player colour
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.beginPath();
      f.v.forEach((v, k) => (k ? ctx.lineTo(o[v * 3], o[v * 3 + 1]) : ctx.moveTo(o[v * 3], o[v * 3 + 1])));
      ctx.closePath();
      ctx.fill();
    }
  }

  // The simulation runs on a fixed 60 Hz timer (and keeps the hub fed while
  // the tab is in the background); drawing happens on animation frames.
  let simSteps = 0;
  function sim() {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const k = (a, b) => keys.has(a) || keys.has(b);
    const th = input.forced ? input.forced.throttle : (k('arrowup', 'w') ? 1 : 0) - (k('arrowdown', 's') ? 1 : 0);
    const st = input.forced ? input.forced.steer : (k('arrowleft', 'a') ? 1 : 0) - (k('arrowright', 'd') ? 1 : 0);
    ex.step(dt, th, -st);
    simSteps++;
    const c = carView();
    const t = performance.now();
    if (hub && t - lastSend > 50) { lastSend = t; hub.send({ ...c, color }); }
    // camera: behind the car, rotated so the car points up
    const targetRot = -Math.PI / 2 - c.heading;
    let dr = targetRot - cam.rot;
    while (dr > Math.PI) dr -= 2 * Math.PI;
    while (dr < -Math.PI) dr += 2 * Math.PI;
    const a = Math.min(1, dt * 5);
    cam = { x: cam.x + (c.x - cam.x) * a * 2, y: cam.y + (c.y - cam.y) * a * 2, rot: cam.rot + dr * a };
    if (!sand.requested && cam.y > cfg.sandZone.yMin - cfg.sandZone.approach) wantSand();
  }
  const simTimer = setInterval(sim, 1000 / 60);

  function frame() {
    if (!running) return;
    const c = carView();

    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#3a5';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(1, 0, 0, 1, W / 2, H * 0.68);
    ctx.rotate(cam.rot);
    ctx.scale(SCALE, SCALE);
    ctx.translate(-cam.x, -cam.y);
    const R = Math.hypot(W, H) / SCALE;
    ctx.fillStyle = tex.grass;
    ctx.fillRect(cam.x - R, cam.y - R, 2 * R, 2 * R);
    if (cam.y + R > cfg.sandZone.yMin) {
      ctx.fillStyle = tex.sand ?? '#d8c48a';
      ctx.fillRect(cam.x - R, cfg.sandZone.yMin, 2 * R, cam.y + R - cfg.sandZone.yMin);
    }
    ctx.beginPath();
    for (let i = 0; i < trackPts.length; i += 2) (i ? ctx.lineTo(trackPts[i], trackPts[i + 1]) : ctx.moveTo(trackPts[i], trackPts[i + 1]));
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = trackW + 1.2;
    ctx.strokeStyle = '#eee';
    ctx.stroke();
    ctx.lineWidth = trackW;
    ctx.strokeStyle = tex.dirt;
    ctx.stroke();
    // start line
    ctx.save();
    ctx.translate(trackPts[0], trackPts[1]);
    ctx.rotate(Math.atan2(trackPts[3] - trackPts[1], trackPts[2] - trackPts[0]));
    ctx.fillStyle = '#fff';
    ctx.fillRect(-0.6, -trackW / 2, 1.2, trackW);
    ctx.restore();

    ctx.setTransform(1, 0, 0, 1, W / 2, H * 0.68);
    const t = performance.now();
    if (hub) for (const p of hub.peers.values()) if (p.at && t - p.at < 3000) drawBox(p.x, p.y, p.heading, PALETTE[p.color % PALETTE.length]);
    drawBox(c.x, c.y, c.heading, PALETTE[color]);

    frames++;
    if (hud && frames % 6 === 0) {
      const live = hub ? [...hub.peers.values()].filter((p) => p.at && t - p.at < 3000).length : 0;
      hud.textContent = `speed ${(Math.abs(c.speed) * 3.6).toFixed(0).padStart(3)} km/h${c.offTrack ? '  (off track)' : ''}\n` +
        `lap ${c.laps + 1}  ${c.lapTime.toFixed(1)} s${c.bestLap ? `  best ${c.bestLap.toFixed(1)} s` : ''}\n` +
        `sand texture: ${sand.ready ? 'loaded' : sand.requested ? `streaming ${sand.percent.toFixed(0)}%` : 'not needed yet'}\n` +
        (hub ? `hub: ${hub.connected ? `#${hub.id}, ${live} other player(s)` : 'connecting…'}` : 'hub: off');
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    startedMs: Math.round(performance.now() - t0),
    state: () => ({ ...carView(), frames: simSteps, drawn: frames, sand: { ...sand }, hub: hub ? { id: hub.id, connected: hub.connected, sent: hub.sent, received: hub.received,
      peers: [...hub.peers.values()].map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, fresh: !!p.at && performance.now() - p.at < 3000 })) } : null }),
    setInput: (throttle, steer) => { input.forced = throttle === null ? null : { throttle, steer }; },
    place: (x, y, heading) => { ex.place(x, y, heading); cam.x = x; cam.y = y; },
    stop: () => { running = false; clearInterval(simTimer); hub?.close(); },
  };
}
