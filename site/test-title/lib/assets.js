// assets.js - the asset manager: one API for a title's files, whatever they
// come from. Two content sources ("backends") share it:
//
//   HttpBackend        mode 1, server/CDN. Either a manifest URL (the asset
//                      server's /assets/manifest.json), or a base URL of a
//                      versioned bucket (R2): <base>/latest.json names the
//                      current version, <base>/v/<version>/manifest.json lists
//                      its files. Files are fetched when needed (the required
//                      set at start, groups on first use, the rest in the
//                      background), streamed into OPFS with progress, resumed
//                      with Range, checked with SHA-256 as they arrive.
//   LocalFilesBackend  mode 2, the player's own files: a folder they pick,
//                      read in the browser, checked (optionally against a
//                      manifest or a title-specific validate() hook) and kept
//                      in OPFS.
//
// Both keep files in OPFS under delivery/<ns>/blobs/<sha256> (asset-worker.js:
// written as <sha256>.part, checked, then renamed and marked) and the catalog
// they served last in delivery/<ns>/catalog.json, so a later visit starts with
// no network (mode 1, offline) or no pick (mode 2).
//
//   const assets = new AssetManager({ ns: 'boxquad', backend: new HttpBackend({ base: 'https://assets.example' }) });
//   await assets.open();                         // the catalog (latest.json -> manifest, or the stored one offline)
//   await assets.verifyStore();                  // clean up leftovers, check the stored files
//   await assets.download(assets.required(), { concurrency: 3, onProgress });
//   const buf = await assets.arrayBuffer('textures/grass.rgba');
//   await assets.loadGroup('sand');              // an on-demand group, on first use
//   await assets.prefetch();                     // everything else (offline-ready)
//
// A backend is { kind, async catalog(store) -> { catalog, offline }, async fetch(entry, ctx) }.
// catalog: { format, title, version, entry, files: [{ path, size, sha256, required?, group?, ... }] }.
import { Sha256 } from './sha256.js';

export class DeliveryError extends Error {
  /**
   * code: 'offline' (no network and nothing stored yet), 'manifest' (bad or
   * unreachable catalog), 'missing' (file not on the server / not in the
   * folder), 'hash' (integrity check failed twice), 'network' (gave up after
   * retries; the partial download is kept), 'http', 'opfs' (browser storage
   * unavailable or full), 'pick-needed' (mode 2: pick the folder again),
   * 'invalid' (the picked folder failed the title's check), 'unknown-file'.
   */
  constructor(code, message, extra = {}) { super(message); this.name = 'DeliveryError'; this.code = code; Object.assign(this, extra); }
}

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- OPFS: the catalog file (page side; blobs are written by the worker) ----------
export class OpfsStore {
  constructor(ns) { this.ns = ns; }
  static async available() {
    try { await navigator.storage.getDirectory(); return true; } catch { return false; }
  }
  async dir(create = true) {
    const root = await navigator.storage.getDirectory();
    return (await root.getDirectoryHandle('delivery', { create })).getDirectoryHandle(this.ns, { create });
  }
  async saveCatalog(catalog) {
    const fh = await (await this.dir()).getFileHandle('catalog.json', { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(catalog));
    await w.close();
  }
  async loadCatalog() {
    try { return JSON.parse(await (await (await (await this.dir(false)).getFileHandle('catalog.json')).getFile()).text()); } catch { return null; }
  }
  /** A small JSON file of this namespace (e.g. a local backend's resume index), or null. */
  async loadJson(name) {
    try { return JSON.parse(await (await (await (await this.dir(false)).getFileHandle(name)).getFile()).text()); } catch { return null; }
  }
  async saveJson(name, obj) {
    const w = await (await (await this.dir()).getFileHandle(name, { create: true })).createWritable();
    try { await w.write(JSON.stringify(obj)); await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; }
  }
  /** The stored blob (a File), or null. Trust it only after the worker verified it (AssetManager does). */
  async blob(sha256) {
    try { return await (await (await (await this.dir(false)).getDirectoryHandle('blobs')).getFileHandle(sha256)).getFile(); } catch { return null; }
  }
  async usage() { return navigator.storage.estimate?.() ?? null; }
}

// ---- the worker -------------------------------------------------------------------
class WorkerClient {
  constructor(url) {
    this.w = new Worker(url, { type: 'module', name: 'delivery-assets' });
    this.next = 1; this.pending = new Map();
    this.w.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      if (data.type === 'progress') { p.onProgress?.(data); return; }
      this.pending.delete(data.id);
      if (data.type === 'done') p.resolve(data);
      else p.reject(new DeliveryError(data.code ?? 'opfs', data.message));
    };
    this.w.onerror = (e) => { for (const p of this.pending.values()) p.reject(new DeliveryError('opfs', `asset worker failed: ${e.message}`)); this.pending.clear(); };
  }
  call(msg, onProgress) {
    const id = this.next++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, onProgress }); this.w.postMessage({ ...msg, id }); });
  }
  terminate() { this.w.terminate(); }
}

