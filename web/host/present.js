// The page's half of the present path (src/web/web_present.c):
//  - frames: waits on gp_seq (Atomics.waitAsync), stages the GpFrame with
//    web/gpu/encoder.js straight from views into wasm memory (resource queue,
//    records, writeBuffer of the vertex/index/constant arenas: WebGPU copies
//    at the call), claims the frame (the game may now reuse the arenas), then
//    encodes the draws. Only WGSL text is copied (TextDecoder refuses shared
//    buffers). Copying the arenas out first cost 15% of the main thread in
//    a race (10-25 MB a frame).
//  - display: on every animation frame, shows the render target the encoder
//    holds for the guest framebuffer the title last flipped to (disp_va), or
//    the CPU-converted framebuffer (disp_cpu), letterboxed 4:3 on the canvas
//    (16:9 with the widescreen option: the title then renders anamorphic).
//  - display options (main.js: ?res=2|4|window, ?msaa=4, ?widescreen=1): the
//    encoder draws at that scale / with MSAA; "window" follows the canvas.
import { Host, GpFrame } from './abi.js';
import { GpEncoder } from '../gpu/encoder.js';
import * as P from '../gpu/proto.js';

const BLIT_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V; o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y); return o;
}
@fragment fn fs(v: V) -> @location(0) vec4f { return vec4f(textureSample(src, smp, v.uv).rgb, 1.0); }`;

/** The encoder scale for a 640x480 guest frame (gp_display_scale_for in
 * src/gpu/gpu_display.c): fixed, or for "window" the letterboxed picture in
 * a cw x ch canvas. Height decides; the width follows the display aspect
 * (a 16:9 frame gets square pixels). 1..8, window sizes in 1/64 steps. */
export function scaleFor(d, cw, ch) {
  const [aw, ah] = d.aspect;
  let h;
  if (!d.window) { if (d.scale === 1) return [1, 1]; h = 480 * d.scale; }
  else if (!cw || !ch) return [1, 1];
  else h = Math.min(cw * ah / aw, ch);
  const clamp = (v) => Math.min(8, Math.max(1, v));
  let sy = clamp(h / 480), sx = clamp(h * aw / ah / 640);
  if (d.window) { sx = Math.round(sx * 64) / 64; sy = Math.round(sy * 64) / 64; }
  return [sx, sy];
}

export class Presenter {
  constructor({ device, features, canvas, memory, hostPtr, onError, display = {} }) {
    this.dev = device; this.memory = memory; this.ptr = hostPtr;
    this.i32 = new Int32Array(memory.buffer, hostPtr, Host.words);
    this.display = { aspect: display.widescreen ? [16, 9] : [4, 3], window: !!display.window,
      scale: display.scale ?? 1, msaa: display.msaa ?? 1 };
    const [sx, sy] = this.display.window ? [1, 1] : scaleFor(this.display, 0, 0);
    this.enc = new GpEncoder(device, features, { sx, sy, msaa: this.display.msaa, window: this.display.window });
    this.winScale = { want: null, same: 0 };
    this.onError = onError ?? ((m) => console.warn(m));
    this.stats = { frames: 0, presented: 0, cpuFrames: 0, copyMs: 0, encodeMs: 0, errors: 0, lastDraws: 0, shown: '',
      vtxBytes: 0, idxBytes: 0, constBytes: 0, queueBytes: 0 };
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.canvas = canvas;
    const module = device.createShaderModule({ code: BLIT_WGSL });
    this.blit = device.createRenderPipeline({ layout: 'auto',
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' } });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.cpuTex = null;
    this.groups = new WeakMap();
    device.addEventListener('uncapturederror', (e) => {
      this.stats.errors++;
      if (this.stats.errors <= 20) this.onError(`WebGPU: ${e.error.message}`);
    });
    this.running = true;
    this.lastDisp = -1;
    this.frameLoop();
  }

  // ---- frames --------------------------------------------------------------
  async frameLoop() {
    const i = this.i32, at = Host.at;
    Atomics.store(i, at.page_attached, 1);
    let seen = Atomics.load(i, at.gp_seq);
    while (this.running) {
      const seq = Atomics.load(i, at.gp_seq);
      if (seq === seen) {
        const w = Atomics.waitAsync(i, at.gp_seq, seq, 500);
        if (w.async) await w.value;
        continue;
      }
      seen = seq;
      const t0 = performance.now();
      // Stage the frame straight out of wasm memory (no copies: writeBuffer
      // and writeTexture copy at the call), then let the recorder go on, then
      // encode the draws.
      let frame, staged;
      try {
        frame = this.frameViews(i[at.gp_frame] >>> 0);
        staged = this.enc.stage(frame);
      } catch (e) { this.stats.errors++; if (this.stats.errors <= 20) this.onError(`frame stage: ${e.message}`); }
      Atomics.store(i, at.gp_claimed, seq);
      Atomics.notify(i, at.gp_claimed);
      const t1 = performance.now();
      if (staged) {
        try { this.enc.encode(staged); } catch (e) { this.stats.errors++; if (this.stats.errors <= 20) this.onError(`encoder: ${e.message}`); }
        this.stats.frames++; this.stats.lastDraws = frame.drawCount;
        this.stats.vtxBytes += frame.vtx.byteLength; this.stats.idxBytes += frame.idx.byteLength;
        this.stats.constBytes += frame.consts.byteLength; this.stats.queueBytes += frame.queue.byteLength;
      }
      this.stats.copyMs += t1 - t0; this.stats.encodeMs += performance.now() - t1;
    }
  }

  /** The GpFrame's arenas as views into wasm memory (valid until claimed). */
  frameViews(ptr) {
    const u = new Uint32Array(this.memory.buffer, ptr, GpFrame.words), a = GpFrame.at;
    const buf = this.memory.buffer;
    const take = (p, n) => new Uint8Array(buf, p >>> 0, n);
    return {
      frame: u[a.frame], drawCount: u[a.draw_count],
      queue: take(u[a.queue], u[a.queue_bytes]),
      draws: take(u[a.draws], u[a.draw_count] * P.GpDraw.size),
      vtx: take(u[a.vtx], u[a.vtx_bytes]),
      idx: take(u[a.idx], u[a.idx_count] * 4),
      consts: take(u[a.consts], u[a.const_bytes]),
    };
  }

  // ---- display -------------------------------------------------------------
  /** The texture view to show now, or null. */
  source() {
    const i = this.i32, at = Host.at;
    const va = i[at.disp_va] >>> 0;
    if (i[at.disp_cpu]) {
      const w = i[at.disp_w], h = i[at.disp_h], ptr = i[at.cpu_fb] >>> 0;
      if (!this.cpuTex || this.cpuTex.width !== w || this.cpuTex.height !== h)
        this.cpuTex = this.dev.createTexture({ size: [w, h], format: 'bgra8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      const px = new Uint8Array(this.memory.buffer).slice(ptr, ptr + w * h * 4);
      this.dev.queue.writeTexture({ texture: this.cpuTex }, px, { bytesPerRow: w * 4 }, [w, h]);
      this.stats.cpuFrames++; this.stats.shown = `cpu fb ${va.toString(16)}`;
      return this.cpuTex;
    }
    if (!va) return null;
    // The encoder's render target for that guest address (physical match:
    // the same 64 MiB of RAM is seen through more than one VA window).
    let best = null;
    for (const [id, r] of this.enc.res) {
      if (r.kind !== 'rt') continue;
      if (r.va === va || ((r.va ^ va) & 0x03ffffff) === 0) { if (!best || !r.swz) best = { id, r }; }
    }
    if (!best) { this.stats.shown = `no RT for ${va.toString(16)}`; return null; }
    this.stats.shown = `rt ${best.id} ${best.r.w}x${best.r.h}` +
      (best.r.sw && (best.r.sw !== best.r.w || best.r.sh !== best.r.h) ? ` drawn ${best.r.sw}x${best.r.sh}` : '') +
      ` @${va.toString(16)}`;
    return best.r.texture;
  }

  /** Called on every animation frame. */
  draw() {
    const i = this.i32, at = Host.at;
    const d = Atomics.load(i, at.disp_seq);
    if (d === this.lastDisp) return;
    this.lastDisp = d;
    const tex = this.source();
    if (!tex) return;
    const cv = this.canvas, cw = cv.width, ch = cv.height, [aw, ah] = this.display.aspect;
    let w = cw, h = Math.round(cw * ah / aw);
    if (h > ch) { h = ch; w = Math.round(ch * aw / ah); }
    if (this.display.window) {
      // "window": the encoder's scale follows the picture's size on the
      // canvas, once a size has held for 20 frames (a resize drag does not
      // rebuild every target on each step).
      const [sx, sy] = scaleFor(this.display, cw, ch), ws = this.winScale;
      if (!ws.want || ws.want[0] !== sx || ws.want[1] !== sy) { ws.want = [sx, sy]; ws.same = 0; }
      else if (++ws.same === 20) this.enc.setScale(sx, sy);
    }
    let g = this.groups.get(tex);
    if (!g) {
      g = this.dev.createBindGroup({ layout: this.blit.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: this.sampler }] });
      this.groups.set(tex, g);
    }
    const e = this.dev.createCommandEncoder();
    const pass = e.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(),
      loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setViewport((cw - w) / 2, (ch - h) / 2, w, h, 0, 1);
    pass.setPipeline(this.blit); pass.setBindGroup(0, g); pass.draw(3);
    pass.end();
    this.dev.queue.submit([e.finish()]);
    this.stats.presented++;
  }

  /** A PNG of what the canvas shows (tests). */
  async snapshot() {
    const tex = this.source();
    if (!tex) return null;
    const w = tex.width, h = tex.height, bpr = (w * 4 + 255) & ~255;
    const buf = this.dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = this.dev.createCommandEncoder();
    e.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    this.dev.queue.submit([e.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const c = new OffscreenCanvas(w, h), cx = c.getContext('2d'), img = cx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = y * bpr + x * 4, d = (y * w + x) * 4;
      img.data[d] = src[s + 2]; img.data[d + 1] = src[s + 1]; img.data[d + 2] = src[s]; img.data[d + 3] = 255;
    }
    buf.unmap(); buf.destroy();
    cx.putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
}
