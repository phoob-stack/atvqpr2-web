// asset-worker.js - downloads, checks and stores asset files in OPFS (a
// dedicated module worker, so the page never blocks on storage or hashing).
//
// OPFS layout, per namespace (one per title and content source):
//   delivery/<ns>/blobs/<sha256>            a finished file. It only ever appears
//                                           under this name by a rename of its
//                                           .part after its SHA-256 matched.
//   delivery/<ns>/blobs/<sha256>.ok         the "cached" mark: { size, lastModified }
//                                           of the blob when it was last verified
//   delivery/<ns>/blobs/<sha256>.part       a download in progress: written with
//                                           createWritable(), committed at checkpoints,
//                                           so a closed page or a cut connection
//                                           resumes from its length
//   delivery/<ns>/blobs/<sha256>.part.json  { etag } of the server's copy (If-Range)
//   delivery/<ns>/catalog.json              written by the page (assets.js)
//
// Messages (page -> worker), each with an id; answers carry the same id:
//   { op:'ensure', ns, url, entry, retries }   -> progress* then done | error
//   { op:'verify', ns, entries, full }         -> done { results: [{ sha256, status }] }
//   { op:'scrub', ns, keep: [entry] }          -> done { removed, kept, truncated }
//   { op:'store', ns, entry, file, adopt? }    -> progress* then done { sha256, size } | error   (local files;
//                                              entry.sha256 may be unknown: it is computed while storing)
//   { op:'gc', ns, keep:[sha256] }             -> done { removed }
//   { op:'forget', ns }                        -> done
// entry: { path, size, sha256, chunkSize?, chunks? } (the manifest's record).
//
// Integrity: every byte goes through an incremental SHA-256 (sha256.js) as it
// arrives; the whole file is never held in memory. Files with a chunk list
// are also checked per chunk as they arrive (a bad chunk is cut off and
// fetched again from its start; the running hash rolls back to its state at
// that chunk). A finished .part whose SHA-256 differs is emptied and fetched
// again from 0; twice in a row is an error ('hash'). Only then is it renamed
// into place and marked.
// Cached files: a blob is trusted while its .ok mark matches its size and
// lastModified (anything that writes to it changes lastModified); otherwise
// it is hashed again, and deleted (and fetched again) if it no longer matches.
// verify with full:true hashes regardless of the mark.
// Resume: Range: bytes=<length of .part>- (with If-Range: <ETag> when the
// server gave a strong one). The bytes already in the .part are hashed again
// from disk first (complete chunks are checked against the chunk list).
// One download per file across tabs (Web Locks, when the browser has them).
import { Sha256 } from './sha256.js';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const digest = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(8000, 200 * 2 ** n) * (0.75 + Math.random() * 0.5);   // with jitter
const SHA = /^[0-9a-f]{64}$/;
const READ_SLICE = 4 << 20;                // bytes read from disk at a time when re-hashing
const CHECKPOINT_MIN = 4 << 20;            // commit the .part at least every 4 MiB (then every half of what is there)
// Files up to this size are hashed whole by WebCrypto (native, several times
// faster than the incremental JS hash) when they are already on this machine
// (a picked local file, a stored blob); bigger ones, and downloads, stream
// through sha256.js so that they are never held in memory whole.
const NATIVE_MAX = 128 << 20;

/** SHA-256 of a File: WebCrypto for files up to NATIVE_MAX, else the incremental hash a slice at a time. */
async function hashFileOf(file) {
  if (file.size <= NATIVE_MAX) return digest(await file.arrayBuffer());
  return (await hashRange(file, 0, file.size, new Sha256())).digestHex();
}

class Fail extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); } }

