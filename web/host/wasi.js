// A small WASI preview1 implementation over vfs.js, for the game module.
// Synchronous (runs in a worker). What the module imports today:
//   args/environ, clocks, fd_* (read/write/pread/pwrite/seek/tell/close/
//   fdstat/filestat/readdir/prestat/sync), path_* (open/filestat/
//   create_directory/remove_directory/unlink_file/rename), poll_oneoff
//   (sleeps only), proc_exit, sched_yield, random_get.
// stdout/stderr go to onLog(fd, text) line by line.
//
// Threads: every guest thread's worker needs these imports over the SAME fd
// table, so with more than one thread the fd table lives in one place (an I/O
// worker answering an RPC slot; wasm-threads). makeWasi() is written so that
// split is mechanical: all state is in `this`, all calls are synchronous.
import { FsError, E } from './vfs.js';

const FT = { UNKNOWN: 0, CHAR: 2, DIR: 3, FILE: 4 };
const RIGHTS_ALL = 0x1fffffffn;

// proc_exit throws this; `wasiExit` is what wasm-threads' thread-worker.js
// looks for.
export class ExitStatus extends Error {
  constructor(code) { super(`exit(${code})`); this.code = code; this.wasiExit = true; }
}

export class Wasi {
  constructor({ vfs, args = ['atv2'], env = {}, preopens = { '/game': 'game', '/save': 'save' }, onLog }) {
    this.vfs = vfs; this.args = args; this.env = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    this.onLog = onLog ?? ((fd, s) => console.log(s));
    this.memory = null;
    this.fds = new Map();
    this.lineBuf = { 1: '', 2: '' };
    this.dec = new TextDecoder(); this.enc = new TextEncoder();
    this.fds.set(0, { kind: 'stdio' }); this.fds.set(1, { kind: 'stdio' }); this.fds.set(2, { kind: 'stdio' });
    let fd = 3;
    if (vfs) for (const [guest, top] of Object.entries(preopens))
      this.fds.set(fd++, { kind: 'node', node: vfs.root.get(top), preopen: guest, pos: 0 });
    this.nextFd = fd;
    this.sleepCell = new Int32Array(new SharedArrayBuffer(4));
    this.t0 = performance.now();
    this.trace = false;
  }

  // ---- memory helpers ------------------------------------------------------
  get dv() { return new DataView(this.memory.buffer); }
  get u8() { return new Uint8Array(this.memory.buffer); }
  str(ptr, len) { return this.dec.decode(this.u8.slice(ptr, ptr + len)); }
  iovs(ptr, n) {
    const dv = this.dv, out = [];
    for (let i = 0; i < n; i++) out.push([dv.getUint32(ptr + i * 8, true), dv.getUint32(ptr + i * 8 + 4, true)]);
    return out;
  }
  fd(n) { const f = this.fds.get(n); if (!f) throw new FsError(E.BADF, `fd ${n}`); return f; }
  log(fd, bytes) {
    const s = this.lineBuf[fd] + this.dec.decode(bytes);
    const cut = s.lastIndexOf('\n');
    if (cut < 0) { this.lineBuf[fd] = s; return; }
    this.lineBuf[fd] = s.slice(cut + 1);
    this.onLog(fd, s.slice(0, cut));
  }
  flushLogs() { for (const fd of [1, 2]) if (this.lineBuf[fd]) { this.onLog(fd, this.lineBuf[fd]); this.lineBuf[fd] = ''; } }

  filestat(ptr, node) {
    const dv = this.dv;
    dv.setBigUint64(ptr, 1n, true);
    dv.setBigUint64(ptr + 8, BigInt(node.ino ?? 0), true);
    dv.setUint8(ptr + 16, node.kind === 'dir' ? FT.DIR : FT.FILE);
    dv.setBigUint64(ptr + 24, 1n, true);
    dv.setBigUint64(ptr + 32, BigInt(node.size), true);
    const t = node.mtime ?? 0n;
    dv.setBigUint64(ptr + 40, t, true); dv.setBigUint64(ptr + 48, t, true); dv.setBigUint64(ptr + 56, t, true);
  }