export function checkCatalog(c, where) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.files)) throw new DeliveryError('manifest', `${where}: not a manifest (no files list)`);
  for (const e of c.files) {
    if (typeof e.path !== 'string' || !Number.isSafeInteger(e.size) || !HEX64.test(e.sha256 ?? '') ||
      (e.required !== undefined && typeof e.required !== 'boolean') || (e.group !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(e.group)))
      throw new DeliveryError('manifest', `${where}: bad entry ${JSON.stringify(e).slice(0, 120)}`);
  }
  return c;
}

// ---- mode 1: over HTTP ------------------------------------------------------------------
export class HttpBackend {
  /**
   * manifestUrl: a manifest to fetch directly (revalidated each visit), or
   * base: a versioned bucket's base URL (<base>/latest.json -> <base>/v/<version>/manifest.json).
   * retries: attempts per file before 'network'.
   */
  constructor({ manifestUrl = null, base = null, fallback = null, pointer = 'latest.json', retries = 6 }) {
    if (!manifestUrl === !base) throw new Error('HttpBackend: pass manifestUrl or base');
    this.kind = 'http';
    const abs = (b) => new URL(b.endsWith('/') ? b : `${b}/`, location.href).href;
    this.base = base ? abs(base) : null;
    this.pointer = pointer;
    this.pointerUrl = this.base ? new URL(pointer, this.base).href : null;
    // fallback: a second bucket base whose latest.json is read when base has none (HTTP 404/403),
    // e.g. the bucket root while a title moves to its games/<id>/ prefix.
    this.fallback = fallback ? abs(fallback) : null;
    this.usedFallback = false;
    this.manifestUrl = manifestUrl ? new URL(manifestUrl, location.href).href : null;
    this.retries = retries;
    this.requests = { pointer: 0, manifest: 0 };
  }
  async catalog(store) {
    if (!this.base) return this.direct(store);
    try { return await this.versioned(store); } catch (e) {
      if (!this.fallback || !(e instanceof DeliveryError) || !e.status || ![403, 404].includes(e.status)) throw e;
      this.base = this.fallback; this.pointerUrl = new URL(this.pointer, this.base).href; this.fallback = null; this.usedFallback = true;
      return this.versioned(store);
    }
  }
  async storedOr(store, err, offlineOk) {
    const stored = await store.loadCatalog();
    if (stored?.source === 'http' && offlineOk) return { catalog: stored, offline: true };
    throw err;
  }
  async direct(store) {
    let res;
    try { res = await fetch(this.manifestUrl, { cache: 'no-cache' }); this.requests.manifest++; }
    catch (e) {
      return this.storedOr(store, new DeliveryError('offline', `Cannot reach ${this.manifestUrl} (${e.message}) and nothing is stored yet: the first visit needs a connection.`), true);
    }
    if (!res.ok) return this.storedOr(store, new DeliveryError('manifest', `The manifest ${this.manifestUrl} answered HTTP ${res.status}.`), res.status >= 500);
    let c;
    try { c = await res.json(); } catch (e) { throw new DeliveryError('manifest', `The manifest ${this.manifestUrl} is not valid JSON (${e.message}).`); }
    checkCatalog(c, this.manifestUrl);
    return { catalog: { ...c, source: 'http', base: this.manifestUrl }, offline: false };
  }
  async versioned(store) {
    let res;
    try { res = await fetch(this.pointerUrl, { cache: 'no-cache', mode: 'cors', credentials: 'omit' }); this.requests.pointer++; }
    catch (e) {
      return this.storedOr(store, new DeliveryError('offline', `Cannot reach ${this.pointerUrl} (${e.message}) and nothing is stored yet: the first visit needs a connection.`), true);
    }
    if (!res.ok) return this.storedOr(store, new DeliveryError('manifest', `${this.pointerUrl} answered HTTP ${res.status}.`, { status: res.status }), res.status >= 500);
    let ptr;
    try { ptr = await res.json(); } catch (e) { throw new DeliveryError('manifest', `${this.pointerUrl} is not valid JSON (${e.message}).`); }
    if (!VERSION.test(ptr?.version ?? '') || typeof ptr.manifest !== 'string' || !HEX64.test(ptr.sha256 ?? ''))
      throw new DeliveryError('manifest', `${this.pointerUrl} does not name a version (version, manifest, sha256).`);
    const manifestUrl = new URL(ptr.manifest, this.pointerUrl).href;
    if (!manifestUrl.startsWith(this.base)) throw new DeliveryError('manifest', `${this.pointerUrl} points outside ${this.base}.`);
    // Same version as stored: its manifest was checked when it was stored; nothing else to fetch.
    const stored = await store.loadCatalog();
    if (stored?.source === 'http' && stored.version === ptr.version && stored.base === manifestUrl && stored.manifestSha256 === ptr.sha256)
      return { catalog: stored, offline: false, unchanged: true };
    let body;
    try {
      const r = await fetch(manifestUrl, { mode: 'cors', credentials: 'omit' });   // immutable: the HTTP cache may answer
      this.requests.manifest++;
      if (!r.ok) throw new DeliveryError('manifest', `The manifest ${manifestUrl} answered HTTP ${r.status}.`);
      body = new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (e instanceof DeliveryError) throw e;
      return this.storedOr(store, new DeliveryError('offline', `Cannot reach ${manifestUrl} (${e.message}).`), true);
    }
    const sum = hex(await crypto.subtle.digest('SHA-256', body));
    if (sum !== ptr.sha256) throw new DeliveryError('manifest', `The manifest ${manifestUrl} does not match latest.json's SHA-256 (got ${sum.slice(0, 12)}…). Try again in a minute (an update may be on its way).`);
    let c;
    try { c = JSON.parse(new TextDecoder().decode(body)); } catch (e) { throw new DeliveryError('manifest', `The manifest ${manifestUrl} is not valid JSON (${e.message}).`); }
    checkCatalog(c, manifestUrl);
    if (c.version !== ptr.version) throw new DeliveryError('manifest', `The manifest ${manifestUrl} is version ${c.version}, latest.json says ${ptr.version}.`);
    return { catalog: { ...c, source: 'http', base: manifestUrl, manifestSha256: sum }, offline: false };
  }
  async fetch(entry, { worker, ns, onProgress, catalog }) {
    const url = new URL(entry.url ?? `files/${entry.path}`, catalog?.base ?? this.manifestUrl).href;
    return worker.call({ op: 'ensure', ns, url, entry: { path: entry.path, size: entry.size, sha256: entry.sha256, chunkSize: entry.chunkSize, chunks: entry.chunks },
      retries: this.retries }, onProgress);
  }
}

