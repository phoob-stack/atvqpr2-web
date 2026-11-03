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
import { makeLayouts, UNIFORM_SLOTS, vertexLayout, cubeMaskOf, inputMaskOf } from './layout.js';

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

// GpDraw.rect (x0 | y0 << 16, x1 | y1 << 16) within the target: the window
// clip of a draw, the area of a clear. Split screen draws each player's view
// into its own part of one target. full: it covers the target.
function rectOf(d, rt) {
  const x0 = d.rect[0] & 0xFFFF, y0 = d.rect[0] >>> 16;
  const x1 = Math.min(d.rect[1] & 0xFFFF, rt.w), y1 = Math.min(d.rect[1] >>> 16, rt.h);
  if (!d.rect[1] || (x0 <= 0 && y0 <= 0 && x1 >= rt.w && y1 >= rt.h)) return { x: 0, y: 0, w: rt.w, h: rt.h, full: true };
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), full: false };
}

// A clear of part of a target: a triangle over the target, cut to the rect by
// the scissor, writing the clear colour and depth (one 256-byte uniform slot
// per such clear in a frame).
const CLEAR_WGSL = `struct C { col: vec4f, z: f32 };
@group(0) @binding(0) var<uniform> c: C;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), c.z, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return c.col; }`;
const CLEAR_SLOTS = 64;

