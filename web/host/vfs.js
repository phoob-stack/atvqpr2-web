// The filesystem behind wasi.js. Synchronous, so it runs in a worker.
//
//   /game  the player's own game folder, read-only. Two sources:
//          - imported (the player's path, mountOpfsGame): loader.js copied
//            the folder the player picked into OPFS (atv2-game/); every file
//            is opened once with a SyncAccessHandle and read in place.
//          - dev server (developer option, mountGame): serve.mjs --game lists
//            the folder at /data/manifest.json and serves its files at
//            /data/<path> with Range support. Blocks of 1 MiB are fetched on
//            first use (a synchronous XHR, which workers may do) and cached in
//            OPFS (atv2-game-cache/), so a second boot reads nothing from the
//            server. The cache is dropped when the manifest (names, sizes,
//            mtimes) changes.
//   /save  the save side (xbox_path_init's save dir): directories and sparse
//          files in memory. Its UDATA and TDATA (the game's saves) are kept in
//          OPFS by saves.js, which watches memGen to see that something here
//          changed.
//
// Names are matched case-insensitively, as on the Xbox and on Windows.
// Nothing here is ever uploaded anywhere: reads go to the local dev server.

export const BLOCK = 1 << 20;
const MEM_CHUNK = 1 << 16;

export class FsError extends Error {
  constructor(errno, msg) { super(msg); this.errno = errno; }
}
export const E = { ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44,
  NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, ROFS: 69, SPIPE: 70 };

let inoNext = 1;
/** Bumped by every change to an in-memory file or directory (/save);
 *  MemFile.gen is the value of its last change (saves.js SaveSync). */
export const memGen = { gen: 0 };
const nowNs = () => BigInt(Math.round(Date.now() * 1e6));

export class Dir {
  constructor(name, { readOnly = false } = {}) {
    this.kind = 'dir'; this.name = name; this.readOnly = readOnly;
    this.children = new Map();      // lowercase name -> node
    this.ino = inoNext++; this.mtime = nowNs();
  }
  get(name) { return this.children.get(name.toLowerCase()); }
  add(node) { this.children.set(node.name.toLowerCase(), node); if (!this.readOnly) memGen.gen++; return node; }
  get size() { return 0; }
}

/** A sparse file in memory. */
export class MemFile {
  constructor(name) {
    this.kind = 'file'; this.name = name; this.size = 0; this.chunks = new Map();
    this.ino = inoNext++; this.mtime = nowNs();
  }
  read(pos, dst) {                  // dst: Uint8Array; returns bytes read
    const n = Math.max(0, Math.min(dst.length, this.size - pos));
    for (let done = 0; done < n;) {
      const p = pos + done, ci = Math.floor(p / MEM_CHUNK), co = p % MEM_CHUNK;
      const take = Math.min(n - done, MEM_CHUNK - co), c = this.chunks.get(ci);
      if (c) dst.set(c.subarray(co, co + take), done); else dst.fill(0, done, done + take);
      done += take;
    }
    return n;
  }
  write(pos, src) {
    for (let done = 0; done < src.length;) {
      const p = pos + done, ci = Math.floor(p / MEM_CHUNK), co = p % MEM_CHUNK;
      const take = Math.min(src.length - done, MEM_CHUNK - co);
      let c = this.chunks.get(ci);
      if (!c) this.chunks.set(ci, c = new Uint8Array(MEM_CHUNK));
      c.set(src.subarray(done, done + take), co);
      done += take;
    }
    this.size = Math.max(this.size, pos + src.length);
    this.mtime = nowNs(); this.gen = ++memGen.gen;
    return src.length;
  }
  truncate(size) {
    for (const k of [...this.chunks.keys()]) if (k * MEM_CHUNK >= size) this.chunks.delete(k);
    const ci = Math.floor(size / MEM_CHUNK);
    if (size % MEM_CHUNK && this.chunks.has(ci)) this.chunks.get(ci).fill(0, size % MEM_CHUNK);
    this.size = size; this.mtime = nowNs(); this.gen = ++memGen.gen;
  }
}

/** A read-only file of the game folder, read through the block cache. */
class GameFile {
  constructor(name, entry, cache) {
    this.kind = 'file'; this.name = name; this.size = entry.size; this.entry = entry;
    this.cache = cache; this.readOnly = true; this.ino = inoNext++;
    this.mtime = BigInt(Math.round(entry.mtime * 1e6));
  }
  read(pos, dst) {
    const n = Math.max(0, Math.min(dst.length, this.size - pos));
    for (let done = 0; done < n;) {
      const p = pos + done, bi = Math.floor(p / BLOCK), bo = p % BLOCK;
      const take = Math.min(n - done, BLOCK - bo);
      const b = this.cache.block(this.entry, bi);
      dst.set(b.subarray(bo, bo + take), done);
      done += take;
    }
    return n;
  }
  write() { throw new FsError(E.ROFS, 'game folder is read-only'); }
  truncate() { throw new FsError(E.ROFS, 'game folder is read-only'); }
}