async function nsDir(ns, create = true) {
  const root = await navigator.storage.getDirectory();
  const d = await root.getDirectoryHandle('delivery', { create });
  return d.getDirectoryHandle(ns, { create });
}
async function blobsDir(ns) { return (await nsDir(ns)).getDirectoryHandle('blobs', { create: true }); }
async function handle(dir, name) { try { return await dir.getFileHandle(name); } catch { return null; } }
async function fileOf(dir, name) { const h = await handle(dir, name); return h ? h.getFile() : null; }
async function remove(dir, name) { try { await dir.removeEntry(name); return true; } catch { return false; } }
async function readJson(dir, name) { try { return JSON.parse(await (await fileOf(dir, name)).text()); } catch { return null; } }
async function writeJson(dir, name, obj) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  try { await w.write(JSON.stringify(obj)); await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; }
}
const withLock = (name, fn, opts = {}) => (navigator.locks ? navigator.locks.request(name, opts, fn) : fn(true));
const opfsFail = (e, what) => new Fail('opfs', `${what}: this browser's storage refused the write (${e.name}: ${e.message}); is the disk or the site's storage quota full?`);

/** Feed bytes [from, to) of a File into a hasher, a slice at a time. */
async function hashRange(file, from, to, hasher) {
  for (let o = from; o < to; o += READ_SLICE) hasher.update(new Uint8Array(await file.slice(o, Math.min(to, o + READ_SLICE)).arrayBuffer()));
  return hasher;
}

/**
 * Is the blob for `entry` there and good? 'ok' | 'missing' | 'bad' (deleted).
 * full: hash it even when its mark says it was verified and is unchanged.
 */
async function checkStored(dir, entry, { full = false } = {}) {
  const f = await fileOf(dir, entry.sha256);
  if (!f) { await remove(dir, `${entry.sha256}.ok`); return { status: 'missing' }; }
  if (f.size !== entry.size) { await remove(dir, entry.sha256); await remove(dir, `${entry.sha256}.ok`); return { status: 'bad', why: 'size' }; }
  const mark = await readJson(dir, `${entry.sha256}.ok`);
  if (!full && mark && mark.size === f.size && mark.lastModified === f.lastModified) return { status: 'ok', hashed: 0 };
  const got = await hashFileOf(f);
  if (got !== entry.sha256) {
    await remove(dir, entry.sha256); await remove(dir, `${entry.sha256}.ok`);
    return { status: 'bad', why: 'sha256', hashed: f.size };
  }
  await writeJson(dir, `${entry.sha256}.ok`, { size: f.size, lastModified: f.lastModified, verifiedAt: Date.now() });
  return { status: 'ok', hashed: f.size, rehashed: true };
}

/** Rename <sha>.part to <sha> (move(), else a streamed copy), then mark it. */
async function promote(dir, sha) {
  await remove(dir, sha);
  const ph = await dir.getFileHandle(`${sha}.part`);
  let moved = false;
  if (typeof ph.move === 'function') { try { await ph.move(dir, sha); moved = true; } catch { /* fall back to a copy */ } }
  if (!moved) {
    const src = await ph.getFile();
    const w = await (await dir.getFileHandle(sha, { create: true })).createWritable();
    try { await src.stream().pipeTo(w); } catch (e) { await w.abort().catch(() => {}); throw opfsFail(e, sha); }
    await remove(dir, `${sha}.part`);
  }
  await remove(dir, `${sha}.part.json`);
  const f = await fileOf(dir, sha);
  await writeJson(dir, `${sha}.ok`, { size: f.size, lastModified: f.lastModified, verifiedAt: Date.now() });
}

async function ensure(msg, post) {
  const { ns, entry } = msg;
  const dir = await blobsDir(ns);
  const first = await checkStored(dir, entry);
  if (first.status === 'ok') return { stored: true, net: 0, resent: 0, attempts: 0, resumedFrom: 0, rehashed: !!first.rehashed };
  return withLock(`delivery:${ns}:${entry.sha256}`, async () => {
    const again = await checkStored(dir, entry);           // another tab may have finished it meanwhile
    if (again.status === 'ok') return { stored: true, net: 0, resent: 0, attempts: 0, resumedFrom: 0 };
    return download(dir, msg, post, first.status === 'bad' ? first.why : null);
  });
}

