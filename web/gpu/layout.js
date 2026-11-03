// The bind-group layout every generated WGSL module is written against
// (gpu_shadergen_wgsl.h has the table). One pipeline layout per cube mask:
// group 1's texture view dimension is part of the layout.

export const UNIFORM_SLOTS = [
  // binding, bytes the binding exposes, arena slot stride (256-aligned)
  { binding: 0, size: 112, stride: 256 },   // GpXfConsts (or GpTvConsts, 32)
  { binding: 1, size: 3072, stride: 3072 }, // GpVsConsts
  { binding: 2, size: 320, stride: 512 },   // GpPsConsts
  { binding: 3, size: 96, stride: 256 },    // GpWgslSmp
];

export function makeLayouts(device) {
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const g0 = device.createBindGroupLayout({
    label: 'consts',
    entries: UNIFORM_SLOTS.map((s) => ({
      binding: s.binding, visibility: VF,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 0 },
    })),
  });
  const g1 = new Map();
  const pl = new Map();
  const group1 = (cube) => {
    if (!g1.has(cube)) {
      const entries = [];
      for (let st = 0; st < 4; st++) {
        entries.push({ binding: st, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: (cube >> st) & 1 ? 'cube' : '2d' } });
        entries.push({ binding: 4 + st, visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' } });
      }
      g1.set(cube, device.createBindGroupLayout({ label: `textures cube=${cube}`, entries }));
    }
    return g1.get(cube);
  };
  return {
    group0: g0,
    group1,
    pipelineLayout(cube) {
      if (!pl.has(cube))
        pl.set(cube, device.createPipelineLayout({ bindGroupLayouts: [g0, group1(cube)] }));
      return pl.get(cube);
    },
  };
}

/** The cube mask a PS module was generated with (texture_cube bindings). */
export function cubeMaskOf(wgsl) {
  let m = 0;
  for (const x of wgsl.matchAll(/@binding\((\d)\) var tx\d: texture_cube/g)) m |= 1 << Number(x[1]);
  return m;
}

/** The inputs a program VS module declares (@location(k) vk), as a mask
 * (gpu_vs_input_mask in gpu_shadergen_wgsl.c); 0 for other modules. */
export function inputMaskOf(wgsl) {
  let m = 0;
  for (const x of wgsl.matchAll(/@location\((\d+)\) v(\d+): vec4f/g)) if (x[1] === x[2]) m |= 1 << Number(x[1]);
  return m;
}

// The rows of the VS constant file (K.c, GpVsConsts) a program module reads,
// [lo, hi]: from its WGSL (gpu_shadergen_wgsl.c vsh_src), so exactly what it
// can index. Relative addressing (cidx) can reach any row: [0, 191].
// packUniforms uploads only these rows of each block.
export function constRangeOf(wgsl) {
  if (wgsl.includes('cidx(')) return [0, 191];
  let lo = 192, hi = -1;
  for (const x of wgsl.matchAll(/K\.c\[(\d+)\]/g)) { const r = Number(x[1]); if (r < lo) lo = r; if (r > hi) hi = r; }
  return hi < 0 ? [0, 0] : [lo, hi];
}

// Vertex buffer layouts by vertex shader kind. Program vertices are either
// all 16 inputs (GpProgVertex, 256 bytes: captures, native) or only the
// inputs the module declares, packed in location order (the wasm recorder).
export function vertexLayout(kind, inputs = 0xFFFF, stride = 256) {
  if (kind === 'tvert')
    return [{ arrayStride: 28, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x4' },
      { shaderLocation: 1, offset: 16, format: 'unorm8x4' },
      { shaderLocation: 2, offset: 20, format: 'float32x2' }] }];
  if (kind === 'program' && stride !== 256) {
    const attributes = [];
    for (let k = 0; k < 16; k++)
      if (inputs & (1 << k)) attributes.push({ shaderLocation: k, offset: attributes.length * 16, format: 'float32x4' });
    return [{ arrayStride: stride, attributes }];
  }
  const n = kind === 'passthru' ? 8 : 16;
  return [{ arrayStride: n * 16, attributes: Array.from({ length: n }, (_, i) =>
    ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })) }];
}

export async function requestDevice() {
  if (!navigator.gpu) throw new Error('no navigator.gpu');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const want = ['texture-compression-bc', 'clip-distances', 'depth32float-stencil8'];
  const requiredFeatures = want.filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({ requiredFeatures });
  const info = adapter.info ?? {};
  return { adapter, device, features: requiredFeatures,
    adapterName: `${info.vendor ?? ''} ${info.architecture ?? ''} ${info.description ?? ''}`.trim() };
}
