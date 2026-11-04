// Orbit (the second test title, ours): its page code. The runner hands it the
// asset manager and the compiled module (profiles/orbit.json: entry
// orbit.wasm, required config/orbit.json + palette.bin, group "sky").
// Bodies from orbit.wasm, drawn with canvas 2D; the star field is the
// on-demand group, fetched on first use (a second after the start).
/** Shown under the canvas by the runner. */
export const help = 'Nothing to drive: bodies orbit a central mass. The star field is an on-demand group, fetched a second after the start.';

export async function start({ assets, module, canvas, hud }) {
  const cfg = await assets.json('config/orbit.json');
  const pal = new Uint8Array(await assets.arrayBuffer('palette.bin'));
  const { exports: ex } = await WebAssembly.instantiate(module, {});
  const n = ex.init(cfg.bodies, cfg.seed);
  const ctx = canvas.getContext('2d');
  let stars = null, frames = 0, sim = 0, running = true;
  const sky = { state: 'waiting', percent: 0 };
  setTimeout(() => {
    sky.state = 'loading';
    assets.loadGroup('sky', { onProgress: (d) => { sky.percent = d.percent; } })
      .then(() => assets.arrayBuffer('sky/stars.bin'))
      .then((b) => { const v = new DataView(b); stars = new Float32Array(b, 8, v.getUint32(4, true) * 3); sky.state = 'ready'; sky.percent = 100; })
      .catch((e) => { sky.state = `error: ${e.message}`; });
  }, 1000);
  // simulation on a fixed timer (keeps going in background tabs), drawing on animation frames
  const timer = setInterval(() => { for (let k = 0; k < cfg.stepsPerFrame; k++) sim = ex.step(cfg.step); }, 1000 / 60);
  const draw = () => {
    if (!running) return;
    const W = canvas.width, H = canvas.height, s = Math.min(W, H) * 0.45;
    ctx.fillStyle = cfg.background; ctx.globalAlpha = 1 - cfg.trail; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    if (stars) for (let i = 0; i < stars.length; i += 3) { ctx.fillStyle = `rgba(255,255,255,${stars[i + 2]})`; ctx.fillRect(W / 2 + stars[i] * W / 2, H / 2 + stars[i + 1] * H / 2, 1, 1); }
    const b = new Float32Array(ex.memory.buffer, ex.bodies(), n * 4);
    for (let i = 0; i < n; i++) {
      const sp = Math.min(255, Math.round(Math.hypot(b[i * 4 + 2], b[i * 4 + 3]) * 120));
      ctx.fillStyle = `rgb(${pal[sp * 3]},${pal[sp * 3 + 1]},${pal[sp * 3 + 2]})`;
      ctx.fillRect(W / 2 + b[i * 4] * s - 1.5, H / 2 + b[i * 4 + 1] * s - 1.5, 3, 3);
    }
    ctx.fillStyle = '#ffd36b'; ctx.beginPath(); ctx.arc(W / 2, H / 2, 6, 0, Math.PI * 2); ctx.fill();
    frames++;
    if (hud && frames % 10 === 0) hud.textContent = `Orbit · ${n} bodies · step ${sim} · sky ${sky.state}${sky.state === 'loading' ? ` ${sky.percent.toFixed(0)}%` : ''}`;
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return {
    state: () => ({ frames: sim, drawn: frames, bodies: n, sky: { ...sky } }),
    stop: () => { running = false; clearInterval(timer); },
  };
}