async function download(dir, msg, post, cachedBad) {
  const { url, entry } = msg;
  const retries = msg.retries ?? 6;
  const size = entry.size, sha = entry.sha256;
  const cs = entry.chunkSize ?? 0, chunks = cs && Array.isArray(entry.chunks) ? entry.chunks : null;
  const stat = { net: 0, resent: 0, attempts: 0, resumedFrom: 0, hashRetries: 0, ranges: [], checkpoints: 0, cachedBad };
  const partName = `${sha}.part`, metaName = `${sha}.part.json`;
  let meta = await readJson(dir, metaName) ?? {};
  const ph = await dir.getFileHandle(partName, { create: true });

  // ---- what is already in the .part: hash it again (and check its complete chunks)
  const pf = await ph.getFile();
  let offset = pf.size > size ? 0 : pf.size;
  let hasher = new Sha256();
  let curStart = 0, cur = null, curFill = 0, atChunk = null;   // chunk accumulator, hasher state at curStart
  if (chunks) {
    const complete = offset === size ? chunks.length : Math.floor(offset / cs);
    let k = 0;
    for (; k < complete; k++) {
      const buf = new Uint8Array(await pf.slice(k * cs, Math.min(size, (k + 1) * cs)).arrayBuffer());
      if (await digest(buf) !== chunks[k]) { offset = k * cs; break; }
      hasher.update(buf);
    }
    curStart = Math.min(k * cs, offset);
    atChunk = hasher.clone();
    if (curStart < size) {
      cur = new Uint8Array(Math.min(cs, size - curStart));
      curFill = offset - curStart;
      if (curFill) { const tail = new Uint8Array(await pf.slice(curStart, offset).arrayBuffer()); cur.set(tail); hasher.update(tail); }
    }
  } else if (offset > 0) await hashRange(pf, 0, offset, hasher);
  stat.resumedFrom = offset;

  let w;
  try { w = await ph.createWritable({ keepExistingData: true }); await w.truncate(offset); await w.seek(offset); }
  catch (e) { throw new Fail('opfs', `cannot open ${entry.path} in this browser's storage (${e.name}: ${e.message})`); }
  let committed = offset;
  const write = async (piece) => { try { await w.write(piece); } catch (e) { throw opfsFail(e, entry.path); } };
  const checkpoint = async () => {
    // commit what is written so far (a page closed after this resumes from here)
    try { await w.close(); } catch (e) { throw opfsFail(e, entry.path); }
    committed = offset; stat.checkpoints++;
    await writeJson(dir, metaName, { etag: meta.etag ?? null, size, at: Date.now() }).catch(() => {});
    w = await ph.createWritable({ keepExistingData: true }); await w.seek(offset);
  };
  const restartFromZero = async () => {
    stat.resent += offset;
    await w.truncate(0); await w.seek(0);
    offset = 0; hasher = new Sha256();
    if (chunks) { curStart = 0; curFill = 0; cur = new Uint8Array(Math.min(cs, size)); atChunk = hasher.clone(); }
  };
  let lastPost = 0;
  const progress = (force) => {
    const t = performance.now();
    if (force || t - lastPost > 50) { lastPost = t; post({ type: 'progress', stored: offset, total: size, net: stat.net }); }
  };
  progress(true);

  let closed = false;
  try {
    let wholeFails = 0;
    for (;;) {
      if (offset >= size) {
        const got = hasher.clone().digestHex();
        if (got === sha) break;
        stat.hashRetries++;
        if (++wholeFails >= 2) {
          await w.truncate(0); await w.close(); closed = true; await remove(dir, metaName);
          throw new Fail('hash', `${entry.path}: the data from the server does not match the manifest's SHA-256 ` +
            `(expected ${sha.slice(0, 12)}…, got ${got.slice(0, 12)}…, twice). The file on the server is damaged or was replaced without a new manifest.`);
        }
        await restartFromZero();
        continue;
      }
      if (stat.attempts > retries) throw new Fail('network', `${entry.path}: download failed ${stat.attempts} times (${stat.lastError ?? 'network error'}); ` +
        `${offset} of ${size} bytes are kept in this browser and the next try continues from there.`);
      stat.attempts++;
      const headers = {};
      if (offset > 0) {
        headers.range = `bytes=${offset}-`;
        if (meta.etag && !meta.etag.startsWith('W/')) headers['if-range'] = meta.etag;
      }
      let res;
      try { res = await fetch(url, { cache: 'no-store', headers, mode: 'cors', credentials: 'omit' }); }
      catch (e) { stat.lastError = e.message; await sleep(backoff(stat.attempts)); continue; }
      if (res.status === 404 || res.status === 410) throw new Fail('missing', `${entry.path}: the server has no such file (HTTP ${res.status} for ${url}). The manifest and the files on the server are out of step.`);
      if (res.status === 429 || res.status >= 500 || res.status === 408) {
        stat.lastError = `HTTP ${res.status}`;
        const ra = Number(res.headers.get('retry-after') ?? 0);
        await sleep(ra > 0 ? Math.min(10000, ra * 1000) : backoff(stat.attempts));
        continue;
      }
      if (res.status === 416) { stat.lastError = 'HTTP 416'; await restartFromZero(); continue; }
      if (res.status === 200) {
        if (offset > 0) await restartFromZero();                 // the server sent the whole file (no range, or If-Range did not match)
        // An ETag is a validator for ranges only if it names the identity bytes: a compressed answer
        // (Content-Length is not the file's size) has its own ETag, which If-Range would never match.
        meta = { etag: Number(res.headers.get('content-length')) === size ? res.headers.get('etag') : null };
      } else if (res.status === 206) {
        const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
        if (!cr || Number(cr[1]) !== offset || Number(cr[3]) !== size) { stat.lastError = `bad Content-Range ${res.headers.get('content-range')}`; await restartFromZero(); continue; }
        if (!meta.etag) meta = { etag: res.headers.get('etag') };   // a range is always identity bytes
      } else throw new Fail('http', `${entry.path}: HTTP ${res.status} from ${url}`);
      stat.ranges.push(offset);
      const reader = res.body.getReader();
      let restart = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          let v = value;
          if (offset + v.length > size) v = v.subarray(0, size - offset);
          let at = 0;
          while (at < v.length) {
            const n = chunks ? Math.min(v.length - at, cur.length - curFill) : v.length - at;
            const piece = v.subarray(at, at + n);
            await write(piece);
            hasher.update(piece);
            if (chunks) { cur.set(piece, curFill); curFill += n; }
            offset += n; at += n; stat.net += n;
            if (chunks && curFill === cur.length) {
              const k = curStart / cs;
              const got = await digest(cur);
              if (got !== chunks[k]) {
                stat.resent += cur.length; stat.hashRetries++;
                offset = curStart; curFill = 0; hasher = atChunk.clone();
                await w.truncate(offset); await w.seek(offset);
                if (stat.lastBad === k) throw new Fail('hash', `${entry.path}: chunk ${k} from the server does not match ` +
                  `the manifest's SHA-256 twice (expected ${chunks[k].slice(0, 12)}…, got ${got.slice(0, 12)}…). The file on the server is damaged or was replaced without a new manifest.`);
                stat.lastBad = k;
                restart = true;
                break;
              }
              curStart += cur.length; curFill = 0; atChunk = hasher.clone();
              if (curStart < size) cur = new Uint8Array(Math.min(cs, size - curStart));
            }
            // checkpoints only where everything written is verified (chunk boundaries), or anywhere without chunks
            if ((!chunks || curFill === 0) && offset < size && offset - committed >= Math.max(CHECKPOINT_MIN, committed / 2)) await checkpoint();
          }
          progress(false);
          if (restart || offset >= size) { await reader.cancel().catch(() => {}); break; }
        }
      } catch (e) {
        if (e instanceof Fail) throw e;
        stat.lastError = e.message || String(e);                 // the connection broke: continue from offset
        await sleep(backoff(stat.attempts));
      }
      progress(true);
    }
    try { await w.close(); closed = true; } catch (e) { throw opfsFail(e, entry.path); }
  } catch (e) {
    // keep what was received (the next try resumes from it); a storage error discards the uncommitted part
    if (!closed) { if (e.code === 'opfs') await w.abort().catch(() => {}); else await w.close().catch(() => w.abort().catch(() => {})); }
    if (e.code !== 'hash' && meta.etag) await writeJson(dir, metaName, { etag: meta.etag, size, at: Date.now() }).catch(() => {});
    throw e;
  }
  await promote(dir, sha);
  return { stored: false, net: stat.net, resent: stat.resent, attempts: stat.attempts, resumedFrom: stat.resumedFrom,
    hashRetries: stat.hashRetries, ranges: stat.ranges, checkpoints: stat.checkpoints, cachedBad };
}

