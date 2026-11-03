// The WebGPU drawing side: consumes the same frame packets (gpu_proto.h) as
// src/gpu/gpu_d3d11.c, rule for rule, so the two pictures can be diffed.
//
//   const enc = new GpEncoder(device, features);
//   enc.consume(frame);            // frame = parseCapture(...) or, in the
//                                  // wasm build, views into wasm memory
//   const px = await enc.readTarget(id);
//
// Drain the resource queue in order (render targets, depth, textures, WGSL
// shaders), then draw the records in order. What differs from D3D11 and why:
//   - constants: one uniform arena per frame, repacked to 256-byte slots and
//     bound with dynamic offsets (D3D11 maps a cbuffer per draw);
//   - a target or depth change, or a clear, starts a new render pass (clears
//     are pass load ops; D3D11 clears views directly);
//   - no BORDER address mode: GpWgslSmp at group 0 binding 3, see the WGSL;
//   - no depth-clip-disable: not needed, z is saturated in the VS;
//   - pipelines (blend/depth/stencil/write mask are baked) are cached by key;
//     nfsu2-web additionally prewarms them with createRenderPipelineAsync.
import * as P from './proto.js';
import { makeLayouts, UNIFORM_SLOTS, vertexLayout, cubeMaskOf } from './layout.js';

const BLEND_FACTOR = {
  0x0000: ['zero', 'zero'], 0x0001: ['one', 'one'],
  0x0300: ['src', 'src-alpha'], 0x0301: ['one-minus-src', 'one-minus-src-alpha'],
  0x0302: ['src-alpha', 'src-alpha'], 0x0303: ['one-minus-src-alpha', 'one-minus-src-alpha'],
  0x0304: ['dst-alpha', 'dst-alpha'], 0x0305: ['one-minus-dst-alpha', 'one-minus-dst-alpha'],
  0x0306: ['dst', 'dst-alpha'], 0x0307: ['one-minus-dst', 'one-minus-dst-alpha'],
  0x0308: ['src-alpha-saturated', 'src-alpha-saturated'],
  0x8001: ['constant', 'constant'], 0x8003: ['constant', 'constant'],
  0x8002: ['one-minus-constant', 'one-minus-constant'], 0x8004: ['one-minus-constant', 'one-minus-constant'],
};
const BLEND_OP = { 0x800A: 'subtract', 0x800B: 'reverse-subtract', 0x8007: 'min', 0x8008: 'max' };
const CMP = { 0x200: 'never', 0x201: 'less', 0x202: 'equal', 0x203: 'less-equal',
  0x204: 'greater', 0x205: 'not-equal', 0x206: 'greater-equal' };
const STENCIL_OP = { 0x0000: 'zero', 0x1E01: 'replace', 0x1E02: 'increment-clamp',
  0x1E03: 'decrement-clamp', 0x150A: 'invert', 0x8507: 'increment-wrap', 0x8508: 'decrement-wrap' };
const ADDR = { 1: 'repeat', 2: 'mirror-repeat' };