  // ---- the imports ---------------------------------------------------------
  imports() {
    const self = this;
    // wasm i32 arguments arrive signed; pointers above 2 GB (the runtime's
    // data and heap sit at 0x84100000+) must be read as unsigned.
    const wrap = (name, fn) => (...a) => {
      for (let k = 0; k < a.length; k++) if (typeof a[k] === 'number') a[k] >>>= 0;
      try {
        const r = fn.apply(self, a);
        if (self.trace) self.onLog(2, `[wasi] ${name}(${a.join(',')}) = ${r ?? 0}`);
        return r ?? 0;
      } catch (e) {
        if (e instanceof FsError) {
          if (self.trace) self.onLog(2, `[wasi] ${name}: errno ${e.errno} ${e.message}`);
          return e.errno;
        }
        throw e;
      }
    };
    const out = {};
    for (const [name, fn] of Object.entries(SYSCALLS)) out[name] = wrap(name, fn);
    return out;
  }
}

// What every thread answers itself; the rest (files, stdio) goes to the one
// fd table in the I/O worker (io.js).
export const LOCAL_CALLS = ['args_sizes_get', 'args_get', 'environ_sizes_get', 'environ_get',
  'clock_res_get', 'clock_time_get', 'poll_oneoff', 'sched_yield', 'random_get', 'proc_exit', 'proc_raise'];