/** Check stored files: { results: [{ sha256, path, status, why? }], hashedBytes, ms }. */
async function verify(msg) {
  const t0 = performance.now();
  const dir = await blobsDir(msg.ns);
  const results = new Array(msg.entries.length);
  let hashedBytes = 0, next = 0;
  // a few at a time: most checks are two small reads (the blob's size and lastModified, its mark)
  const bySha = new Map();          // one check per blob (files with the same contents share it)
  const one = async () => {
    while (next < msg.entries.length) {
      const i = next++, e = msg.entries[i];
      let p = bySha.get(e.sha256);
      const first = !p;
      if (first) { p = checkStored(dir, e, { full: !!msg.full }); bySha.set(e.sha256, p); }
      const r = await p;
      if (first) hashedBytes += r.hashed ?? 0;
      results[i] = { sha256: e.sha256, path: e.path, status: r.status, why: r.why, rehashed: !!r.rehashed };
    }
  };
  await Promise.all(Array.from({ length: msg.full ? 1 : 8 }, one));
  return { results, hashedBytes, ms: Math.round(performance.now() - t0) };
}

/**
 * Start-up clean-up of the blobs folder against the current catalog:
 * - a .part of a file not in the catalog, of a file without a chunk list (its
 *   bytes cannot be checked before the end, and it is small), or longer than
 *   the file: deleted; a chunked .part has its complete chunks checked and is
 *   cut back before the first bad one (an unfinished last chunk stays: the
 *   resumed download checks it when it completes it);
 * - .part.json without its .part, .ok without its blob, browser swap files
 *   (*.crswap) left by a crash, unknown names, and the old partial/ folder: deleted.
 * Files another tab is downloading (held lock) are left alone.
 */