const unpack = (c) => [((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255, (c >>> 24) / 255];

/** A GpDraw record as an object (field names as in the C struct). */
function readDraw(dv, at) {
  const o = P.GpDraw.off, s = P.GpState.off, u = (off) => dv.getUint32(at + off, true);
  const arr = (off) => [0, 1, 2, 3].map((i) => u(off + 4 * i));
  const st = {};
  for (const k of Object.keys(s)) st[k] = u(o.st + s[k]);
  const d = { st, tex: arr(o.tex), smp: arr(o.smp), border: arr(o.border) };
  for (const k of ['kind', 'target', 'target_swz', 'zeta', 'zeta_format', 'vs', 'ps', 'vtx_off',
    'vtx_count', 'vtx_stride', 'idx_off', 'idx_count', 'vsc_off', 'xfc_off', 'psc_off',
    'clr_flags', 'clr_argb', 'clr_zs']) d[k] = u(o[k]);
  return d;
}

export class GpEncoder {
  constructor(device, features = []) {
    this.dev = device;
    this.L = makeLayouts(device);
    this.bc = features.includes('texture-compression-bc');
    this.dsFormat = features.includes('depth32float-stencil8') ? 'depth32float-stencil8' : 'depth24plus-stencil8';
    this.res = new Map();      // id -> { kind: 'rt'|'ds'|'tex', texture, view, ... }
    this.vsMods = new Map();   // id -> { module }   (built-ins 1, 2 share ids with
    this.psMods = new Map();   // id -> { module, cube }  PS 1: separate maps)
    this.pipes = new Map();
    this.samplers = new Map();
    this.bufs = {};
    this.stats = { draws: 0, clears: 0, skipped: 0, passes: 0, pipelines: 0, noBC: 0, reasons: {} };
    const z = (cube) => device.createTexture({ size: [1, 1, cube ? 6 : 1], format: 'bgra8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING });     // zero-initialised: reads 0, as a NULL SRV
    this.dummy2d = z(false).createView();
    this.dummyCube = z(true).createView({ dimension: 'cube' });
  }

  skip(why) { this.stats.skipped++; this.stats.reasons[why] = (this.stats.reasons[why] ?? 0) + 1; }

  // ---- resource queue ------------------------------------------------------

  drainQueue(q) {
    const dv = new DataView(q.buffer, q.byteOffset, q.byteLength);
    const dec = new TextDecoder();
    for (let off = 0; off + P.GpCmd.size <= q.byteLength;) {
      const u = (k) => dv.getUint32(off + P.GpCmd.off[k], true);
      const c = { op: u('op'), id: u('id'), a: u('a'), b: u('b'), c: u('c'), d: u('d'), e: u('e'), bytes: u('bytes') };
      const payload = q.subarray(off + P.GpCmd.size, off + P.GpCmd.size + c.bytes);
      switch (c.op) {
        case P.GP_RT_CREATE: this.rtCreate(c, payload); break;
        case P.GP_DS_CREATE: this.dsCreate(c); break;
        case P.GP_TEX_CREATE: this.texCreate(c, payload); break;
        case P.GP_TEX_FREE: this.free(c.id); break;
        case P.GP_SHADER_VS: case P.GP_SHADER_PS: {
          const code = dec.decode(payload.subarray(0, Math.max(0, c.bytes - 1)));
          const module = this.dev.createShaderModule({ label: `${c.op === P.GP_SHADER_VS ? 'vs' : 'ps'}_${c.id}`, code });
          if (c.op === P.GP_SHADER_VS) this.vsMods.set(c.id, { module });
          else this.psMods.set(c.id, { module, cube: cubeMaskOf(code) });
          break;
        }
        default: break;
      }
      off += P.GpCmd.size + ((c.bytes + 15) & ~15);
    }
  }

  free(id) {
    const r = this.res.get(id);
    if (r?.texture) r.texture.destroy();
    this.res.delete(id);
  }

  rtCreate(c, payload) {
    this.free(c.id);
    const texture = this.dev.createTexture({ label: `rt_${c.id}`, size: [c.b, c.c], format: 'bgra8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
           | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    if (c.bytes) this.dev.queue.writeTexture({ texture }, payload, { bytesPerRow: c.b * 4 }, [c.b, c.c]);
    this.res.set(c.id, { kind: 'rt', texture, view: texture.createView(), w: c.b, h: c.c, va: c.a,
      bpp: c.d & 255, fmt: (c.d >> 8) & 255, swz: (c.d >> 16) & 1, pitch: c.e, dirty: false });
  }

  dsCreate(c) {
    this.free(c.id);
    const texture = this.dev.createTexture({ label: `ds_${c.id}`, size: [c.b, c.c], format: this.dsFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.res.set(c.id, { kind: 'ds', texture, view: texture.createView(), w: c.b, h: c.c });
  }

  texCreate(c, payload) {
    this.free(c.id);
    const faces = c.e || 1, w = c.b, h = c.c;
    let format = 'bgra8unorm', bytesPerRow = w * 4, rows = h;
    if (c.d !== P.GP_FMT_BGRA8) {
      if (!this.bc) { this.stats.noBC++; return; }   // ponytail: CPU BC decode for adapters without BC
      format = { [P.GP_FMT_BC1]: 'bc1-rgba-unorm', [P.GP_FMT_BC2]: 'bc2-rgba-unorm', [P.GP_FMT_BC3]: 'bc3-rgba-unorm' }[c.d];
      bytesPerRow = (w / 4) * (c.d === P.GP_FMT_BC1 ? 8 : 16);
      rows = h / 4;
    }
    const texture = this.dev.createTexture({ label: `tex_${c.id}`, size: [w, h, faces], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const faceBytes = c.bytes / faces;
    for (let f = 0; f < faces; f++)
      this.dev.queue.writeTexture({ texture, origin: [0, 0, f] },
        payload.subarray(f * faceBytes, (f + 1) * faceBytes), { bytesPerRow, rowsPerImage: rows }, [w, h, 1]);
    this.res.set(c.id, { kind: 'tex', texture, cube: faces === 6, w, h,
      view: texture.createView({ dimension: faces === 6 ? 'cube' : '2d' }) });
  }

  // ---- per-frame buffers ---------------------------------------------------

  buffer(name, bytes, usage) {
    let b = this.bufs[name];
    if (!b || b.size < bytes) {
      b?.destroy();
      b = this.bufs[name] = this.dev.createBuffer({ label: name, size: Math.max(1 << 16, bytes * 1.5 + 255 & ~255),
        usage: usage | GPUBufferUsage.COPY_DST });
      if (name === 'uniforms') this.group0 = null;
    }
    return b;
  }

  /** Repack the constant blocks the draws use into 256-aligned slots. */
  packUniforms(frame, draws) {
    const slots = [];
    let size = 3072;                       // offset 0: zeros, the "no block" slot for every binding
    const vscSeen = new Map();
    const take = (stride) => { const at = size; size += stride; return at; };
    for (const d of draws) {
      if (d.kind !== P.GP_DRAW) continue;
      const s = { xf: 0, vsc: 0, ps: 0, smp: 0 };
      if (d.xfc_off !== 0xFFFFFFFF) s.xf = take(UNIFORM_SLOTS[0].stride);
      if (d.vsc_off !== 0xFFFFFFFF) {
        if (!vscSeen.has(d.vsc_off)) vscSeen.set(d.vsc_off, take(UNIFORM_SLOTS[1].stride));
        s.vsc = vscSeen.get(d.vsc_off);
      }
      if (d.psc_off !== 0xFFFFFFFF) s.ps = take(UNIFORM_SLOTS[2].stride);
      s.smp = take(UNIFORM_SLOTS[3].stride);
      d.slots = s;
      slots.push(d);
    }
    const arena = new Uint8Array(size);
    const c = frame.consts;
    for (const d of slots) {
      const s = d.slots;
      if (s.xf) arena.set(c.subarray(d.xfc_off, d.xfc_off + (d.vs === P.GP_VS_TVERT ? P.GpTvConsts.size : P.GpXfConsts.size)), s.xf);
      if (s.ps) arena.set(c.subarray(d.psc_off, d.psc_off + P.GpPsConsts.size), s.ps);
      if (s.vsc) arena.set(c.subarray(d.vsc_off, d.vsc_off + P.GpVsConsts.size), s.vsc);
      // GpWgslSmp: border colours and which axes are BORDER.
      const f = new Float32Array(arena.buffer, s.smp, 16), fl = new Uint32Array(arena.buffer, s.smp + 64, 4);
      for (let st = 0; st < 4; st++) {
        f.set(unpack(d.border[st]), st * 4);
        const k = d.smp[st];
        if (k & P.GP_SMP_BORDER) fl[st] = (((k >> 4) & 15) === 4 ? 1 : 0) | (((k >> 8) & 15) === 4 ? 2 : 0);
      }
    }
    const buf = this.buffer('uniforms', size, GPUBufferUsage.UNIFORM);
    this.dev.queue.writeBuffer(buf, 0, arena);
    if (!this.group0)
      this.group0 = this.dev.createBindGroup({ layout: this.L.group0, entries: UNIFORM_SLOTS.map((u) =>
        ({ binding: u.binding, resource: { buffer: buf, offset: 0, size: u.size } })) });
  }

  // ---- state ---------------------------------------------------------------

  sampler(key) {
    if (!this.samplers.has(key)) {
      const lin = key & P.GP_SMP_LINEAR ? 'linear' : 'nearest';
      this.samplers.set(key, this.dev.createSampler({ magFilter: lin, minFilter: lin,
        addressModeU: ADDR[(key >> 4) & 15] ?? 'clamp-to-edge', addressModeV: ADDR[(key >> 8) & 15] ?? 'clamp-to-edge',
        addressModeW: 'clamp-to-edge', lodMaxClamp: 0 }));
    }
    return this.samplers.get(key);
  }

  pipeline(d, kind, vs, ps, cube, hasDs) {
    const st = d.st, m = st.color_mask;
    const writeMask = (m & 0x00010000 ? 1 : 0) | (m & 0x00000100 ? 2 : 0) | (m & 0x00000001 ? 4 : 0) | (m & 0x01000000 ? 8 : 0);
    const dt = hasDs && st.depth_test, dw = dt && st.depth_write, sten = hasDs && st.stencil_en;
    const key = [d.vs, d.ps, kind, cube, st.blend_en ? 1 : 0, st.blend_src, st.blend_dst, st.blend_eq, writeMask,
      hasDs ? 1 : 0, dt ? 1 : 0, dw ? 1 : 0, st.depth_func, sten ? [st.stencil_func, st.stencil_fmask & 255,
        st.stencil_wmask & 255, st.stencil_fail, st.stencil_zfail, st.stencil_zpass].join(',') : '-'].join('|');
    let p = this.pipes.get(key);
    if (p) return p;
    let blend;
    if (st.blend_en) {
      const op = BLEND_OP[st.blend_eq] ?? 'add', minmax = op === 'min' || op === 'max';
      const f = (x, a) => (minmax ? 'one' : (BLEND_FACTOR[x] ?? ['one', 'one'])[a]);
      blend = { color: { operation: op, srcFactor: f(st.blend_src, 0), dstFactor: f(st.blend_dst, 0) },
        alpha: { operation: op, srcFactor: f(st.blend_src, 1), dstFactor: f(st.blend_dst, 1) } };
    }
    const face = sten ? { compare: CMP[st.stencil_func] ?? 'always', failOp: STENCIL_OP[st.stencil_fail] ?? 'keep',
      depthFailOp: STENCIL_OP[st.stencil_zfail] ?? 'keep', passOp: STENCIL_OP[st.stencil_zpass] ?? 'keep' } : {};
    p = this.dev.createRenderPipeline({
      label: key,
      layout: this.L.pipelineLayout(cube),
      vertex: { module: vs, entryPoint: 'main', buffers: vertexLayout(kind) },
      fragment: { module: ps, entryPoint: 'main', targets: [{ format: 'bgra8unorm', blend, writeMask }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: hasDs ? { format: this.dsFormat, depthWriteEnabled: !!dw,
        depthCompare: dt ? CMP[st.depth_func] ?? 'always' : 'always',
        stencilFront: face, stencilBack: face,
        stencilReadMask: sten ? st.stencil_fmask & 255 : 0xFF, stencilWriteMask: sten ? st.stencil_wmask & 255 : 0 } : undefined,
    });
    this.pipes.set(key, p);
    this.stats.pipelines++;
    return p;
  }

  // ---- passes --------------------------------------------------------------

  endPass() { if (this.pass) { this.pass.end(); this.pass = null; } }

  beginPass(rt, ds, clear = {}) {
    this.endPass();
    const desc = { colorAttachments: [{ view: rt.view, storeOp: 'store',
      loadOp: clear.color ? 'clear' : 'load', clearValue: clear.color ?? [0, 0, 0, 0] }] };
    if (ds) desc.depthStencilAttachment = { view: ds.view,
      depthLoadOp: clear.depth !== undefined ? 'clear' : 'load', depthClearValue: clear.depth ?? 1, depthStoreOp: 'store',
      stencilLoadOp: clear.stencil !== undefined ? 'clear' : 'load', stencilClearValue: clear.stencil ?? 0, stencilStoreOp: 'store' };
    this.pass = this.enc.beginRenderPass(desc);
    this.pass.setViewport(0, 0, rt.w, rt.h, 0, 1);
    this.stats.passes++;
  }

  /** bind_target() in gpu_d3d11.c: same target and depth keep the pass. */
  bindTarget(d) {
    const rt = this.res.get(d.target);
    if (!rt || rt.kind !== 'rt') return null;
    rt.swz = d.target_swz;
    let ds = d.zeta ? this.res.get(d.zeta) : null;
    if (ds && ds.kind !== 'ds') ds = null;
    if (ds && (ds.w !== rt.w || ds.h !== rt.h)) ds = null;  // WebGPU wants equal sizes: Z off
    const zeta = ds ? d.zeta : 0;
    if (!this.pass || this.curTarget !== d.target || this.curZeta !== zeta) {
      this.beginPass(rt, ds);
      this.curTarget = d.target; this.curZeta = zeta;
    }
    rt.dirty = true;
    return { rt, ds };
  }

  doClear(d) {
    const rt = this.res.get(d.target);
    if (!rt || rt.kind !== 'rt') return this.skip('clear: no target');
    let ds = d.zeta ? this.res.get(d.zeta) : null;
    if (ds && (ds.kind !== 'ds' || ds.w !== rt.w || ds.h !== rt.h)) ds = null;
    const clear = {};
    if (d.clr_flags & 0xF0) clear.color = unpack(d.clr_argb);
    if (ds && (d.clr_flags & 1))
      clear.depth = d.zeta_format === 1 ? (d.clr_zs & 0xFFFF) / 65535 : (d.clr_zs >>> 8) / 16777215;
    if (ds && (d.clr_flags & 2)) clear.stencil = d.clr_zs & 0xFF;
    this.beginPass(rt, ds, clear);
    this.curTarget = d.target; this.curZeta = ds ? d.zeta : 0;
    rt.dirty = true;
    this.stats.clears++;
  }

  doDraw(d) {
    let kind, vs, ps;
    if (d.vs === P.GP_VS_TVERT) { kind = 'tvert'; vs = this.vsMods.get(P.GP_VS_TVERT); }
    else if (d.vs === P.GP_VS_PASSTHRU) { kind = 'passthru'; vs = this.vsMods.get(P.GP_VS_PASSTHRU); }
    else { kind = 'program'; vs = this.vsMods.get(d.vs); }
    ps = this.psMods.get(d.ps === P.GP_PS_TVERT ? P.GP_PS_TVERT : d.ps);
    if (!vs) return this.skip('no vs');
    if (!ps) return this.skip('no ps');
    if (!d.vtx_count) return this.skip('no vertices');
    const t = this.bindTarget(d);
    if (!t) return this.skip('no target');

    const cube = ps.cube ?? 0, entries = [];
    for (let st = 0; st < 4; st++) {
      let id = d.tex[st], view = null;
      if (id) {
        if (id & P.GP_TEX_RT) { id = (id & ~P.GP_TEX_RT) >>> 0; if (id === d.target) id = 0; }
        const r = id && this.res.get(id);
        if (r && r.kind !== 'ds' && !!r.cube === !!((cube >> st) & 1)) view = r.view;
      }
      entries.push({ binding: st, resource: view ?? ((cube >> st) & 1 ? this.dummyCube : this.dummy2d) });
      entries.push({ binding: 4 + st, resource: this.sampler(view ? d.smp[st] & 0xFFF : 0) });
    }
    const g1 = this.dev.createBindGroup({ layout: this.L.group1(cube), entries });
    const pass = this.pass;
    pass.setPipeline(this.pipeline(d, kind, vs.module, ps.module, cube, !!t.ds));
    pass.setBindGroup(0, this.group0, [d.slots.xf, d.slots.vsc, d.slots.ps, d.slots.smp]);
    pass.setBindGroup(1, g1);
    const bc = unpack(d.st.blend_color);
    if ([d.st.blend_src, d.st.blend_dst].some((x) => x === 0x8003 || x === 0x8004)) bc.fill(bc[3], 0, 3);
    pass.setBlendConstant(bc);
    if (t.ds) pass.setStencilReference(d.st.stencil_ref & 0xFF);
    pass.setVertexBuffer(0, this.bufs.vtx, d.vtx_off, d.vtx_count * d.vtx_stride);
    if (d.idx_count) {
      pass.setIndexBuffer(this.bufs.idx, 'uint32', d.idx_off * 4, d.idx_count * 4);
      pass.drawIndexed(d.idx_count);
    } else {
      pass.draw(d.vtx_count);
    }
    this.stats.draws++;
  }

  // ---- a frame -------------------------------------------------------------

  consume(frame) {
    this.drainQueue(frame.queue);
    const dv = new DataView(frame.draws.buffer, frame.draws.byteOffset, frame.draws.byteLength);
    const draws = [];
    for (let i = 0; i < frame.drawCount; i++) draws.push(readDraw(dv, i * P.GpDraw.size));
    const vbuf = this.buffer('vtx', frame.vtx.byteLength + 4, GPUBufferUsage.VERTEX);
    this.dev.queue.writeBuffer(vbuf, 0, frame.vtx);
    const ibuf = this.buffer('idx', frame.idx.byteLength + 4, GPUBufferUsage.INDEX);
    if (frame.idx.byteLength) this.dev.queue.writeBuffer(ibuf, 0, frame.idx);
    this.packUniforms(frame, draws);
    this.enc = this.dev.createCommandEncoder();
    this.pass = null; this.curTarget = this.curZeta = -1;
    for (const d of draws) {
      if (d.kind === P.GP_CLEAR) this.doClear(d);
      else if (d.kind === P.GP_DRAW) this.doDraw(d);
      else this.skip('kind');
    }
    this.endPass();
    this.dev.queue.submit([this.enc.finish()]);
    this.enc = null;
    // The writeback of linear dirty targets into guest memory goes here in
    // the wasm build (copyTextureToBuffer + mapAsync, as readTarget below).
  }

  /** A render target's pixels, BGRA8, tightly packed. */
  async readTarget(id) {
    const r = this.res.get(id);
    if (!r || r.kind !== 'rt') return null;
    const bpr = (r.w * 4 + 255) & ~255;
    const buf = this.dev.createBuffer({ size: bpr * r.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: r.texture }, { buffer: buf, bytesPerRow: bpr }, [r.w, r.h]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange()), out = new Uint8Array(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) out.set(src.subarray(y * bpr, y * bpr + r.w * 4), y * r.w * 4);
    buf.unmap(); buf.destroy();
    return { w: r.w, h: r.h, px: out };
  }
}