// ---- mode 2: the player's own files --------------------------------------------------
async function hashFile(file) {
  const h = new Sha256();
  for (let o = 0; o < file.size; o += 4 << 20) h.update(new Uint8Array(await file.slice(o, o + (4 << 20)).arrayBuffer()));
  return h.digestHex();
}

/**
 * files: a FileList from <input type=file webkitdirectory>, an array of File,
 * or of { path, file, adopt? }; omitted = use what an earlier pick stored.
 * adopt (hashIn 'worker'): the file's FileSystemFileHandle when it is already
 * in OPFS (an older layout of the same title): moved into the store, not copied.
 * precheck(entries) (optional, title-specific): runs before anything is
 * hashed or stored, on { path, size, file() }; throw to refuse the folder at
 * once (e.g. a game's retail-file check); may return extra catalog fields.
 * validate(entries) (optional): the same after hashing (entries carry sha256).
 * If the folder holds a delivery manifest.json, every file it lists must be
 * there with that size and SHA-256.
 * strip: 'auto' drops the picked folder's own name from the paths (one top
 * folder), false keeps the paths as given.
 * hashIn: 'page' hashes here, a slice at a time, and the files are stored when
 * fetched; 'worker' stores each file while the asset worker hashes it (one
 * pass over the bytes, for large folders). reuse (with 'worker'): files whose
 * path, size and lastModified match an earlier store of this namespace, and
 * whose blob is still good, are not read again (an interrupted import resumes;
 * the same folder picked again is not copied again).
 * extra: fields added to the catalog. onProgress({ file, files, path, done,
 * total, copied, mbps }) while storing ('worker').
 */