const SYSCALLS = {
  args_sizes_get(argc, bufsz) {
    const dv = this.dv;
    dv.setUint32(argc, this.args.length, true);
    dv.setUint32(bufsz, this.args.reduce((a, s) => a + this.enc.encode(s).length + 1, 0), true);
  },
  args_get(argv, buf) { putStrings(this, this.args, argv, buf); },
  environ_sizes_get(cnt, bufsz) {
    const dv = this.dv;
    dv.setUint32(cnt, this.env.length, true);
    dv.setUint32(bufsz, this.env.reduce((a, s) => a + this.enc.encode(s).length + 1, 0), true);
  },
  environ_get(envp, buf) { putStrings(this, this.env, envp, buf); },

  clock_res_get(id, out) { this.dv.setBigUint64(out, 1000n, true); },
  clock_time_get(id, precision, out) {
    let ns;
    if (id === 0) ns = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
    else ns = BigInt(Math.round(performance.now() * 1e6));
    this.dv.setBigUint64(out, ns, true);
  },

  fd_write(fd, iovs, n, nwritten) {
    let total = 0;
    if (fd === 1 || fd === 2) {
      for (const [p, l] of this.iovs(iovs, n)) { this.log(fd, this.u8.slice(p, p + l)); total += l; }
    } else {
      const f = this.fd(fd);
      if (f.kind !== 'node' || f.node.kind !== 'file') throw new FsError(E.BADF, 'write');
      if (f.append) f.pos = f.node.size;
      for (const [p, l] of this.iovs(iovs, n)) { total += f.node.write(f.pos, this.u8.slice(p, p + l)); f.pos += l; }
    }
    this.dv.setUint32(nwritten, total, true);
  },
  fd_pwrite(fd, iovs, n, offset, nwritten) {
    const f = this.fd(fd);
    if (f.kind !== 'node' || f.node.kind !== 'file') throw new FsError(E.BADF, 'pwrite');
    let pos = Number(offset), total = 0;
    for (const [p, l] of this.iovs(iovs, n)) { total += f.node.write(pos, this.u8.slice(p, p + l)); pos += l; }
    this.dv.setUint32(nwritten, total, true);
  },
  fd_read(fd, iovs, n, nread) {
    const f = this.fd(fd);
    if (f.kind === 'stdio') { this.dv.setUint32(nread, 0, true); return; }
    if (f.node.kind !== 'file') throw new FsError(E.ISDIR, 'read');
    let total = 0;
    for (const [p, l] of this.iovs(iovs, n)) {
      const got = readInto(this, f.node, f.pos, p, l);
      f.pos += got; total += got;
      if (got < l) break;
    }
    this.dv.setUint32(nread, total, true);
  },
  fd_pread(fd, iovs, n, offset, nread) {
    const f = this.fd(fd);
    if (f.kind !== 'node' || f.node.kind !== 'file') throw new FsError(E.BADF, 'pread');
    let pos = Number(offset), total = 0;
    for (const [p, l] of this.iovs(iovs, n)) {
      const got = readInto(this, f.node, pos, p, l);
      pos += got; total += got;
      if (got < l) break;
    }
    this.dv.setUint32(nread, total, true);
  },
  fd_seek(fd, offset, whence, out) {
    const f = this.fd(fd);
    if (f.kind !== 'node') throw new FsError(E.SPIPE, 'seek');
    const base = whence === 0 ? 0 : whence === 1 ? f.pos : f.node.size;
    const pos = base + Number(offset);
    if (pos < 0) throw new FsError(E.INVAL, 'seek');
    f.pos = pos;
    this.dv.setBigUint64(out, BigInt(pos), true);
  },
  fd_tell(fd, out) { this.dv.setBigUint64(out, BigInt(this.fd(fd).pos ?? 0), true); },
  fd_close(fd) { this.fd(fd); if (fd > 2 && !this.fds.get(fd).preopen) this.fds.delete(fd); },
  fd_sync() {}, fd_datasync() {}, fd_advise() {}, fd_allocate() {},
  fd_fdstat_get(fd, out) {
    const f = this.fd(fd), dv = this.dv;
    const ft = f.kind === 'stdio' ? FT.CHAR : f.node.kind === 'dir' ? FT.DIR : FT.FILE;
    dv.setUint8(out, ft); dv.setUint16(out + 2, f.append ? 1 : 0, true);
    dv.setBigUint64(out + 8, RIGHTS_ALL, true); dv.setBigUint64(out + 16, RIGHTS_ALL, true);
  },
  fd_fdstat_set_flags(fd, flags) { const f = this.fd(fd); f.append = !!(flags & 1); },
  fd_filestat_get(fd, out) {
    const f = this.fd(fd);
    if (f.kind === 'stdio') { new Uint8Array(this.memory.buffer, out, 64).fill(0); this.dv.setUint8(out + 16, FT.CHAR); return; }
    this.filestat(out, f.node);
  },
  fd_filestat_set_size(fd, size) {
    const f = this.fd(fd);
    if (f.kind !== 'node' || f.node.kind !== 'file') throw new FsError(E.BADF, 'truncate');
    f.node.truncate(Number(size));
  },
  fd_filestat_set_times() {},
  fd_prestat_get(fd, out) {
    const f = this.fds.get(fd);
    if (!f || !f.preopen) return E.BADF;
    this.dv.setUint8(out, 0);
    this.dv.setUint32(out + 4, this.enc.encode(f.preopen).length, true);
  },
  fd_prestat_dir_name(fd, ptr, len) {
    const f = this.fds.get(fd);
    if (!f || !f.preopen) return E.BADF;
    this.u8.set(this.enc.encode(f.preopen).subarray(0, len), ptr);
  },
  fd_readdir(fd, buf, len, cookie, used) {
    const f = this.fd(fd);
    if (f.kind !== 'node' || f.node.kind !== 'dir') throw new FsError(E.NOTDIR, 'readdir');
    const entries = [['.', f.node], ['..', f.node], ...[...f.node.children.values()].map((n) => [n.name, n])];
    const dv = this.dv, u8 = this.u8;
    let at = 0;
    for (let i = Number(cookie); i < entries.length && at < len; i++) {
      const [name, n] = entries[i], nb = this.enc.encode(name);
      const head = new Uint8Array(24), hv = new DataView(head.buffer);
      hv.setBigUint64(0, BigInt(i + 1), true); hv.setBigUint64(8, BigInt(n.ino ?? 0), true);
      hv.setUint32(16, nb.length, true); hv.setUint8(20, n.kind === 'dir' ? FT.DIR : FT.FILE);
      const rec = new Uint8Array(24 + nb.length); rec.set(head); rec.set(nb, 24);
      const take = Math.min(rec.length, len - at);
      u8.set(rec.subarray(0, take), buf + at);
      at += take;
    }
    dv.setUint32(used, at, true);
  },

  path_open(dirfd, dirflags, path, pathLen, oflags, rightsBase, rightsInh, fdflags, outFd) {
    const d = this.fd(dirfd), p = this.str(path, pathLen);
    const creat = oflags & 1, directory = oflags & 2, excl = oflags & 4, trunc = oflags & 8;
    const wantWrite = (BigInt(rightsBase) & 0x40n) !== 0n;   // fd_write right
    const r = this.vfs.lookup(d.node, p, { create: !!creat });
    if (!r.node) throw new FsError(E.NOENT, p);
    if (excl && !r.created) throw new FsError(E.EXIST, p);
    if (directory && r.node.kind !== 'dir') throw new FsError(E.NOTDIR, p);
    if (trunc && r.node.kind === 'file') r.node.truncate(0);
    if (wantWrite && r.node.readOnly && r.node.kind === 'file' && this.trace)
      this.onLog(2, `[wasi] ${p}: opened for writing on the read-only game folder (writes will fail)`);
    const fd = this.nextFd++;
    this.fds.set(fd, { kind: 'node', node: r.node, pos: 0, append: !!(fdflags & 1), path: p });
    this.dv.setUint32(outFd, fd, true);
  },
  path_filestat_get(dirfd, flags, path, pathLen, out) {
    const r = this.vfs.lookup(this.fd(dirfd).node, this.str(path, pathLen));
    if (!r.node) throw new FsError(E.NOENT, 'stat');
    this.filestat(out, r.node);
  },
  path_filestat_set_times() {},
  path_create_directory(dirfd, path, pathLen) {
    const r = this.vfs.lookup(this.fd(dirfd).node, this.str(path, pathLen), { mkdir: true });
    if (!r.created) throw new FsError(E.EXIST, 'mkdir');
  },
  path_remove_directory(dirfd, path, pathLen) {
    const r = this.vfs.lookup(this.fd(dirfd).node, this.str(path, pathLen));
    if (!r.node) throw new FsError(E.NOENT, 'rmdir');
    this.vfs.remove(r.parent, r.name, true);
  },
  path_unlink_file(dirfd, path, pathLen) {
    const r = this.vfs.lookup(this.fd(dirfd).node, this.str(path, pathLen));
    if (!r.node) throw new FsError(E.NOENT, 'unlink');
    this.vfs.remove(r.parent, r.name, false);
  },
  path_rename(fd, oldPath, oldLen, newFd, newPath, newLen) {
    const a = this.vfs.lookup(this.fd(fd).node, this.str(oldPath, oldLen));
    if (!a.node) throw new FsError(E.NOENT, 'rename');
    const b = this.vfs.lookup(this.fd(newFd).node, this.str(newPath, newLen));
    if (a.parent.readOnly || b.parent.readOnly) throw new FsError(E.ROFS, 'rename');
    a.parent.children.delete(a.name.toLowerCase());
    a.node.name = b.name;
    b.parent.add(a.node);
  },
  path_readlink() { return E.INVAL; },
  path_symlink() { return E.NOTSUP; },
  path_link() { return E.NOTSUP; },

  poll_oneoff(inPtr, outPtr, nsubs, nevents) {
    // Clock subscriptions only (sleep, nanosleep, usleep).
    const dv = this.dv;
    let wait = 0, n = 0;
    for (let i = 0; i < nsubs; i++) {
      const s = inPtr + i * 48;
      if (dv.getUint8(s + 8) !== 0) continue;
      const id = dv.getUint32(s + 16, true), t = dv.getBigUint64(s + 24, true), abs = dv.getUint16(s + 40, true) & 1;
      let ms = Number(t) / 1e6;
      if (abs) ms -= id === 0 ? Date.now() : performance.now();
      wait = Math.max(wait, ms);
      const e = outPtr + n * 32;
      dv.setBigUint64(e, dv.getBigUint64(s, true), true);
      dv.setUint16(e + 8, 0, true); dv.setUint8(e + 10, 0);
      n++;
    }
    if (wait > 0) Atomics.wait(this.sleepCell, 0, 0, wait);
    dv.setUint32(nevents, n, true);
  },
  sched_yield() {},
  random_get(buf, len) {
    const tmp = new Uint8Array(len);
    for (let i = 0; i < len; i += 65536) crypto.getRandomValues(tmp.subarray(i, Math.min(len, i + 65536)));
    this.u8.set(tmp, buf);
  },
  proc_exit(code) { this.flushLogs(); throw new ExitStatus(code); },
  proc_raise() { return E.NOSYS; },
  sock_accept() { return E.NOSYS; }, sock_recv() { return E.NOSYS; },
  sock_send() { return E.NOSYS; }, sock_shutdown() { return E.NOSYS; },
};

function putStrings(w, list, ptrs, buf) {
  const dv = w.dv, u8 = w.u8;
  for (const s of list) {
    const b = w.enc.encode(s);
    dv.setUint32(ptrs, buf, true); ptrs += 4;
    u8.set(b, buf); u8[buf + b.length] = 0; buf += b.length + 1;
  }
}

function readInto(w, node, pos, ptr, len) {
  const tmp = new Uint8Array(len);
  const got = node.read(pos, tmp);
  w.u8.set(got === len ? tmp : tmp.subarray(0, got), ptr);
  return got;
}