async function scrub(msg) {
  const nd = await nsDir(msg.ns);
  const dir = await blobsDir(msg.ns);
  const keep = new Map(msg.keep.map((e) => [e.sha256, e]));
  const out = { removed: [], kept: [], truncated: [] };
  try { await nd.removeEntry('partial', { recursive: true }); out.removed.push('partial/'); } catch { /* none */ }
  const names = [];
  for await (const [n, h] of dir.entries()) names.push([n, h.kind]);
  const has = new Set(names.map(([n]) => n));
  for (const [n, kind] of names) {
    const m = /^([0-9a-f]{64})(\.ok|\.part|\.part\.json|\.part\.crswap|\.crswap)?$/.exec(n);
    if (kind !== 'file' || !m) { try { await dir.removeEntry(n, { recursive: true }); out.removed.push(n); } catch { /* in use */ } continue; }
    const [, sha, suf = ''] = m;
    if (!suf) continue;                                            // blobs: checked by verify(), dropped by gc()
    if (suf === '.ok') { if (!has.has(sha)) { await remove(dir, n); out.removed.push(n); } continue; }
    await withLock(`delivery:${msg.ns}:${sha}`, async (lock) => {
      if (!lock) return;                                           // another tab is downloading it
      const e = keep.get(sha);
      if (suf === '.part.json') { if (!has.has(`${sha}.part`)) { await remove(dir, n); out.removed.push(n); } return; }
      if (suf.endsWith('.crswap')) { await remove(dir, n); out.removed.push(n); return; }
      // .part
      const f = await fileOf(dir, n);
      const chunked = e && e.chunkSize && Array.isArray(e.chunks);
      if (!e || !chunked || !f || f.size > e.size || f.size === 0 || has.has(sha)) {
        await remove(dir, n); await remove(dir, `${sha}.part.json`);
        out.removed.push(`${n} (${!e ? 'not in the catalog' : has.has(sha) ? 'the file is already stored' : !chunked ? 'not checkable before its end' : 'bad length'})`);
        return;
      }
      // every complete chunk is checked; the first bad one and everything after it goes.
      // An unfinished last chunk is kept: it is checked when the resumed download completes it.
      let good = 0, bad = false;
      const complete = f.size === e.size ? e.chunks.length : Math.floor(f.size / e.chunkSize);
      for (let k = 0; k < complete; k++) {
        const buf = await f.slice(k * e.chunkSize, Math.min(e.size, (k + 1) * e.chunkSize)).arrayBuffer();
        if (await digest(buf) !== e.chunks[k]) { bad = true; break; }
        good = Math.min(e.size, (k + 1) * e.chunkSize);
      }
      if (bad) {
        if (good === 0) { await remove(dir, n); await remove(dir, `${sha}.part.json`); out.removed.push(`${n} (its first chunk is bad)`); return; }
        const w = await (await dir.getFileHandle(n)).createWritable({ keepExistingData: true });
        await w.truncate(good); await w.close();
        out.truncated.push({ name: n, from: f.size, to: good });
      }
      out.kept.push({ name: n, bytes: bad ? good : f.size });
    }, { ifAvailable: true });
  }
  return out;
}