/** A read-only game file imported into OPFS (loader.js), read in place. */
class OpfsGameFile {
  constructor(name, entry, handle) {
    this.kind = 'file'; this.name = name; this.size = entry.size; this.handle = handle;
    this.readOnly = true; this.ino = inoNext++; this.mtime = BigInt(Math.round((entry.mtime ?? 0) * 1e6));
  }
  read(pos, dst) {
    const n = Math.max(0, Math.min(dst.length, this.size - pos));
    for (let done = 0; done < n;) {
      const got = this.handle.read(dst.subarray(done, n), { at: pos + done });
      if (got <= 0) throw new FsError(E.IO, `${this.name}: short read at ${pos + done}`);
      done += got;
    }
    return n;
  }
  write() { throw new FsError(E.ROFS, 'game folder is read-only'); }
  truncate() { throw new FsError(E.ROFS, 'game folder is read-only'); }
}

/** 1 MiB blocks of the game files: memory LRU -> OPFS -> HTTP range. */
class BlockCache {
  constructor(base, manifest) {
    this.base = base; this.files = manifest.files; this.lru = new Map(); this.lruMax = 96;
    this.stats = { fetched: 0, fetchedBytes: 0, opfsHits: 0, memHits: 0, fetchMs: 0 };
    this.opfs = null;               // { handles: Map(path -> SyncAccessHandle), bitmap }
    let at = 0;
    for (const f of this.files) { f.blockBase = at; at += Math.ceil(f.size / BLOCK); }
    this.totalBlocks = at;
  }

  async openOpfs(manifestText) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('atv2-game-cache', { create: true });
      const enc = new TextEncoder(), dec = new TextDecoder();
      const mh = await (await dir.getFileHandle('manifest.json', { create: true })).createSyncAccessHandle();
      const old = new Uint8Array(mh.getSize()); mh.read(old, { at: 0 });
      const fresh = dec.decode(old) !== manifestText;
      const bh = await (await dir.getFileHandle('blocks.bin', { create: true })).createSyncAccessHandle();
      const handles = new Map();
      for (const f of this.files) {
        const name = f.path.replace(/[\\/]/g, '__');
        const h = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
        if (fresh) h.truncate(0);
        handles.set(f.path, h);
      }
      const bitmap = new Uint8Array(this.totalBlocks);
      if (fresh) {
        bh.truncate(0); bh.write(bitmap, { at: 0 }); bh.flush();
        mh.truncate(0); mh.write(enc.encode(manifestText), { at: 0 }); mh.flush();
      } else {
        bh.read(bitmap, { at: 0 });
      }
      mh.close();
      this.opfs = { handles, bitmap, bh };
      const have = bitmap.reduce((a, b) => a + b, 0);
      return `OPFS cache ${fresh ? 'new' : 'reused'}: ${have}/${this.totalBlocks} blocks present`;
    } catch (e) {
      this.opfs = null;
      return `no OPFS cache (${e.message}); blocks stay in memory only`;
    }
  }

  block(f, bi) {
    const key = f.blockBase + bi;
    let b = this.lru.get(key);
    if (b) { this.lru.delete(key); this.lru.set(key, b); this.stats.memHits++; return b; }
    const len = Math.min(BLOCK, f.size - bi * BLOCK);
    b = new Uint8Array(len);
    const o = this.opfs;
    if (o && o.bitmap[key]) {
      o.handles.get(f.path).read(b, { at: bi * BLOCK });
      this.stats.opfsHits++;
    } else {
      const t0 = performance.now();
      const x = new XMLHttpRequest();
      x.open('GET', `${this.base}/${f.path.split('/').map(encodeURIComponent).join('/')}`, false);
      x.responseType = 'arraybuffer';
      x.setRequestHeader('Range', `bytes=${bi * BLOCK}-${bi * BLOCK + len - 1}`);
      x.send();
      if (x.status !== 206 && x.status !== 200) throw new FsError(E.IO, `GET ${f.path}: ${x.status}`);
      const got = new Uint8Array(x.response);
      b.set(x.status === 200 ? got.subarray(bi * BLOCK, bi * BLOCK + len) : got.subarray(0, len));
      this.stats.fetched++; this.stats.fetchedBytes += len; this.stats.fetchMs += performance.now() - t0;
      if (o) {
        o.handles.get(f.path).write(b, { at: bi * BLOCK });
        o.bitmap[key] = 1;
        o.bh.write(o.bitmap.subarray(key, key + 1), { at: key });
      }
    }
    this.lru.set(key, b);
    if (this.lru.size > this.lruMax) this.lru.delete(this.lru.keys().next().value);
    return b;
  }

  flush() {
    if (!this.opfs) return;
    this.opfs.bh.flush();
    for (const h of this.opfs.handles.values()) h.flush();
  }
}

