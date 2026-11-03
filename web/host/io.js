// One fd table for every guest thread: the WASI file and stdio calls of all
// threads are answered by a single I/O worker (io-worker.js), which owns the
// filesystem (vfs.js) and the Wasi object, and reads and writes the shared
// wasm memory directly -- so a call only ships its name and integer args.
//
// The channel is a small SharedArrayBuffer: a lock, a state word, the call,
// its result, and up to 12 args as float64 (i64 args such as offsets and
// rights fit exactly below 2^53). Callers block in Atomics.wait (workers
// only; no C code runs on the page's thread).
export const IO_BYTES = 256;
const LOCK = 0, STATE = 1, CALL = 2, RESULT = 3, ARGS_AT = 64, MAX_ARGS = 12;
// Word 8: the WebHost block's address, stored by env.web_host_ready (imports.js)
// when web_main starts; the page waits on it (Atomics.waitAsync).
export const IO_HOST_PTR = 8;
const IDLE = 0, REQ = 1, DONE = 2;

export const IO_CALLS = ['fd_write', 'fd_pwrite', 'fd_read', 'fd_pread', 'fd_seek', 'fd_tell',
  'fd_close', 'fd_sync', 'fd_datasync', 'fd_advise', 'fd_allocate', 'fd_fdstat_get',
  'fd_fdstat_set_flags', 'fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times',
  'fd_prestat_get', 'fd_prestat_dir_name', 'fd_readdir', 'path_open', 'path_filestat_get',
  'path_filestat_set_times', 'path_create_directory', 'path_remove_directory', 'path_unlink_file',
  'path_rename', 'path_readlink', 'path_symlink', 'path_link',
  'sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown'];

/** Caller side: { name: (...args) => errno } for every IO_CALLS entry. */
export function ioClient(sab) {
  const i = new Int32Array(sab), f = new Float64Array(sab, ARGS_AT, MAX_ARGS);
  const call = (n, args) => {
    while (Atomics.compareExchange(i, LOCK, 0, 1) !== 0) Atomics.wait(i, LOCK, 1, 50);
    for (let k = 0; k < args.length; k++) f[k] = Number(args[k]);
    i[CALL] = n;
    Atomics.store(i, STATE, REQ);
    Atomics.notify(i, STATE);
    for (let s; (s = Atomics.load(i, STATE)) !== DONE;) Atomics.wait(i, STATE, s);
    const r = i[RESULT];
    Atomics.store(i, STATE, IDLE);
    Atomics.notify(i, STATE);
    Atomics.store(i, LOCK, 0);
    Atomics.notify(i, LOCK, 1);
    return r;
  };
  const out = {};
  IO_CALLS.forEach((name, n) => { out[name] = (...args) => call(n, args); });
  return out;
}

/** Server side: never returns. `impl` maps names to functions returning errno. */
export function ioServe(sab, impl, onError) {
  const i = new Int32Array(sab), f = new Float64Array(sab, ARGS_AT, MAX_ARGS);
  const fns = IO_CALLS.map((n) => impl[n]);
  for (;;) {
    for (let s; (s = Atomics.load(i, STATE)) !== REQ;) Atomics.wait(i, STATE, s);
    const fn = fns[i[CALL]];
    let r = 52;   // ENOSYS
    try { if (fn) r = fn(...f) | 0; } catch (e) { r = 29; onError?.(e); }   // EIO
    i[RESULT] = r;
    Atomics.store(i, STATE, DONE);
    Atomics.notify(i, STATE);
  }
}
