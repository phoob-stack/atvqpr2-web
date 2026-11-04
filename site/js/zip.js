// A small zip reader and writer (a copy of the local build's zip.js). No npm
// packages. Writes stored (uncompressed) entries with UTF-8 names; reads
// stored and deflated entries (DecompressionStream 'deflate-raw'), so a zip
// the player made with Windows' "Send to > Compressed folder" also imports.
// Every entry's CRC-32 and size are checked.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(ms) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * entries: [{ path: 'UDATA/4143000a/x' (no leading slash; a trailing '/' is a
 * directory), data?: Uint8Array, mtime?: ms }] -> Uint8Array of a zip file.
 */
export function writeZip(entries) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path), data = e.data ?? new Uint8Array(0);
    const crc = crc32(data), { time, date } = dosTime(e.mtime ?? Date.now());
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(38, e.path.endsWith('/') ? 0x10 : 0x20, true);      // MS-DOS directory / archive attribute
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function inflateRaw(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/**
 * Parse a zip. Returns [{ path, dir, data, mtime }] or throws an Error whose
 * message is meant for the player. Limits: maxEntries, maxBytes (the sum of
 * the uncompressed sizes of the entries kept). keep(path): entries it says no
 * to are not unpacked (e.g. the multi-GB Partition*.img of a whole save dir).
 */
export async function readZip(u8, { maxEntries = 4096, maxBytes = 64 << 20, keep = () => true } = {}) {
  const bad = (why) => new Error(`This is not a usable zip file (${why}).`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xffff); i--)
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('no end-of-archive record');
  const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdAt = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdAt === 0xffffffff) throw bad('zip64 archives are not supported');
  if (cdAt + cdSize > eocd) throw bad('the directory is outside the file');
  if (count > maxEntries) throw new Error(`The zip has ${count} entries; a save archive has far fewer (at most ${maxEntries}).`);
  const dec = new TextDecoder();
  const out = [];
  let total = 0;
  for (let i = 0, p = cdAt; i < count; i++) {
    if (p + 46 > eocd || dv.getUint32(p, true) !== 0x02014b50) throw bad(`directory entry ${i} is damaged`);
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true), t = dv.getUint16(p + 12, true), d = dv.getUint16(p + 14, true);
    const rawName = u8.subarray(p + 46, p + 46 + nlen);
    // Names as UTF-8 (bit 11); Xbox save names are ASCII, the same in any code page.
    const path = dec.decode(rawName);
    p += 46 + nlen + xlen + clen;
    if (!keep(path)) continue;
    if (flags & 1) throw new Error(`${path}: encrypted zip entries are not supported.`);
    if (method !== 0 && method !== 8) throw new Error(`${path}: compression method ${method} is not supported (only stored and deflate).`);
    if (lho + 30 > u8.length || dv.getUint32(lho, true) !== 0x04034b50) throw bad(`${path}: local header missing`);
    const at = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    if (at + csize > u8.length) throw bad(`${path}: data runs past the end of the file`);
    total += size;
    if (total > maxBytes) throw new Error(`The zip unpacks to more than ${maxBytes >> 20} MB; a save archive is far smaller.`);
    const dir = path.endsWith('/') || path.endsWith('\\');
    let data = new Uint8Array(0);
    if (!dir) {
      const raw = u8.subarray(at, at + csize);
      try { data = method === 0 ? raw.slice() : await inflateRaw(raw); } catch { throw bad(`${path}: its data does not unpack`); }
      if (data.length !== size) throw bad(`${path}: ${data.length} bytes unpacked, ${size} expected`);
      if (crc32(data) !== crc) throw bad(`${path}: checksum mismatch, the file is damaged`);
    }
    const mtime = new Date(1980 + (d >> 9), ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2).getTime();
    out.push({ path, dir, data, mtime });
  }
  return out;
}