const unpack = (c) => [((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255, (c >>> 24) / 255];

// GpDraw / GpState field offsets in words.
const DW = P.GpDraw.size / 4;
const DO = Object.fromEntries(Object.entries(P.GpDraw.off).map(([k, v]) => [k, v / 4]));
const SO = Object.fromEntries(Object.entries(P.GpState.off).map(([k, v]) => [k, DO.st + v / 4]));

/** The draw records as objects (field names as in the C struct). `bytes`
 * may be a view into the shared wasm memory: everything is read here. */
function readDraws(bytes, n) {
  const u = (bytes.byteOffset & 3) === 0
    ? new Uint32Array(bytes.buffer, bytes.byteOffset, n * DW) : new Uint32Array(bytes.slice(0, n * DW * 4).buffer);
  const out = new Array(n);
  for (let i = 0, b = 0; i < n; i++, b += DW) {
    const st = {
      blend_en: u[b + SO.blend_en], blend_src: u[b + SO.blend_src], blend_dst: u[b + SO.blend_dst],
      blend_eq: u[b + SO.blend_eq], blend_color: u[b + SO.blend_color], color_mask: u[b + SO.color_mask],
      depth_test: u[b + SO.depth_test], depth_func: u[b + SO.depth_func], depth_write: u[b + SO.depth_write],
      stencil_en: u[b + SO.stencil_en], stencil_func: u[b + SO.stencil_func], stencil_ref: u[b + SO.stencil_ref],
      stencil_fmask: u[b + SO.stencil_fmask], stencil_wmask: u[b + SO.stencil_wmask],
      stencil_fail: u[b + SO.stencil_fail], stencil_zfail: u[b + SO.stencil_zfail], stencil_zpass: u[b + SO.stencil_zpass],
    };
    const t = b + DO.tex, m = b + DO.smp, r = b + DO.border;
    out[i] = { st, kind: u[b + DO.kind], target: u[b + DO.target], target_swz: u[b + DO.target_swz],
      zeta: u[b + DO.zeta], zeta_format: u[b + DO.zeta_format], vs: u[b + DO.vs], ps: u[b + DO.ps],
      tex: [u[t], u[t + 1], u[t + 2], u[t + 3]], smp: [u[m], u[m + 1], u[m + 2], u[m + 3]],
      border: [u[r], u[r + 1], u[r + 2], u[r + 3]],
      vtx_off: u[b + DO.vtx_off], vtx_count: u[b + DO.vtx_count], vtx_stride: u[b + DO.vtx_stride],
      idx_off: u[b + DO.idx_off], idx_count: u[b + DO.idx_count], vsc_off: u[b + DO.vsc_off],
      xfc_off: u[b + DO.xfc_off], psc_off: u[b + DO.psc_off],
      clr_flags: u[b + DO.clr_flags], clr_argb: u[b + DO.clr_argb], clr_zs: u[b + DO.clr_zs],
      rect: [u[b + DO.rect], u[b + DO.rect + 1]], slots: null };
  }
  return out;
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
    this.serial = 0;           // every resource gets a new one: the bind-group cache key
    this.groups1 = new Map();  // cube|view serials|sampler keys -> group 1
    this.arena = new Uint8Array(1 << 16);
    this.noMips = false;     // true: level 0 only (RECOMP_GPU_NO_MIPS)
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
        case P.GP_SUB_CREATE: this.subCreate(c); break;
        case P.GP_TEX_CREATE: this.texCreate(c, payload); break;
        case P.GP_TEX_FREE: this.free(c.id); break;
        case P.GP_SHADER_VS: case P.GP_SHADER_PS: {
          const code = dec.decode(payload.slice(0, Math.max(0, c.bytes - 1)));   // slice: not shared
          const module = this.dev.createShaderModule({ label: `${c.op === P.GP_SHADER_VS ? 'vs' : 'ps'}_${c.id}`, code });
          if (c.op === P.GP_SHADER_VS) this.vsMods.set(c.id, { module, inputs: inputMaskOf(code) });
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
    this.res.set(c.id, { kind: 'rt', serial: ++this.serial, texture, view: texture.createView(), w: c.b, h: c.c, va: c.a,
      bpp: c.d & 255, fmt: (c.d >> 8) & 255, swz: (c.d >> 16) & 1, pitch: c.e, dirty: false });
  }

  dsCreate(c) {
    this.free(c.id);
    const texture = this.dev.createTexture({ label: `ds_${c.id}`, size: [c.b, c.c], format: this.dsFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.res.set(c.id, { kind: 'ds', serial: ++this.serial, texture, view: texture.createView(), w: c.b, h: c.c });
  }

  /** GP_TEX_CREATE: a = mip levels; payload per face its levels in order,
   * each tightly packed (BC levels below 4x4 still take a whole block). */
  texCreate(c, payload) {
    this.free(c.id);
    const faces = c.e || 1, w = c.b, h = c.c;
    let format = 'bgra8unorm', bb = 0;
    if (c.d !== P.GP_FMT_BGRA8) {
      if (!this.bc) { this.stats.noBC++; return; }   // ponytail: CPU BC decode for adapters without BC
      format = { [P.GP_FMT_BC1]: 'bc1-rgba-unorm', [P.GP_FMT_BC2]: 'bc2-rgba-unorm', [P.GP_FMT_BC3]: 'bc3-rgba-unorm' }[c.d];
      bb = c.d === P.GP_FMT_BC1 ? 8 : 16;
    }
    const levels = Math.min(c.a || 1, Math.floor(Math.log2(Math.max(w, h))) + 1);
    const texture = this.dev.createTexture({ label: `tex_${c.id}`, size: [w, h, faces], format,
      mipLevelCount: levels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    let at = 0;
    for (let f = 0; f < faces; f++)
      for (let l = 0; l < levels; l++) {
        const lw = Math.max(1, w >> l), lh = Math.max(1, h >> l);
        const bytesPerRow = bb ? ((lw + 3) >> 2) * bb : lw * 4, rows = bb ? (lh + 3) >> 2 : lh;
        const n = bytesPerRow * rows;
        if (at + n > payload.byteLength) break;
        this.dev.queue.writeTexture({ texture, mipLevel: l, origin: [0, 0, f] }, payload.subarray(at, at + n),
          { bytesPerRow, rowsPerImage: rows }, [bb ? (lw + 3) & ~3 : lw, bb ? (lh + 3) & ~3 : lh, 1]);
        at += n;
      }
    this.res.set(c.id, { kind: 'tex', serial: ++this.serial, texture, cube: faces === 6, w, h,
      view: texture.createView({ dimension: faces === 6 ? 'cube' : '2d' }) });
  }

  /** GP_SUB_CREATE: a tile of a render target, copied out of it before
   * every draw that samples it. */
  subCreate(c) {
    this.free(c.id);
    const texture = this.dev.createTexture({ label: `sub_${c.id}`, size: [c.b, c.c], format: 'bgra8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.res.set(c.id, { kind: 'sub', serial: ++this.serial, texture, view: texture.createView(), w: c.b, h: c.c,
      src: c.a, x0: c.d & 0xFFFF, y0: c.d >>> 16 });
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
    // One arena, reused frame to frame (the slots below 3072 stay zero).
    if (this.arena.byteLength < size) this.arena = new Uint8Array(Math.max(size, this.arena.byteLength * 2));
    const arena = this.arena, af = new Float32Array(arena.buffer), au = new Uint32Array(arena.buffer);
    const c = frame.consts;
    for (const d of slots) {
      const s = d.slots;
      if (s.xf) arena.set(c.subarray(d.xfc_off, d.xfc_off + (d.vs === P.GP_VS_TVERT ? P.GpTvConsts.size : P.GpXfConsts.size)), s.xf);
      if (s.ps) arena.set(c.subarray(d.psc_off, d.psc_off + P.GpPsConsts.size), s.ps);
      if (s.vsc) arena.set(c.subarray(d.vsc_off, d.vsc_off + P.GpVsConsts.size), s.vsc);
      // GpWgslSmp: border colours (16 floats), which axes are BORDER (4 u32),
      // LOD bias (4 floats).
      const w = s.smp >> 2;
      for (let st = 0; st < 4; st++) {
        const bc = d.border[st], k = d.smp[st];
        af[w + st * 4] = ((bc >>> 16) & 255) / 255; af[w + st * 4 + 1] = ((bc >>> 8) & 255) / 255;
        af[w + st * 4 + 2] = (bc & 255) / 255; af[w + st * 4 + 3] = (bc >>> 24) / 255;
        au[w + 16 + st] = k & P.GP_SMP_BORDER ? (((k >> 4) & 15) === 4 ? 1 : 0) | (((k >> 8) & 15) === 4 ? 2 : 0) : 0;
        af[w + 20 + st] = this.filtered(k) ? P.GP_SMP_BIAS_OF(k) / 256 : 0;
      }
    }
    const buf = this.buffer('uniforms', size, GPUBufferUsage.UNIFORM);
    this.dev.queue.writeBuffer(buf, 0, arena, 0, size);
    if (!this.group0)
      this.group0 = this.dev.createBindGroup({ layout: this.L.group0, entries: UNIFORM_SLOTS.map((u) =>
        ({ binding: u.binding, resource: { buffer: buf, offset: 0, size: u.size } })) });
  }

  // ---- state ---------------------------------------------------------------

  filtered(key) { return (key & P.GP_SMP_FILTER) !== 0 && !this.noMips; }

  /** sampler() in gpu_d3d11.c. Without GP_SMP_FILTER: GP_SMP_LINEAR and level
   * 0. With it: SET_TEXTURE_FILTER's MIN (1 BOX_LOD0, 2 TENT_LOD0,
   * 3 BOX_NEARESTLOD, 4 TENT_NEARESTLOD, 5 BOX_TENT_LOD, 6 TENT_TENT_LOD) and
   * MAG (2 TENT). The LOD bias goes through GpWgslSmp (no sampler field). */
  sampler(key) {
    key = this.filtered(key) ? key & 0x00FF3FFF : key & 0xFFF;
    if (!this.samplers.has(key)) {
      const d = { addressModeU: ADDR[(key >> 4) & 15] ?? 'clamp-to-edge',
        addressModeV: ADDR[(key >> 8) & 15] ?? 'clamp-to-edge', addressModeW: 'clamp-to-edge' };
      if (key & P.GP_SMP_FILTER) {
        const mn = P.GP_SMP_MIN_OF(key), mg = P.GP_SMP_MAG_OF(key);
        Object.assign(d, { minFilter: [2, 4, 6].includes(mn) ? 'linear' : 'nearest',
          magFilter: mg === 2 ? 'linear' : 'nearest', mipmapFilter: mn === 5 || mn === 6 ? 'linear' : 'nearest',
          lodMaxClamp: mn >= 3 && mn <= 6 ? 32 : 0 });
      } else {
        const lin = key & P.GP_SMP_LINEAR ? 'linear' : 'nearest';
        Object.assign(d, { minFilter: lin, magFilter: lin, mipmapFilter: lin, lodMaxClamp: 0 });
      }
      this.samplers.set(key, this.dev.createSampler(d));
    }
    return this.samplers.get(key);
  }

  pipeline(d, kind, vs, ps, cube, hasDs) {
    const st = d.st, m = st.color_mask;
    const writeMask = (m & 0x00010000 ? 1 : 0) | (m & 0x00000100 ? 2 : 0) | (m & 0x00000001 ? 4 : 0) | (m & 0x01000000 ? 8 : 0);
    const dt = hasDs && st.depth_test, dw = dt && st.depth_write, sten = hasDs && st.stencil_en;
    const key = [d.vs, d.ps, kind, cube, d.vtx_stride, st.blend_en ? 1 : 0, st.blend_src, st.blend_dst, st.blend_eq, writeMask,
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
      vertex: { module: vs.module, entryPoint: 'main', buffers: vertexLayout(kind, vs.inputs, d.vtx_stride) },
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
    // What this pass has bound: set again only when it changes.
    this.bound = { pipe: null, g1: null, bc: -1, sref: -1, vb: -1, vbn: -1, ib: false, sc: 0 };
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

  /** A clear of part of the target, drawn inside the current pass. */
  clearRect(d, rc) {
    const t = this.bindTarget(d);
    if (!t) return this.skip('clear: no target');
    if (!this.clr) {
      const dev = this.dev, module = dev.createShaderModule({ label: 'clear_rect', code: CLEAR_WGSL });
      const bgl = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true } }] });
      const buf = dev.createBuffer({ label: 'clear_rect', size: CLEAR_SLOTS * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.clr = { module, layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }), buf,
        group: dev.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: buf, offset: 0, size: 32 } }] }),
        data: new Float32Array(8) };
    }
    if (this.clrSlot >= CLEAR_SLOTS) return this.skip('clear: too many partial clears');
    const f = d.clr_flags, hasDs = !!t.ds;
    const writeMask = (f & 0x10 ? 1 : 0) | (f & 0x20 ? 2 : 0) | (f & 0x40 ? 4 : 0) | (f & 0x80 ? 8 : 0);
    const dw = hasDs && (f & 1) !== 0, sten = hasDs && (f & 2) !== 0;
    const key = `clear|${hasDs ? 1 : 0}|${writeMask}|${dw ? 1 : 0}|${sten ? 1 : 0}`;
    let pipe = this.pipes.get(key);
    if (!pipe) {
      const face = sten ? { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' } : {};
      pipe = this.dev.createRenderPipeline({ label: key, layout: this.clr.layout,
        vertex: { module: this.clr.module, entryPoint: 'vs' },
        fragment: { module: this.clr.module, entryPoint: 'fs', targets: [{ format: 'bgra8unorm', writeMask }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: hasDs ? { format: this.dsFormat, depthWriteEnabled: dw, depthCompare: 'always',
          stencilFront: face, stencilBack: face, stencilReadMask: 0xFF, stencilWriteMask: sten ? 0xFF : 0 } : undefined });
      this.pipes.set(key, pipe);
    }
    const c = this.clr.data;
    c.set(unpack(d.clr_argb));
    c[4] = d.zeta_format === 1 ? (d.clr_zs & 0xFFFF) / 65535 : (d.clr_zs >>> 8) / 16777215;
    const off = this.clrSlot++ * 256;
    this.dev.queue.writeBuffer(this.clr.buf, off, c);
    const pass = this.pass, b = this.bound;
    pass.setPipeline(pipe); b.pipe = pipe;
    pass.setBindGroup(0, this.clr.group, [off]);
    b.g1 = null;
    if (hasDs && sten) { b.sref = d.clr_zs & 0xFF; pass.setStencilReference(b.sref); }
    this.scissor(rc);
    pass.draw(3);
    this.stats.clears++;
  }

  /** Scissor for the current pass (a pass starts with the whole target). */
  scissor(rc) {
    const k = rc.full ? 0 : rc.x + rc.y * 4096 + (rc.w + rc.h * 4096) * 16777216;
    if (k === this.bound.sc) return;
    this.pass.setScissorRect(rc.x, rc.y, rc.w, rc.h);
    this.bound.sc = k;
  }

  doClear(d) {
    const rt = this.res.get(d.target);
    if (!rt || rt.kind !== 'rt') return this.skip('clear: no target');
    const rc = rectOf(d, rt);
    if (!rc.full) return this.clearRect(d, rc);
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
    // Tiles of render targets are copied out first; a copy ends the pass.
    for (const id of d.tex) {
      const r = id && !(id & P.GP_TEX_RT) && this.res.get(id);
      if (!r || r.kind !== 'sub') continue;
      const src = this.res.get(r.src);
      if (!src || src.kind !== 'rt' || r.src === d.target || r.x0 + r.w > src.w || r.y0 + r.h > src.h) continue;
      this.endPass();
      this.enc.copyTextureToTexture({ texture: src.texture, origin: [r.x0, r.y0, 0] }, { texture: r.texture }, [r.w, r.h]);
    }
    const t = this.bindTarget(d);
    if (!t) return this.skip('no target');

    // Group 1 (textures and samplers), cached by what it binds: resource
    // serials are never reused, so a freed texture's groups just go unused.
    const cube = ps.cube ?? 0, views = [null, null, null, null];
    let key = `${cube}`;
    for (let st = 0; st < 4; st++) {
      let id = d.tex[st], view = null, smp = 0, serial = 0;
      if (id) {
        if (id & P.GP_TEX_RT) { id = (id & ~P.GP_TEX_RT) >>> 0; if (id === d.target) id = 0; }
        const r = id && this.res.get(id);
        const subOk = r && (r.kind !== 'sub' || (r.src !== d.target && this.res.get(r.src)?.kind === 'rt'));
        if (r && subOk && r.kind !== 'ds' && !!r.cube === !!((cube >> st) & 1)) {
          view = r.view; serial = r.serial;
          smp = this.filtered(d.smp[st]) ? d.smp[st] & 0x00FF3FFF : d.smp[st] & 0xFFF;
        }
      }
      views[st] = view;
      key += `|${serial}:${smp}`;
    }
    let g1 = this.groups1.get(key);
    if (!g1) {
      const entries = [];
      for (let st = 0; st < 4; st++) {
        const view = views[st];
        entries.push({ binding: st, resource: view ?? ((cube >> st) & 1 ? this.dummyCube : this.dummy2d) });
        entries.push({ binding: 4 + st, resource: this.sampler(view ? d.smp[st] : 0) });
      }
      if (this.groups1.size > 8192) this.groups1.clear();
      g1 = this.dev.createBindGroup({ layout: this.L.group1(cube), entries });
      this.groups1.set(key, g1);
    }
    const pass = this.pass, b = this.bound;
    this.scissor(rectOf(d, t.rt));
    const pipe = this.pipeline(d, kind, vs, ps.module, cube, !!t.ds);
    if (pipe !== b.pipe) { pass.setPipeline(pipe); b.pipe = pipe; }
    pass.setBindGroup(0, this.group0, [d.slots.xf, d.slots.vsc, d.slots.ps, d.slots.smp]);
    if (g1 !== b.g1) { pass.setBindGroup(1, g1); b.g1 = g1; }
    const bcAlpha = d.st.blend_src === 0x8003 || d.st.blend_src === 0x8004 || d.st.blend_dst === 0x8003 || d.st.blend_dst === 0x8004;
    const bcKey = bcAlpha ? -1 - (d.st.blend_color >>> 24) : d.st.blend_color;
    if (bcKey !== b.bc) {
      const bc = unpack(d.st.blend_color);
      if (bcAlpha) bc.fill(bc[3], 0, 3);
      pass.setBlendConstant(bc); b.bc = bcKey;
    }
    if (t.ds && (d.st.stencil_ref & 0xFF) !== b.sref) { b.sref = d.st.stencil_ref & 0xFF; pass.setStencilReference(b.sref); }
    const vbn = d.vtx_count * d.vtx_stride;
    if (d.vtx_off !== b.vb || vbn !== b.vbn) { pass.setVertexBuffer(0, this.bufs.vtx, d.vtx_off, vbn); b.vb = d.vtx_off; b.vbn = vbn; }
    if (d.idx_count) {
      if (!b.ib) { pass.setIndexBuffer(this.bufs.idx, 'uint32'); b.ib = true; }
      pass.drawIndexed(d.idx_count, 1, d.idx_off);
    } else {
      pass.draw(d.vtx_count);
    }
    this.stats.draws++;
  }

  // ---- a frame -------------------------------------------------------------

  consume(frame) { this.encode(this.stage(frame)); }

  /** Everything that reads the frame's bytes: the queue, the records, and
   * the vertex, index and constant uploads (writeBuffer copies at the call).
   * The frame may be views straight into the shared wasm memory, which the
   * recorder may reuse as soon as this returns. */
  stage(frame) {
    this.drainQueue(frame.queue);
    const draws = readDraws(frame.draws, frame.drawCount);
    const vbuf = this.buffer('vtx', frame.vtx.byteLength + 4, GPUBufferUsage.VERTEX);
    if (frame.vtx.byteLength) this.dev.queue.writeBuffer(vbuf, 0, frame.vtx);
    const ibuf = this.buffer('idx', frame.idx.byteLength + 4, GPUBufferUsage.INDEX);
    if (frame.idx.byteLength) this.dev.queue.writeBuffer(ibuf, 0, frame.idx);
    this.packUniforms(frame, draws);
    return draws;
  }

  /** The command buffer for a staged frame. */
  encode(draws) {
    this.enc = this.dev.createCommandEncoder();
    this.pass = null; this.curTarget = this.curZeta = -1; this.clrSlot = 0;
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