const REUSE_INDEX = 'local-index.json';
export class LocalFilesBackend {
  constructor({ files = null, validate = null, precheck = null, title = 'local', entry = null, strip = 'auto', hashIn = 'page',
    reuse = false, extra = null, concurrency = 2, onProgress = null } = {}) {
    this.kind = 'local';
    this.files = files; this.validate = validate; this.precheck = precheck; this.title = title; this.entryName = entry;
    this.strip = strip; this.hashIn = hashIn; this.reuse = reuse; this.extra = extra; this.concurrency = concurrency; this.onProgress = onProgress;
    this.byPath = new Map();
    this.result = null;
  }
  static entriesOf(files, { strip = 'auto' } = {}) {
    const list = [...files].map((f) => (f instanceof File ? { path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'), file: f } : f));
    // strip the picked folder's own name (webkitRelativePath = '<picked>/<path>')
    const tops = new Set(list.map((e) => e.path.split('/')[0]));
    const cut = strip === 'auto' && tops.size === 1 && list.every((e) => e.path.includes('/'));
    return list.map((e) => ({ path: cut ? e.path.slice(e.path.indexOf('/') + 1) : e.path, file: e.file, ...(e.adopt ? { adopt: e.adopt } : {}) }))
      .filter((e) => !e.path.split('/').some((s) => s.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(s)));
  }
  /** A title's refusal as a DeliveryError ('invalid'), keeping its kind and link for the page. */
  static refusal(e) {
    if (e instanceof DeliveryError) return e;
    return new DeliveryError('invalid', e.message, { kind: e.kind, link: e.link, cause: e });
  }
  async catalog(store, ctx = {}) {
    if (!this.files) {
      const stored = await store.loadCatalog();
      if (stored?.source === 'local') return { catalog: stored, offline: false, unchanged: true };
      throw new DeliveryError('pick-needed', 'Pick the folder with the files first.');
    }
    const picked = LocalFilesBackend.entriesOf(this.files, { strip: this.strip });
    if (!picked.length) throw new DeliveryError('invalid', 'The picked folder is empty.');
    const extra = { ...(this.extra ?? {}) };
    if (this.precheck) {
      try { Object.assign(extra, (await this.precheck(picked.map((p) => ({ path: p.path, size: p.file.size, file: async () => p.file })))) ?? {}); }
      catch (e) { throw LocalFilesBackend.refusal(e); }
    }
    const manifestFile = picked.find((e) => e.path === 'manifest.json');
    let expect = null;
    if (manifestFile) {
      try { expect = checkCatalog(JSON.parse(await manifestFile.file.text()), 'manifest.json in the picked folder'); }
      catch (e) { throw e instanceof DeliveryError ? e : new DeliveryError('invalid', `manifest.json in the picked folder: ${e.message}`); }
    }
    const todo = [];
    for (const p of picked) {
      if (p.path === 'manifest.json') continue;
      const want = expect?.files.find((e) => e.path === p.path);
      if (expect && !want) continue;                                 // not part of the title
      if (want && want.size !== p.file.size) throw new DeliveryError('invalid', `${p.path}: ${p.file.size} bytes, expected ${want.size}.`);
      todo.push({ p, want });
    }
    const files = this.hashIn === 'worker' && ctx.worker ? await this.storeAll(todo, store, ctx) : await this.hashAll(todo);
    for (const [i, { p, want }] of todo.entries()) {
      if (want && files[i].sha256 !== want.sha256) throw new DeliveryError('invalid', `${p.path}: SHA-256 differs from manifest.json (a changed or damaged file).`);
      this.byPath.set(p.path, p.file);
    }
    if (expect) for (const e of expect.files) if (!this.byPath.has(e.path)) throw new DeliveryError('invalid', `${e.path} is missing from the picked folder.`);
    if (this.validate) {
      try { Object.assign(extra, (await this.validate(files.map((f) => ({ ...f, file: () => this.byPath.get(f.path) })))) ?? {}); }
      catch (e) { throw LocalFilesBackend.refusal(e); }
    }
    const catalog = { format: 'delivery-manifest/2', title: expect?.title ?? this.title, entry: expect?.entry ?? this.entryName,
      version: hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(files.map((f) => `${f.path}\0${f.sha256}\n`).sort().join('')))).slice(0, 16),
      files, ...extra, source: 'local' };
    return { catalog, offline: false };
  }
  entryOf({ p, want }, sha256) {
    return { path: p.path, size: p.file.size, sha256, ...(want?.required !== undefined ? { required: want.required } : {}), ...(want?.group ? { group: want.group } : {}) };
  }
  async hashAll(todo) {
    const out = [];
    for (const t of todo) out.push(this.entryOf(t, await hashFile(t.p.file)));
    return out;
  }
  /** Store every file through the worker (it hashes while it writes); resume from the index. */
  async storeAll(todo, store, { worker, ns }) {
    const t0 = performance.now();
    const total = todo.reduce((a, t) => a + t.p.file.size, 0);
    const key = (f, path) => `${path}\0${f.size}\0${f.lastModified}`;
    const index = (this.reuse && await store.loadJson(REUSE_INDEX)) || {};
    const shas = new Array(todo.length);
    // what an earlier store of the same files left: reused if the blob is still good
    if (this.reuse) {
      const cand = todo.map((t, i) => ({ i, sha256: index[key(t.p.file, t.p.path)], size: t.p.file.size, path: t.p.path })).filter((c) => HEX64.test(c.sha256 ?? ''));
      if (cand.length) {
        const v = await worker.call({ op: 'verify', ns, entries: cand.map(({ path, sha256, size }) => ({ path, sha256, size })) });
        v.results.forEach((r, k) => { if (r.status === 'ok') shas[cand[k].i] = cand[k].sha256; });
      }
    }
    let done = 0, copied = 0, skipped = 0, filesDone = 0, last = 0;
    const live = new Map();
    const inFlight = () => [...live.values()].reduce((a, n) => a + n, 0);
    const report = (path, force) => {
      const now = performance.now();
      if (!force && now - last < 100) return;
      last = now;
      const c = copied + inFlight();
      this.onProgress?.({ file: filesDone, files: todo.length, path, done: done + inFlight(), total, copied: c,
        mbps: c / 1048576 / Math.max(0.001, (now - t0) / 1000) });
    };
    let next = 0, saving = Promise.resolve();
    const saveIndex = () => (saving = saving.then(() => store.saveJson(REUSE_INDEX, index)).catch(() => {}));
    const run = async () => {
      while (next < todo.length) {
        const i = next++, { p } = todo[i];
        if (shas[i]) { done += p.file.size; skipped++; filesDone++; report(p.path); continue; }
        live.set(i, 0);
        const r = await worker.call({ op: 'store', ns, entry: { path: p.path, size: p.file.size }, file: p.file, adopt: p.adopt ?? null },
          (m) => { live.set(i, m.stored); report(p.path); });
        live.delete(i);
        if (r.size !== p.file.size) throw new DeliveryError('invalid', `${p.path} changed while it was copied; pick the folder again.`);
        shas[i] = r.sha256; done += p.file.size; copied += p.file.size; filesDone++;
        index[key(p.file, p.path)] = r.sha256;
        saveIndex();
        report(p.path, true);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.concurrency, todo.length)) }, run));
    await saveIndex();
    const secs = (performance.now() - t0) / 1000;
    this.result = { files: todo.length, bytes: total, copied, skipped, secs, mbps: copied / 1048576 / Math.max(0.001, secs) };
    return todo.map((t, i) => this.entryOf(t, shas[i]));
  }
  async fetch(entry, { worker, ns }) {
    const file = this.byPath.get(entry.path);
    if (!file) throw new DeliveryError('pick-needed', `${entry.path} is not stored in this browser yet: pick the folder again.`);
    const r = await worker.call({ op: 'store', ns, entry: { path: entry.path, size: entry.size, sha256: entry.sha256 }, file });
    return { ...r, net: 0, stored: false, local: true };
  }
}

