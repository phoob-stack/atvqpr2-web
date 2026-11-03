// Mirror of src/gpu/gpu_proto.h (+ GpWgslSmp, GpCapHeader from
// gpu_shadergen_wgsl.h). web/tools/check-gpu-proto.mjs compiles a C probe of
// the real header and compares every offset and size below; the page refuses
// a capture whose layout word differs (GP_WG_LAYOUT).
//
// Every struct is little-endian, 4-byte fields only, so a layout is a list of
// [name, count] u32/f32 fields and offsets are computed, never hand-written.

export const GP_VERSION = 1;

export const GP_DRAW = 0, GP_CLEAR = 1;
export const GP_VS_PASSTHRU = 1, GP_VS_TVERT = 2, GP_VS_FIRST_PROGRAM = 16;
export const GP_PS_TVERT = 1, GP_PS_FIRST = 16;
export const GP_TEX_RT = 0x80000000;
export const GP_SMP_LINEAR = 0x1, GP_SMP_BORDER = 0x1000, GP_SMP_FILTER = 0x2000;
export const GP_SMP_MIN_OF = (k) => (k >>> 16) & 15, GP_SMP_MAG_OF = (k) => (k >>> 20) & 15;
export const GP_SMP_BIAS_OF = (k) => ((k << 0) >> 24) * 16;   // signed, 1/256 levels
export const GP_RT_CREATE = 1, GP_DS_CREATE = 2, GP_TEX_CREATE = 3, GP_TEX_FREE = 4, GP_SUB_CREATE = 8,
  GP_SHADER_VS = 5, GP_SHADER_PS = 6, GP_RT_NO_WRITEBACK = 7;
export const GP_FMT_BGRA8 = 1, GP_FMT_BC1 = 2, GP_FMT_BC2 = 3, GP_FMT_BC3 = 4;

function layout(fields) {
  const off = {};
  let at = 0;
  for (const [name, count = 1] of fields) { off[name] = at; at += 4 * count; }
  return { off, size: at };
}

export const GpState = layout([
  ['blend_en'], ['blend_src'], ['blend_dst'], ['blend_eq'], ['blend_color'],
  ['color_mask'],
  ['depth_test'], ['depth_func'], ['depth_write'],
  ['stencil_en'], ['stencil_func'], ['stencil_ref'], ['stencil_fmask'], ['stencil_wmask'],
  ['stencil_fail'], ['stencil_zfail'], ['stencil_zpass'],
]);

export const GpDraw = layout([
  ['kind'], ['target'], ['target_swz'], ['zeta'], ['zeta_format'], ['vs'], ['ps'],
  ['tex', 4], ['smp', 4], ['border', 4],
  ['st', GpState.size / 4],
  ['vtx_off'], ['vtx_count'], ['vtx_stride'], ['idx_off'], ['idx_count'],
  ['vsc_off'], ['xfc_off'], ['psc_off'],
  ['clr_flags'], ['clr_argb'], ['clr_zs'],
]);

export const GpCmd = layout([['op'], ['id'], ['a'], ['b'], ['c'], ['d'], ['e'], ['bytes']]);

export const GpProgVertex = layout([['v', 64]]);
export const GpXfVertex = layout([['pos', 4], ['d0', 4], ['d1', 4], ['fog', 4], ['tex', 16]]);
export const GpTVertex = layout([['x'], ['y'], ['z'], ['rhw'], ['diffuse'], ['u'], ['v']]);
export const GpVsConsts = layout([['c', 192 * 4]]);
export const GpXfConsts = layout([
  ['surf', 2], ['zscale'], ['near_z'], ['aa', 2], ['fog_on'], ['fog_mode'],
  ['fog_p0'], ['fog_p1'], ['pad0', 2], ['uvscale', 16],
]);
export const GpTvConsts = layout([
  ['surf', 2], ['zscale'], ['textured'], ['texsize', 2], ['alpha_ref'], ['alpha_func'],
]);
export const GpPsConsts = layout([
  ['f0', 32], ['f1', 32], ['fc0', 4], ['fc1', 4], ['fogc', 4],
  ['alpha_ref'], ['alpha_func'], ['alpha_on'], ['clip_mode'],
]);
export const GpWgslSmp = layout([['border', 16], ['flags', 4], ['bias', 4]]);
export const GpCapHeader = layout([
  ['magic'], ['version'], ['layout'], ['frame'],
  ['queue_bytes'], ['draw_count'], ['vtx_bytes'], ['idx_count'], ['const_bytes'],
  ['ref_target'], ['pad', 2],
]);

// GP_WG_LAYOUT in gpu_shadergen_wgsl.h.
export const GP_WG_LAYOUT =
  ((GpDraw.size | (GpCmd.size << 10) | (GpPsConsts.size << 16)) ^ (GP_VERSION << 28)) >>> 0;

/** Everything check-gpu-proto.mjs compares, as "Struct.field" -> number. */
export function probeTable() {
  const t = {};
  const structs = { GpState, GpDraw, GpCmd, GpProgVertex, GpXfVertex, GpTVertex, GpVsConsts,
    GpXfConsts, GpTvConsts, GpPsConsts, GpWgslSmp, GpCapHeader };
  for (const [s, l] of Object.entries(structs)) {
    t[`sizeof(${s})`] = l.size;
    for (const [f, o] of Object.entries(l.off)) t[`${s}.${f}`] = o;
  }
  t.GP_WG_LAYOUT = GP_WG_LAYOUT;
  // Enum and flag values the page acts on.
  Object.assign(t, { GP_RT_CREATE, GP_DS_CREATE, GP_TEX_CREATE, GP_TEX_FREE, GP_SHADER_VS, GP_SHADER_PS,
    GP_SUB_CREATE, GP_SMP_LINEAR, GP_SMP_BORDER, GP_SMP_FILTER, GP_TEX_RT, GP_FMT_BGRA8, GP_FMT_BC1,
    GP_FMT_BC2, GP_FMT_BC3, GP_VS_PASSTHRU, GP_VS_TVERT, GP_PS_TVERT });
  return t;
}

/** A capture file (cap_<frame>.gpf) split into its sections. */
export function parseCapture(buf) {
  const u = new Uint32Array(buf, 0, GpCapHeader.size / 4);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'GPF1') throw new Error(`not a capture (${magic})`);
  if (u[1] !== GP_VERSION || u[2] !== GP_WG_LAYOUT)
    throw new Error(`capture layout ${u[2].toString(16)} v${u[1]}, page ${GP_WG_LAYOUT.toString(16)} v${GP_VERSION}`);
  const h = { frame: u[3], queueBytes: u[4], drawCount: u[5], vtxBytes: u[6], idxCount: u[7],
    constBytes: u[8], refTarget: u[9] };
  const pad = (n) => (n + 15) & ~15;
  let at = GpCapHeader.size;
  const take = (n) => { const v = new Uint8Array(buf, at, n); at += pad(n); return v; };
  return {
    ...h,
    queue: take(h.queueBytes),
    draws: take(h.drawCount * GpDraw.size),
    vtx: take(h.vtxBytes),
    idx: take(h.idxCount * 4),
    consts: take(h.constBytes),
  };
}
