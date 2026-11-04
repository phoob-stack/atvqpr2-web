// launcher.js - the small API a Play button calls.
//
//   import { Launcher } from './client/launcher.js';
//   const l = new Launcher({ ns: 'boxquad' });
//   l.useRemote('https://assets.example');       // a versioned bucket (latest.json), or
//   l.useServer('/assets/manifest.json');        // the asset server's manifest, or
//   l.useLocalFiles(fileList);                   // mode 2
//   l.addEventListener('state', (e) => ...);     // { phase, message }
//   l.addEventListener('progress', (e) => ...);  // { loaded, total, percent, path, files: { [path]: {...} } }
//   const run = await l.prepare();               // catalog, OPFS check, the required files, compile
//   await l.play(app, { canvas });               // app.start({ assets, module, launcher, ...ctx })
//   l.prefetchRest();                            // the rest in the background (offline-ready)
//
// Phases: idle -> catalog -> verifying -> downloading -> compiling -> ready ->
// running, or error (event detail { phase:'error', error: DeliveryError, message }).
// The start set is the manifest's required files (prepare({ start }) can
// name others: a list, or async (assets) => list); groups are fetched by the
// title on first use (assets.loadGroup(name)).
import { AssetManager, HttpBackend, LocalFilesBackend, DeliveryError } from './assets.js';

export { DeliveryError };

export class Launcher extends EventTarget {
  constructor({ ns, concurrency = 3 }) {
    super();
    this.ns = ns; this.concurrency = concurrency; this.assets = null; this.module = null; this.phase = 'idle';
  }
  state(phase, message, extra = {}) {
    this.phase = phase;
    this.dispatchEvent(new CustomEvent('state', { detail: { phase, message, ...extra } }));
  }
  useRemote(base, opts = {}) { this.setBackend(new HttpBackend({ base, ...opts }), this.ns); return this; }
  useServer(manifestUrl, opts = {}) { this.setBackend(new HttpBackend({ manifestUrl, ...opts }), this.ns); return this; }
  useLocalFiles(files, opts = {}) { this.setBackend(new LocalFilesBackend({ files, ...opts }), `${this.ns}-local`); return this; }
  setBackend(backend, ns) {
    this.assets?.close();
    this.assets = new AssetManager({ ns, backend, concurrency: this.concurrency });
    this.assets.addEventListener('progress', (e) => this.dispatchEvent(new CustomEvent('file-progress', { detail: e.detail })));
  }
  /** Catalog, OPFS check, then the entry module and the start files (with overall progress), then compile. */
  async prepare({ start = null, fullVerify = false } = {}) {
    if (!this.assets) throw new Error('Launcher: call useRemote(), useServer() or useLocalFiles() first');
    const t0 = performance.now();
    const timing = (this.timing = {});
    try {
      this.state('catalog', 'Checking for updates…');
      const cat = await this.assets.open();
      timing.catalogMs = Math.round(performance.now() - t0);
      const entry = cat.entry ?? cat.files.find((f) => f.path.endsWith('.wasm'))?.path;
      if (!entry) throw new DeliveryError('manifest', 'The catalog names no entry module.');
      this.state('verifying', 'Checking the files kept in this browser…');
      this.verify = await this.assets.verifyStore({ full: fullVerify });
      timing.verifyMs = Math.round(performance.now() - t0) - timing.catalogMs;
      // start: the manifest's required files, or a list, or async (assets) => list
      const startList = start === null ? this.assets.required() : typeof start === 'function' ? await start(this.assets) : start;
      const need = [entry, ...startList.filter((p) => p !== entry)];
      this.state('downloading', this.assets.offline ? 'Offline: starting from stored files' : 'Loading…');
      const t1 = performance.now();
      this.startSet = await this.assets.download(need, { concurrency: this.concurrency, onProgress: (d) => {
        const busy = Object.entries(d.files).find(([, f]) => !f.done && f.loaded > 0)?.[0] ?? Object.entries(d.files).find(([, f]) => !f.done)?.[0] ?? null;
        this.dispatchEvent(new CustomEvent('progress', { detail: { ...d, path: busy } }));
      } });
      timing.downloadMs = Math.round(performance.now() - t1);
      this.state('compiling', 'Starting…');
      this.module = await WebAssembly.compile(await this.assets.arrayBuffer(entry));
      timing.prepareMs = Math.round(performance.now() - t0);
      this.state('ready', 'Ready', { offline: this.assets.offline, version: cat.version });
      return { assets: this.assets, module: this.module, catalog: cat, offline: this.assets.offline, verify: this.verify, startSet: this.startSet };
    } catch (e) {
      const err = e instanceof DeliveryError ? e : new DeliveryError('unknown', e.message ?? String(e));
      this.state('error', err.message, { error: err, code: err.code });
      throw err;
    }
  }
  async play(app, ctx = {}) {
    if (!this.module) throw new Error('Launcher: prepare() first');
    this.state('running', 'Running');
    return app.start({ assets: this.assets, module: this.module, launcher: this, ...ctx });
  }
  /** Fetch everything not stored yet, quietly; resolves with { fetched, bytes }. */
  async prefetchRest(opts) {
    if (this.assets.offline) return { fetched: 0, bytes: 0 };
    const r = await this.assets.prefetch(undefined, { concurrency: this.concurrency, ...opts });
    await this.assets.gc().catch(() => {});
    return r;
  }
  status() { return this.assets?.status(); }
  async forget() { await this.assets?.forget(); }
}

/** Register the shell's service worker (the launcher page and its code offline). */
export async function registerShell(url = './sw.js') {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register(url, { scope: './', updateViaCache: 'none' }); } catch (e) { console.warn('service worker:', e.message); return null; }
}
