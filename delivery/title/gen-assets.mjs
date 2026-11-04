// gen-assets.mjs - the placeholder title's assets, made procedurally here
// (seeded, deterministic: same options -> same bytes). Nothing is taken from
// anywhere: tileable value-noise textures, a track loop, a box mesh.
//
//   node title/gen-assets.mjs <outDir> [--variant N]
//
// --variant N changes only textures/dirt.rgba (a different seed and tint):
// the "one asset changed" case of the delivery tests.
//
// Formats (little-endian):
//   textures/*.rgba  u32 'DTEX', u32 width, u32 height, u32 0, then RGBA8 rows
//   meshes/track.bin u32 'DTRK', u32 1, u32 n, f32 width, n x (f32 x, f32 y)
//   meshes/quad.bin  u32 'DMSH', u32 1, u32 nverts, u32 nfaces,
//                    nverts x (f32 x, y, z), nfaces x (u16 a, b, c, d, u8 r, g, b, a)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

function rng(seed) {             // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tileable fractal value noise in [0,1].
function noiseField(w, h, seed, octaves = 5, base = 8) {
  const out = new Float32Array(w * h);
  let amp = 1, total = 0;
  const r = rng(seed);
  for (let o = 0; o < octaves; o++) {
    const gx = base << o, gy = Math.max(1, Math.round(base * h / w)) << o;
    const grid = new Float32Array(gx * gy);
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    for (let y = 0; y < h; y++) {
      const fy = (y / h) * gy, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % gy) * gx, r1 = ((y0 + 1) % gy) * gx;
      for (let x = 0; x < w; x++) {
        const fx = (x / w) * gx, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % gx, c1 = (x0 + 1) % gx;
        const a = grid[r0 + c0] + (grid[r0 + c1] - grid[r0 + c0]) * sx;
        const b = grid[r1 + c0] + (grid[r1 + c1] - grid[r1 + c0]) * sx;
        out[y * w + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function texture(w, h, seed, shade) {
  const buf = Buffer.alloc(16 + w * h * 4);
  buf.write('DTEX', 0, 'latin1');
  buf.writeUInt32LE(w, 4); buf.writeUInt32LE(h, 8);
  const n = noiseField(w, h, seed), fine = noiseField(w, h, seed ^ 0x9e3779b9, 3, 64);
  const r = rng(seed + 1);
  for (let i = 0; i < w * h; i++) {
    const [R, G, B] = shade(n[i], fine[i], r());
    const o = 16 + i * 4;
    buf[o] = R; buf[o + 1] = G; buf[o + 2] = B; buf[o + 3] = 255;
  }
  return buf;
}
const c8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

function track() {
  const n = 256, width = 14;
  const buf = Buffer.alloc(16 + n * 8);
  buf.write('DTRK', 0, 'latin1');
  buf.writeUInt32LE(1, 4); buf.writeUInt32LE(n, 8); buf.writeFloatLE(width, 12);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rad = 120 + 28 * Math.sin(3 * t) + 14 * Math.cos(5 * t + 0.7);
    buf.writeFloatLE(Math.cos(t) * rad * 1.25, 16 + i * 8);
    buf.writeFloatLE(Math.sin(t) * rad, 20 + i * 8);
  }
  return buf;
}

function quadMesh() {
  const verts = [], faces = [];
  const box = (x0, y0, z0, x1, y1, z1, rgb) => {
    const b = verts.length / 3;
    for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]])
      verts.push(x, y, z);
    const shade = (k) => rgb.map((c) => c8(c * k));
    for (const [f, k] of [[[0, 1, 5, 4], 0.7], [[1, 2, 6, 5], 0.85], [[2, 3, 7, 6], 0.7], [[3, 0, 4, 7], 0.6], [[4, 5, 6, 7], 1.0]])
      faces.push([...f.map((v) => v + b), ...shade(k), 255]);
  };
  box(-1.0, -0.6, 0.45, 1.0, 0.6, 0.95, [220, 70, 40]);        // body
  box(-0.5, -0.35, 0.95, 0.3, 0.35, 1.25, [40, 40, 48]);       // seat
  box(0.55, -0.55, 0.95, 0.75, 0.55, 1.15, [70, 70, 80]);      // handlebar
  for (const [x, y] of [[0.75, 0.75], [0.75, -0.75], [-0.75, 0.75], [-0.75, -0.75]])
    box(x - 0.35, y - 0.18, 0, x + 0.35, y + 0.18, 0.7, [30, 30, 30]);   // wheels
  const nv = verts.length / 3, nf = faces.length;
  const buf = Buffer.alloc(16 + nv * 12 + nf * 12);
  buf.write('DMSH', 0, 'latin1');
  buf.writeUInt32LE(1, 4); buf.writeUInt32LE(nv, 8); buf.writeUInt32LE(nf, 12);
  verts.forEach((v, i) => buf.writeFloatLE(v, 16 + i * 4));
  let o = 16 + nv * 12;
  for (const f of faces) {
    for (let k = 0; k < 4; k++) { buf.writeUInt16LE(f[k], o); o += 2; }
    for (let k = 4; k < 8; k++) buf[o++] = f[k];
  }
  return buf;
}

export function generate(outDir, { variant = 0 } = {}) {
  const files = {
    'textures/grass.rgba': texture(1024, 1024, 1001, (n, f, r) => [c8(40 + 50 * n + 20 * f), c8(90 + 90 * n + 30 * f + 10 * r), c8(30 + 30 * n)]),
    'textures/dirt.rgba': texture(512, 512, 2002 + variant * 7919, (n, f, r) => {
      const tint = variant ? 25 : 0;
      return [c8(120 + 60 * n + 25 * f + tint), c8(85 + 45 * n + 20 * f), c8(55 + 30 * n + 10 * r - tint)];
    }),
    'textures/sand.rgba': texture(768, 768, 3003, (n, f, r) => [c8(190 + 45 * n + 15 * f), c8(165 + 40 * n + 12 * f), c8(110 + 30 * n + 8 * r)]),
    'meshes/track.bin': track(),
    'meshes/quad.bin': quadMesh(),
    'config/title.json': Buffer.from(JSON.stringify({
      name: 'Box Quad (delivery test title)',
      // Assets the title needs before it starts; the rest is fetched on first use.
      start: ['meshes/track.bin', 'meshes/quad.bin', 'textures/grass.rgba', 'textures/dirt.rgba'],
      // The sand zone: north of this line the ground is sand, whose texture is
      // fetched only when the camera first comes near it.
      sandZone: { yMin: 70, approach: 60, texture: 'textures/sand.rgba' },
      worldPerTexel: 0.0625,
    }, null, 2) + '\n'),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(outDir, rel)), { recursive: true });
    writeFileSync(join(outDir, rel), body);
  }
  return Object.keys(files);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const out = argv.find((a) => !a.startsWith('--'));
  if (!out) { console.error('usage: node title/gen-assets.mjs <outDir> [--variant N]'); process.exit(2); }
  const i = argv.indexOf('--variant');
  const list = generate(out, { variant: i >= 0 ? Number(argv[i + 1]) : 0 });
  console.log(`wrote ${list.length} files to ${out}`);
}
