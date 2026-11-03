// wasi-min.js - the smallest WASI (preview1) a threaded test module needs, in
// the `makeImports` shape threads.js expects. Test infrastructure; the game
// page uses wasm-host's full WASI. The thread-relevant rules it shows (and
// that the full one must follow too, WASM-THREADS.md):
//  - clocks: one epoch for every Worker, performance.timeOrigin + now(), so
//    a deadline computed on one thread means the same instant on another;
//  - poll_oneoff on clocks sleeps in Atomics.wait (never spins);
//  - sched_yield returns at once;
//  - text from shared memory is copied before TextDecoder (it refuses
//    SharedArrayBuffer views in browsers);
//  - proc_exit throws { wasiExit: true, code } so threads.js can unwind.

// Node: write straight to the fd. Worker console output is forwarded to the
// main thread asynchronously and is lost when the process exits right after.
const nodeFs = typeof process !== 'undefined' && process.versions && process.versions.node
  ? await import('node:fs') : null;
// Browser: Worker consoles are not the page's; lines go to the page over a
// BroadcastChannel (edge.html collects them).
const outChannel = !nodeFs && typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('wasm-stdout') : null;

import { sharedMonotonicNs } from '../../host/threads.js';

const ENOSYS = 52, EBADF = 8, EINVAL = 28, ENOENT = 44, SUCCESS = 0;

export function makeImports(ctx) {
  const mem = ctx.memory;
  const dv = () => new DataView(mem.buffer);
  const u8 = () => new Uint8Array(mem.buffer);
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const lines = { 1: '', 2: '' };
  const sleepCell = new Int32Array(new SharedArrayBuffer(4));
  const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  const envList = Object.entries(ctx.env || {}).map(([k, v]) => enc.encode(`${k}=${v}\0`));
  const argList = (ctx.args || ['test']).map((a) => enc.encode(`${a}\0`));

  function putStrings(list, ptrs, buf) {
    const d = dv(), m = u8();
    for (const s of list) {
      d.setUint32(ptrs, buf, true); ptrs += 4;
      m.set(s, buf); buf += s.length;
    }
    return SUCCESS;
  }
  function sizes(list, countPtr, sizePtr) {
    const d = dv();
    d.setUint32(countPtr, list.length, true);
    d.setUint32(sizePtr, list.reduce((n, s) => n + s.length, 0), true);
    return SUCCESS;
  }
  function out(fd, text) {
    lines[fd] += text;
    let i;
    while ((i = lines[fd].indexOf('\n')) >= 0) {
      const line = lines[fd].slice(0, i);
      lines[fd] = lines[fd].slice(i + 1);
      if (nodeFs) nodeFs.writeSync(fd, line + '\n');
      else if (outChannel) outChannel.postMessage({ fd, line });
      else (fd === 2 ? console.error : console.log)(line);
    }
  }

  const wasi = {
    args_get: (p, b) => putStrings(argList, p, b),
    args_sizes_get: (c, s) => sizes(argList, c, s),
    environ_get: (p, b) => putStrings(envList, p, b),
    environ_sizes_get: (c, s) => sizes(envList, c, s),
    clock_res_get: (id, p) => { dv().setBigUint64(p, 1000n, true); return SUCCESS; },
    // MONOTONIC (1) and the CPU-time clocks: shared and never decreasing
    // across Workers (threads.js sharedMonotonicNs); REALTIME (0) as is.
    clock_time_get: (id, prec, p) => {
      dv().setBigUint64(p, id === 0 || !ctx.ctl ? nowNs() : sharedMonotonicNs(ctx.ctl), true);
      return SUCCESS;
    },
    fd_write: (fd, iovs, n, nw) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      const d = dv(); let total = 0, text = '';
      for (let i = 0; i < n; i++) {
        const ptr = d.getUint32(iovs + i * 8, true), len = d.getUint32(iovs + i * 8 + 4, true);
        text += dec.decode(u8().slice(ptr, ptr + len));
        total += len;
      }
      out(fd, text);
      d.setUint32(nw, total, true);
      return SUCCESS;
    },
    fd_read: () => EBADF,
    fd_close: () => SUCCESS,
    fd_seek: () => EBADF,
    fd_tell: () => EBADF,
    fd_sync: () => SUCCESS,
    fd_fdstat_get: (fd, p) => {
      if (fd > 2) return EBADF;
      const d = dv();
      d.setUint8(p, fd === 0 ? 2 : 2); // character device
      d.setUint16(p + 2, 0, true);
      d.setBigUint64(p + 8, 0xffffffffn, true);
      d.setBigUint64(p + 16, 0xffffffffn, true);
      return SUCCESS;
    },
    fd_fdstat_set_flags: () => SUCCESS,
    fd_filestat_get: () => EBADF,
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    fd_readdir: () => EBADF,
    path_open: () => ENOENT,
    path_filestat_get: () => ENOENT,
    path_create_directory: () => ENOSYS,
    path_unlink_file: () => ENOSYS,
    path_remove_directory: () => ENOSYS,
    path_rename: () => ENOSYS,
    random_get: (p, n) => { const t = new Uint8Array(n); crypto.getRandomValues(t); u8().set(t, p); return SUCCESS; },
    sched_yield: () => SUCCESS,
    proc_raise: () => ENOSYS,
    proc_exit: (code) => { out(1, '\n'); out(2, '\n'); throw { wasiExit: true, code }; },
    // Clock subscriptions only: sleep in Atomics.wait until the earliest.
    poll_oneoff: (inp, outp, nsubs, neventsPtr) => {
      const d = dv();
      let soonest = null, which = -1;
      const now = nowNs();
      for (let i = 0; i < nsubs; i++) {
        const s = inp + i * 48;
        if (d.getUint8(s + 8) !== 0) return ENOSYS; // only clocks
        const timeout = d.getBigUint64(s + 24, true);
        const abs = (d.getUint16(s + 40, true) & 1) !== 0;
        const at = abs ? timeout : now + timeout;
        if (soonest === null || at < soonest) { soonest = at; which = i; }
      }
      if (soonest !== null) {
        for (;;) {
          const left = Number(soonest - nowNs()) / 1e6;
          if (left <= 0) break;
          Atomics.wait(sleepCell, 0, 0, left);
        }
        const e = outp;
        d.setBigUint64(e, d.getBigUint64(inp + which * 48, true), true); // userdata
        d.setUint16(e + 8, 0, true);
        d.setUint8(e + 10, 0);
        d.setUint32(neventsPtr, 1, true);
      } else {
        d.setUint32(neventsPtr, 0, true);
      }
      return SUCCESS;
    },
  };
  return { wasi_snapshot_preview1: wasi };
}