// ---- the manager ----------------------------------------------------------------------
export class AssetManager extends EventTarget {
  /**
   * ns: OPFS namespace (title id; one per content source is wise, e.g. 'boxquad' / 'boxquad-local').
   * workerUrl: asset-worker.js (defaults to the copy next to this file).
   * concurrency: parallel downloads for download()/prefetch()/loadGroup() (default 3).
   */
  constructor({ ns, backend, workerUrl = new URL('./asset-worker.js', import.meta.url), concurrency = 3 }) {
    super();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(ns ?? '')) throw new Error('AssetManager: ns must be a short [A-Za-z0-9._-] name');
    this.ns = ns; this.backend = backend; this.workerUrl = workerUrl; this.concurrency = concurrency;
    this.store = new OpfsStore(ns);
    this.catalog = null; this.files = new Map(); this.offline = false;
    this.inflight = new Map();
    this.verified = new Set();         // SHA-256s checked in OPFS during this session
    this.groupsLoaded = new Map();     // group -> promise
    this.stats = { netBytes: 0, resentBytes: 0, fromStore: 0, rehashed: 0, fetched: [], errors: [], verify: null, scrub: null };
  }
  async open() {
    if (!await OpfsStore.available()) throw new DeliveryError('opfs', 'This browser has no Origin Private File System (OPFS) here (a private window, or storage blocked for this site), so files cannot be kept.');
    this.worker ??= new WorkerClient(this.workerUrl);
    const { catalog, offline, unchanged } = await this.backend.catalog(this.store, { worker: this.worker, ns: this.ns });
    this.catalog = catalog; this.offline = offline; this.unchanged = !!unchanged;
    this.files = new Map(catalog.files.map((e) => [e.path, e]));
    if (!offline && !unchanged) await this.store.saveCatalog(catalog).catch((e) => { throw new DeliveryError('opfs', `Cannot write to this browser's storage (${e.message}); is it full?`); });
    this.emit('open', { catalog, offline, unchanged: !!unchanged, source: this.backend.kind });
    return catalog;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  entry(path) {
    const e = this.files.get(path);
    if (!e) throw new DeliveryError('unknown-file', `${path} is not in the ${this.backend.kind === 'http' ? 'manifest' : 'picked folder'}.`);
    return e;
  }
  /** Paths needed at start: the manifest's required files (the entry module first). */
  required() {
    const req = [...this.files.values()].filter((e) => e.required).map((e) => e.path);
    const entry = this.catalog?.entry;
    return entry ? [entry, ...req.filter((p) => p !== entry)] : req;
  }
  groups() {
    const g = {};
    for (const e of this.files.values()) if (e.group) (g[e.group] ??= []).push(e.path);
    return g;
  }
  groupOf(path) { return this.files.get(path)?.group ?? null; }
  /**
   * Start-up check of what OPFS holds for this catalog: removes leftovers
   * (.part files that cannot be resumed, swap files, marks without files),
   * then checks the stored files (by their verified mark; full: hash them all
   * again) and deletes the bad ones, which are fetched again when needed.
   * paths: what to check (default: every file).
   */
  async verifyStore({ paths = [...this.files.keys()], full = false } = {}) {
    const keep = [...this.files.values()].map((e) => ({ sha256: e.sha256, size: e.size, chunkSize: e.chunkSize, chunks: e.chunks }));
    const scrub = await this.worker.call({ op: 'scrub', ns: this.ns, keep });
    const entries = paths.map((p) => { const e = this.entry(p); return { path: p, sha256: e.sha256, size: e.size }; });
    const v = await this.worker.call({ op: 'verify', ns: this.ns, entries, full });
    const out = { ok: [], missing: [], bad: [], hashedBytes: v.hashedBytes, ms: v.ms, scrub: { removed: scrub.removed, kept: scrub.kept, truncated: scrub.truncated } };
    for (const r of v.results) {
      if (r.status === 'ok') { this.verified.add(r.sha256); out.ok.push(r.path); }
      else (r.status === 'bad' ? out.bad : out.missing).push(r.path);
    }
    this.stats.verify = { ok: out.ok.length, missing: out.missing.length, bad: out.bad, hashedBytes: out.hashedBytes, ms: out.ms, full };
    this.stats.scrub = out.scrub;
    this.emit('verify', out);
    return out;
  }
  /** Is the file in OPFS and good (no download needed)? */
  async isStored(path) {
    const e = this.entry(path);
    if (this.verified.has(e.sha256)) return true;
    const v = await this.worker.call({ op: 'verify', ns: this.ns, entries: [{ path, sha256: e.sha256, size: e.size }] });
    const ok = v.results[0]?.status === 'ok';
    if (ok) this.verified.add(e.sha256);
    return ok;
  }
  /** The file (an OPFS-backed File), fetched first if needed. */
  async get(path, { onProgress } = {}) {
    const e = this.entry(path);
    if (this.verified.has(e.sha256)) {
      const f = await this.store.blob(e.sha256);
      if (f && f.size === e.size) { this.stats.fromStore++; this.emit('progress', { path, loaded: e.size, total: e.size, percent: 100, fromStore: true }); return f; }
      this.verified.delete(e.sha256);
    }
    if (this.offline && this.backend.kind === 'http' && !await this.isStored(path))
      throw new DeliveryError('offline', `${path} was never downloaded and there is no connection now.`);
    let p = this.inflight.get(e.sha256);
    if (!p) {
      const t0 = performance.now();
      p = this.backend.fetch(e, { worker: this.worker, ns: this.ns, catalog: this.catalog, onProgress: (m) => {
        const d = { path, loaded: m.stored, total: e.size, percent: e.size ? (100 * m.stored) / e.size : 100, net: m.net };
        onProgress?.(d); this.emit('progress', d);
      } }).then((r) => {
        this.verified.add(e.sha256);
        if (r.stored) { this.stats.fromStore++; if (r.rehashed) this.stats.rehashed++; return r; }
        this.stats.netBytes += r.net ?? 0; this.stats.resentBytes += r.resent ?? 0;
        this.stats.fetched.push({ path, size: e.size, net: r.net, resent: r.resent, attempts: r.attempts, resumedFrom: r.resumedFrom,
          hashRetries: r.hashRetries, ranges: r.ranges, checkpoints: r.checkpoints, cachedBad: r.cachedBad ?? null, ms: Math.round(performance.now() - t0), local: !!r.local });
        this.emit('progress', { path, loaded: e.size, total: e.size, percent: 100, done: true });
        this.emit('fetched', { path, ...r });
        return r;
      }, (err) => { this.stats.errors.push({ path, code: err.code, message: err.message }); this.emit('error', err); throw err; })
        .finally(() => this.inflight.delete(e.sha256));
      this.inflight.set(e.sha256, p);
    }
    const r = await p;
    if (r.stored) this.emit('progress', { path, loaded: e.size, total: e.size, percent: 100, fromStore: true });
    const f = await this.store.blob(e.sha256);
    if (!f) throw new DeliveryError('opfs', `${path} was stored but cannot be read back from this browser's storage.`);
    return f;
  }
  async arrayBuffer(path, o) { return (await this.get(path, o)).arrayBuffer(); }
  async text(path, o) { return (await this.get(path, o)).text(); }
  async json(path, o) { return JSON.parse(await this.text(path, o)); }
  /**
   * Make sure `paths` are stored, `concurrency` at a time, with overall and
   * per-file progress: onProgress({ loaded, total, percent, done, count,
   * files: { [path]: { loaded, total, percent, done } } }). Resolves with
   * { fetched, fromStore, bytes }.
   */
  async download(paths, { onProgress, concurrency = this.concurrency } = {}) {
    const list = [...new Set(paths)];
    const total = list.reduce((n, p) => n + this.entry(p).size, 0);
    const files = Object.fromEntries(list.map((p) => [p, { loaded: 0, total: this.entry(p).size, percent: 0, done: false }]));
    let fetched = 0, fromStore = 0;
    const report = () => {
      const loaded = Object.values(files).reduce((a, f) => a + f.loaded, 0);
      onProgress?.({ loaded, total, percent: total ? (100 * loaded) / total : 100, done: Object.values(files).filter((f) => f.done).length, count: list.length, files });
    };
    let i = 0;
    const run = async () => {
      while (i < list.length) {
        const p = list[i++];
        const before = this.stats.fetched.length;
        await this.get(p, { onProgress: (d) => { Object.assign(files[p], { loaded: d.loaded, percent: d.percent }); report(); } });
        if (this.stats.fetched.length > before) fetched++; else fromStore++;
        Object.assign(files[p], { loaded: files[p].total, percent: 100, done: true });
        report();
      }
    };
    report();
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, run));
    return { fetched, fromStore, bytes: total };
  }
  /** Fetch every listed file not stored yet (default all): offline-ready. */
  async prefetch(paths = [...this.files.keys()], opts = {}) {
    const todo = [];
    for (const p of paths) if (!await this.isStored(p)) todo.push(p);
    const r = await this.download(todo, opts);
    return { fetched: r.fetched, bytes: r.bytes };
  }
  /** An on-demand group (the manifest's `group`), fetched once, on first use. */
  loadGroup(name, opts = {}) {
    let p = this.groupsLoaded.get(name);
    if (!p) {
      const paths = this.groups()[name];
      if (!paths) return Promise.reject(new DeliveryError('unknown-file', `No group ${name} in the manifest.`));
      const t0 = performance.now();
      p = this.download(paths, opts).then((r) => { this.emit('group', { name, ...r, ms: Math.round(performance.now() - t0) }); return r; });
      p.catch(() => this.groupsLoaded.delete(name));
      this.groupsLoaded.set(name, p);
    }
    return p;
  }
  /** Counts of stored / missing files and bytes. */
  async status() {
    const entries = [...this.files.values()].map((e) => ({ path: e.path, sha256: e.sha256, size: e.size }));
    const v = await this.worker.call({ op: 'verify', ns: this.ns, entries });
    let stored = 0, missing = 0, storedBytes = 0, missingBytes = 0;
    for (const r of v.results) {
      const e = this.files.get(r.path);
      if (r.status === 'ok') { stored++; storedBytes += e.size; this.verified.add(e.sha256); } else { missing++; missingBytes += e.size; }
    }
    return { stored, missing, storedBytes, missingBytes, offlineReady: missing === 0, version: this.catalog?.version, source: this.backend.kind };
  }
  /** Drop stored files no longer in the catalog (old versions). */
  async gc() { return this.worker.call({ op: 'gc', ns: this.ns, keep: [...this.files.values()].map((e) => e.sha256) }); }
  /** Delete everything stored for this namespace. */
  async forget() { this.worker ??= new WorkerClient(this.workerUrl); this.verified.clear(); return this.worker.call({ op: 'forget', ns: this.ns }); }
  close() { this.worker?.terminate(); this.worker = null; }
}
