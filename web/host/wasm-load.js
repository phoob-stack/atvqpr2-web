// Fetching and compiling the game module as early and as cheaply as the
// browser allows.
//
//   const w = loadWasm(url);       // starts at once; call it before anything else is awaited
//   const module = await w.module; // WebAssembly.Module (sent to every Worker as is)
//   const lim = await w.limits;    // { min, max, shared } of the imported memory
//   w.info()                       // { mode, ms, bytes, transfer, cache } for the log
//
// - WebAssembly.compileStreaming compiles while the bytes arrive, and in
//   Chromium it is what lets V8 keep the compiled code in its code cache
//   next to the HTTP cache entry: a later load with the same response
//   (serve.mjs sends an ETag and "no-cache", so it is revalidated, 304)
//   gets the optimised code back instead of compiling again. Needs the
//   server's Content-Type: application/wasm.
// - The memory's limits: with streaming there are no bytes to read the
//   import section from, so they come from build.sh's <name>.memory.json
//   (or, without one, from the bytes, fetched again from the cache).
// - Workers get the compiled Module by postMessage (threads.js), which shares
//   the code: no Worker fetches or compiles anything.
// - Falls back to fetch + arrayBuffer + compile when streaming is missing
//   or refused (e.g. a server without the wasm MIME type).

/** The shared memory's limits from a module's import section (bytes may be
 *  just the start of the module); null if not found in them. */
export function memoryImportLimits(bytes) {
  const u = new Uint8Array(bytes);
  if (u.length < 8 || u[0] !== 0 || u[1] !== 0x61 || u[2] !== 0x73 || u[3] !== 0x6d) return null;
  let p = 8;
  const leb = () => {
    let r = 0, s = 0, b;
    do { if (p >= u.length) throw new RangeError('truncated'); b = u[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return r >>> 0;
  };
  const name = () => { const n = leb(); p += n; };
  try {
    while (p < u.length) {
      const id = u[p++], size = leb(), end = p + size;
      if (id === 2) {
        if (end > u.length) return null;
        for (let n = leb(); n--;) {
          name(); name();
          const kind = u[p++];
          if (kind === 0) leb();
          else if (kind === 1) { p++; const f = u[p++]; leb(); if (f & 1) leb(); }
          else if (kind === 2) { const f = u[p++]; const min = leb(); const max = f & 1 ? leb() : undefined; return { min, max, shared: !!(f & 2) }; }
          else if (kind === 3) { p += 2; }
          else if (kind === 4) { p++; leb(); }
        }
        return null;
      }
      if (id > 2 && id !== 0) return null;   // past the import section
      p = end;
    }
  } catch { /* truncated */ }
  return null;
}

export function loadWasm(url) {
  const t0 = performance.now();
  const info = { mode: '', ms: 0, bytes: 0, transfer: null, cache: '' };
  let whole = null;                               // the bytes, on the fallback path only
  const fallback = async (why) => {
    info.mode = `arrayBuffer (${why})`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    whole = await r.arrayBuffer();
    return WebAssembly.compile(whole);
  };
  const module = (async () => {
    let m;
    if (typeof WebAssembly.compileStreaming === 'function') {
      try {
        const r = fetch(url);
        m = await WebAssembly.compileStreaming(r);
        info.mode = 'streaming';
        const resp = await r;
        if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
      } catch (e) {
        // A TypeError is a wrong MIME type or a failed fetch; a CompileError is the module itself.
        if (e instanceof WebAssembly.CompileError) throw e;
        m = await fallback(e.message);
      }
    } else m = await fallback('no compileStreaming');
    info.ms = performance.now() - t0;
    // The whole-module entry (not the 64 KiB Range one for the limits).
    const e = performance.getEntriesByName(new URL(url, location.href).href)
      .reduce((a, x) => (!a || x.decodedBodySize > a.decodedBodySize ? x : a), null);
    if (e) {
      info.bytes = e.decodedBodySize || e.encodedBodySize || 0;
      info.transfer = e.transferSize;
      // transferSize 0 with a body: from the HTTP cache without asking; tiny: a 304 revalidation.
      info.cache = e.transferSize === 0 ? 'HTTP cache' : e.transferSize < 4096 ? 'revalidated (304)' : 'downloaded';
    }
    if (!info.bytes && whole) info.bytes = whole.byteLength;
    return m;
  })();
  // The limits: build.sh writes <name>.memory.json next to <name>.wasm. (Not
  // a Range request for the module's first bytes: in Chromium a 206 for the
  // same URL while the whole response is being cached keeps the module out
  // of the HTTP cache, and with it the V8 code cache.) Without the JSON, the
  // module's own bytes are read (from the HTTP cache by then).
  const limits = (async () => {
    try {
      const r = await fetch(url.replace(/\.wasm(\?.*)?$/, '.memory.json'));
      if (r.ok) {
        const j = await r.json();
        if (j.initialPages > 0) return { min: j.initialPages, max: j.maximumPages, shared: !!j.shared, from: 'memory.json' };
      }
    } catch { /* below */ }
    await module.catch(() => {});
    if (!whole) whole = await (await fetch(url)).arrayBuffer();
    return { ...memoryImportLimits(whole), from: 'module' };
  })();
  module.catch(() => {}); limits.catch(() => {});   // awaited later; no unhandled-rejection noise
  return { module, limits, info: () => info };
}