export class Vfs {
  constructor() { this.root = new Dir(''); this.cache = null; }

  /** Mount the game folder served at `base` (e.g. '/data') read-only at /game. */
  async mountGame(base) {
    const r = await fetch(`${base}/manifest.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${base}/manifest.json: ${r.status} (is the dev server serving the game folder?)`);
    const text = await r.text(), manifest = JSON.parse(text);
    const cache = this.cache = new BlockCache(base, manifest);
    const game = this.root.add(new Dir('game', { readOnly: true }));
    for (const f of manifest.files) {
      const parts = f.path.split('/');
      let d = game;
      for (const p of parts.slice(0, -1)) d = d.get(p) ?? d.add(new Dir(p, { readOnly: true }));
      d.add(new GameFile(parts.at(-1), f, cache));
    }
    const note = await cache.openOpfs(text);
    return { files: manifest.files.length, bytes: manifest.files.reduce((a, f) => a + f.size, 0), note };
  }

  /**
   * Mount the game folder the player imported into OPFS (loader.js; `dir` is
   * its folder under the OPFS root, e.g. 'atv2-game') read-only at /game.
   * The import's own list (.import.json) says which files are complete.
   */
  async mountOpfsGame(dirName) {
    const root = await navigator.storage.getDirectory();
    let top;
    try { top = await root.getDirectoryHandle(dirName); } catch { throw new Error('no imported game files in this browser'); }
    const mf = await (await top.getFileHandle('.import.json')).getFile();
    const manifest = JSON.parse(await mf.text());
    if (!manifest.complete) throw new Error('the game files import did not finish; choose the game folder again');
    const game = this.root.add(new Dir('game', { readOnly: true }));
    let bytes = 0;
    for (const f of manifest.files) {
      const parts = f.path.split('/');
      let d = game, h = top;
      for (const p of parts.slice(0, -1)) {
        d = d.get(p) ?? d.add(new Dir(p, { readOnly: true }));
        h = await h.getDirectoryHandle(p);
      }
      let sync;
      try { sync = await (await h.getFileHandle(parts.at(-1))).createSyncAccessHandle(); } catch (e) {
        throw new Error(`${f.path}: ${e.name === 'NoModificationAllowedError' ? 'in use by another tab of this page' : e.message}`);
      }
      if (sync.getSize() !== f.size) throw new Error(`${f.path}: ${sync.getSize()} bytes in OPFS, ${f.size} expected; choose the game folder again`);
      d.add(new OpfsGameFile(parts.at(-1), f, sync));
      bytes += f.size;
    }
    return { files: manifest.files.length, bytes, note: `imported ${new Date(manifest.importedAt).toISOString().slice(0, 10)}` +
      (manifest.skipMovies ? ', without movies' : '') };
  }

  mountMem(name) { return this.root.add(new Dir(name)); }

  /** Resolve a path relative to a directory node. Returns { node, parent, name }. */
  lookup(dir, path, { create = false, mkdir = false } = {}) {
    const parts = path.split('/').filter((p) => p && p !== '.');
    const stack = [dir];
    for (let i = 0; i < parts.length; i++) {
      const cur = stack.at(-1), p = parts[i];
      if (p === '..') { if (stack.length > 1) stack.pop(); continue; }
      if (cur.kind !== 'dir') throw new FsError(E.NOTDIR, path);
      const last = i === parts.length - 1;
      let next = cur.get(p);
      if (!next) {
        if (!last) throw new FsError(E.NOENT, path);
        if (!(create || mkdir)) return { node: null, parent: cur, name: p };
        if (cur.readOnly) throw new FsError(E.ROFS, path);
        next = cur.add(mkdir ? new Dir(p) : new MemFile(p));
        return { node: next, parent: cur, name: p, created: true };
      }
      if (last) return { node: next, parent: cur, name: p };
      stack.push(next);
    }
    return { node: stack.at(-1), parent: stack.at(-2) ?? null, name: '' };
  }

  remove(parent, name, wantDir) {
    const n = parent.get(name);
    if (!n) throw new FsError(E.NOENT, name);
    if (parent.readOnly) throw new FsError(E.ROFS, name);
    if (wantDir && n.kind !== 'dir') throw new FsError(E.NOTDIR, name);
    if (!wantDir && n.kind === 'dir') throw new FsError(E.ISDIR, name);
    if (wantDir && n.children.size) throw new FsError(E.NOTEMPTY, name);
    parent.children.delete(name.toLowerCase());
    memGen.gen++;
  }
}