/**
 * A picked local file: read a slice at a time through the hash into <sha>.part
 * (or a temporary name when its SHA-256 is not known yet), checked, renamed,
 * marked. adopt: a FileSystemFileHandle already in OPFS (e.g. an older layout
 * of the same title): it is hashed where it is and then moved into blobs/
 * (no second copy); without move() support it is copied.
 */
async function storeFile(msg, post = () => {}) {
  const { ns, entry, file, adopt = null } = msg;
  const dir = await blobsDir(ns);
  if (entry.sha256 && (await checkStored(dir, { ...entry, size: file.size })).status === 'ok') return { sha256: entry.sha256, size: file.size, already: true };
  const known = SHA.test(entry.sha256 ?? '');
  const tmp = `${known ? entry.sha256 : `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}.part`;
  const h = new Sha256();
  let last = 0, nativeSha = null;
  const progress = (n) => { const t = performance.now(); if (t - last > 50 || n === file.size) { last = t; post({ type: 'progress', stored: n, total: file.size, net: 0 }); } };
  if (file.size <= NATIVE_MAX) {
    // One read, hashed natively while its copy is written (the two overlap), or only hashed (adopt).
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length !== file.size) throw new Fail('invalid', `${entry.path} changed while it was read`);
    const hp = digest(buf);
    if (!adopt) {
      const w = await (await dir.getFileHandle(tmp, { create: true })).createWritable();
      try {
        for (let o = 0; o < buf.length; o += READ_SLICE) { await w.write(buf.subarray(o, Math.min(buf.length, o + READ_SLICE))); progress(Math.min(buf.length, o + READ_SLICE)); }
        await w.close();
      } catch (e) { await w.abort().catch(() => {}); await remove(dir, tmp); throw opfsFail(e, entry.path); }
    }
    nativeSha = await hp;
    progress(file.size);
  } else if (adopt) {
    for (let o = 0; o < file.size; o += READ_SLICE) { h.update(new Uint8Array(await file.slice(o, Math.min(file.size, o + READ_SLICE)).arrayBuffer())); progress(Math.min(file.size, o + READ_SLICE)); }
  } else {
    const w = await (await dir.getFileHandle(tmp, { create: true })).createWritable();
    try {
      for (let o = 0; o < file.size; o += READ_SLICE) {
        const piece = new Uint8Array(await file.slice(o, Math.min(file.size, o + READ_SLICE)).arrayBuffer());
        if (o + piece.length > file.size || (piece.length === 0 && o < file.size)) throw new Error(`${entry.path} changed while it was read`);
        h.update(piece); await w.write(piece);
        progress(o + piece.length);
      }
      await w.close();
    } catch (e) { await w.abort().catch(() => {}); await remove(dir, tmp); throw opfsFail(e, entry.path); }
  }
  const sha = nativeSha ?? h.digestHex();
  if (known && sha !== entry.sha256) {
    if (!adopt) await remove(dir, tmp);
    throw new Fail('hash', `${entry.path}: the picked file does not match its expected SHA-256 (expected ${entry.sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…).`);
  }
  if (adopt) {
    let moved = false;
    await remove(dir, `${sha}.part`);
    if (typeof adopt.move === 'function') { try { await adopt.move(dir, `${sha}.part`); moved = true; } catch { /* copy below */ } }
    if (!moved) {
      const w2 = await (await dir.getFileHandle(`${sha}.part`, { create: true })).createWritable();
      try { await (await adopt.getFile()).stream().pipeTo(w2); } catch (e) { await w2.abort().catch(() => {}); await remove(dir, `${sha}.part`); throw opfsFail(e, entry.path); }
    }
  } else if (tmp !== `${sha}.part`) {
    await remove(dir, `${sha}.part`);
    const th = await dir.getFileHandle(tmp);
    let moved = false;
    if (typeof th.move === 'function') { try { await th.move(dir, `${sha}.part`); moved = true; } catch { /* copy below */ } }
    if (!moved) { const src = await th.getFile(); const w2 = await (await dir.getFileHandle(`${sha}.part`, { create: true })).createWritable(); await src.stream().pipeTo(w2); await remove(dir, tmp); }
  }
  await promote(dir, sha);
  return { sha256: sha, size: file.size, moved: !!adopt };
}

async function gc(msg) {
  const keep = new Set(msg.keep);
  const dir = await blobsDir(msg.ns);
  let removed = 0;
  const drop = [];
  for await (const [n] of dir.entries()) { const sha = n.slice(0, 64); if (!keep.has(sha)) drop.push([n, sha]); }
  for (const [n, sha] of drop) {
    await withLock(`delivery:${msg.ns}:${sha}`, async (lock) => { if (lock && await remove(dir, n)) removed++; }, { ifAvailable: true });
  }
  return { removed };
}

async function forget(msg) {
  const root = await navigator.storage.getDirectory();
  try { await (await root.getDirectoryHandle('delivery')).removeEntry(msg.ns, { recursive: true }); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  return {};
}

const active = new Map();   // ns/sha -> promise (one download per file in this worker)
self.onmessage = async ({ data: msg }) => {
  const post = (m) => self.postMessage({ id: msg.id, ...m });
  try {
    let r;
    if (msg.op === 'ensure') {
      const key = `${msg.ns}/${msg.entry.sha256}`;
      let p = active.get(key);
      if (!p) { p = ensure(msg, post).finally(() => active.delete(key)); active.set(key, p); }
      r = await p;
    } else if (msg.op === 'verify') r = await verify(msg);
    else if (msg.op === 'scrub') r = await scrub(msg);
    else if (msg.op === 'store') r = await storeFile(msg, post);
    else if (msg.op === 'gc') r = await gc(msg);
    else if (msg.op === 'forget') r = await forget(msg);
    else throw new Fail('bad-op', `unknown op ${msg.op}`);
    post({ type: 'done', ...r });
  } catch (e) {
    post({ type: 'error', code: e.code ?? 'opfs', message: e.message ?? String(e), name: e.name });
  }
};
