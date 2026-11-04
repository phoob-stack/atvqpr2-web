// The game page's asset source: where the game module and the game files come
// from, behind one small interface, on top of the shared delivery client
// (web/host/delivery/, synced from the delivery repository by
// web/tools/sync-delivery.mjs: its OPFS store, streaming SHA-256, .part +
// atomic writes, verification and manifest format).
//
//   const src = await gameSource({ q });        // the dev server's /data/, or the player's import
//   const st = await src.status();             // { ready, reason, record, build }
//   src.module()                               // { module, limits, info() } (wasm-load.js's shape)
//   src.ioGame()                               // what the I/O worker mounts (vfs.js)
//   src.files('/game'), await src.file(path)   // listing and reads (path in the mount)
//   src.groups(), src.loadGroup(name)          // on-demand groups (none for a local import)
//
// What a game is comes from its profile (profiles/atv2.json, game-profile/1;
// delivery's profile.js): its entry module, the mounts of the runtime's file
// system, the local source's rules (root marker, skipped folders, layout,
// optional files, checks with their messages). ATV 2's profile says
// derivedFromRetail, so its only source is the player's own files.
//
// LocalImportSource (the player's files; ATV 2's only provider): the picked
// play folder is checked (the profile's checks, then gamebuild.js checkBuild
// against deploy.js's accepted builds on the site), then stored by the
// delivery client's LocalFilesBackend: each file goes through the asset
// worker, hashed while it is written to delivery/atv2/blobs/<sha256>.part,
// renamed and marked; the catalog (delivery-manifest/2, source 'local')
// lists every file by its catalog path ('game/<disc path>', 'build/atv2.wasm')
// with size and SHA-256, plus the import's record (default.xbe's SHA-256,
// movies skipped or not, the accepted build). The I/O worker reads the files
// in place through that catalog (vfs.js mountStore). A start checks the
// stored files by their marks (verifyStore), and the module is hashed again
// against the accepted builds before it is compiled.
//
// The layout before this (atv2-game/ with .import.json, atv2-build/ with
// .build.json) is migrated once: each file is hashed where it is and moved
// into blobs/ (no second copy), the catalog is written, the old folders go.
//
// DevServerSource (local page only, never on the site): serve.mjs --game's
// /data/ and the module from /wasm/.
import { AssetManager, LocalFilesBackend, OpfsStore, DeliveryError } from './delivery/assets.js';
import { loadProfile, runChecks, skipped, layoutPath, optional, mountFiles } from './delivery/profile.js';
import { SITE } from './deploy.js';
import { checkBuild, matchBuild, BuildError, STALE_TEXT } from './gamebuild.js';
import { loadWasm, memoryImportLimits } from './wasm-load.js';

export const CACHE_DIR = 'atv2-game-cache';    // vfs.js block cache of the dev server's /data/
const PROFILE_URL = new URL('./profiles/atv2.json', import.meta.url);
const MB = (n) => (n / 1048576).toFixed(0);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

let profileP = null;
/** The game's profile (checked by delivery's profile.js). */
export const gameProfile = () => (profileP ??= loadProfile(PROFILE_URL));

/** A delivery AssetManager over what this namespace stored last (no pick, no network). */
const storedManager = (ns) => new AssetManager({ ns, backend: new LocalFilesBackend({ files: null }) });

export class LocalImportSource {
  constructor(profile) {
    this.kind = 'local';
    this.profile = profile;
    this.ns = profile.id;
    this.store = new OpfsStore(this.ns);
    this.statusP = null;
  }
  get id() { return `local:${this.ns}`; }

  /** The stored catalog (after migrating an older layout), or null. */
  async catalog() {
    await this.migrate();
    const c = await this.store.loadCatalog();
    return c?.source === 'local' && c.format === 'delivery-manifest/2' && Array.isArray(c.files) ? c : null;
  }

  /**
   * { ready, reason, record, build }: ready when the catalog is there, its
   * files are stored and good (the delivery client's marks), and (site) the
   * build is one this page accepts. reason: 'none' | 'stale' | 'nobuild' | 'damaged'.
   * record: the import as the page knew it ({ complete, game, xbeSha256,
   * skipMovies, importedAt, files: the /game files }).
   */
  status({ fresh = false } = {}) {
    if (fresh) this.statusP = null;
    return (this.statusP ??= this.computeStatus());
  }
  async computeStatus() {
    const cat = await this.catalog();
    if (!cat) return { ready: false, reason: 'none', record: null, build: null };
    const record = this.record(cat);
    const build = this.buildOf(cat);
    if (SITE && !build) return { ready: false, reason: 'nobuild', record, build: null };
    if (SITE && !build.ok) return { ready: false, reason: 'stale', record, build };
    const m = storedManager(this.ns);
    try {
      await m.open();
      const v = await m.verifyStore();
      if (v.missing.length || v.bad.length) return { ready: false, reason: 'damaged', record, build, verify: v };
      return { ready: true, reason: null, record, build, verify: { ok: v.ok.length, ms: v.ms, hashedBytes: v.hashedBytes } };
    } finally { m.close(); }
  }
  /** The import's record from the catalog alone (no file checks), or null: what the start needs before the check is done. */
  async meta() {
    const cat = await this.catalog();
    return cat ? this.record(cat) : null;
  }
  /** A cheap first look (no file checks): is there a catalog, and (site) an accepted build? Starts status() in the background. */
  async quick() {
    const cat = await this.catalog();
    const ok = !!cat && (!SITE || !!this.buildOf(cat)?.ok);
    if (ok) this.status().catch(() => {});
    return ok;
  }
  record(cat) {
    return { complete: true, version: cat.version, game: cat.game ?? this.profile.title, xbeSha256: cat.xbeSha256 ?? null,
      skipMovies: !!cat.skipMovies, importedAt: cat.importedAt ?? null,
      files: mountFiles(this.profile, cat, '/game').map((f) => ({ path: f.path, size: f.entry.size })) };
  }
  /** The kept build: { ...record, ok } (ok: this page accepts it and its file is in the catalog), or null. */
  buildOf(cat) {
    const b = cat.build;
    const f = cat.files.find((e) => e.path === this.profile.entry);
    if (!b || !f) return null;
    return { ...b, ok: f.size === b.size && f.sha256 === b.sha256 && !!matchBuild(b.size, b.sha256) };
  }

  /** The stored files under a mount: [{ path (in the mount), size, sha256 }]. */
  async files(at = '/game') {
    const cat = await this.catalog();
    return cat ? mountFiles(this.profile, cat, at).map((f) => ({ path: f.path, size: f.entry.size, sha256: f.entry.sha256 })) : [];
  }
  /** A stored file by its catalog path (an OPFS-backed File). */
  async file(path) {
    const cat = await this.catalog();
    const e = cat?.files.find((f) => f.path === path);
    if (!e) throw new DeliveryError('unknown-file', `${path} is not stored in this browser`);
    const f = await this.store.blob(e.sha256);
    if (!f || f.size !== e.size) throw new DeliveryError('missing', `${path} is missing from this browser's storage`);
    return f;
  }
  groups() { return this.profile.groups ?? {}; }
  async loadGroup() { return { fetched: 0, fromStore: 0, bytes: 0 }; }   // a local import has everything

  /** What the I/O worker mounts (vfs.js mountStore). */
  ioGame() { return { source: 'store', ns: this.ns, mounts: this.profile.mounts }; }

  /**
   * The module, the way wasm-load.js's loadWasm(url) gives a served one:
   * { module, limits, info() }. On the site it is the player's build from the
   * store, hashed again so that only an accepted build ever runs; on the
   * local page the dev server's /wasm/ (wasmUrl).
   */
  module(wasmUrl = null) {
    if (!SITE) return loadWasm(wasmUrl);
    const t0 = performance.now();
    const info = { mode: 'from this browser\'s storage (OPFS)', ms: 0, bytes: 0, transfer: null, cache: 'OPFS' };
    // The bytes are hashed and compiled at the same time (compiling runs nothing); the Module is handed
    // out only when the hash is on the accepted list, so a changed or unlisted build never runs.
    const bytes = (async () => {
      const cat = await this.catalog();
      const b = cat && this.buildOf(cat);
      if (!b) throw new BuildError('mismatch', STALE_TEXT());
      const buf = await (await this.file(this.profile.entry)).arrayBuffer();
      info.bytes = buf.byteLength;
      return { buf, want: b };
    })();
    const checked = bytes.then(async ({ buf, want }) => {
      const sha = hex(await crypto.subtle.digest('SHA-256', buf));
      info.hashMs = performance.now() - t0;
      if (sha !== want.sha256 || !matchBuild(buf.byteLength, sha)) throw new BuildError('mismatch', STALE_TEXT());
    });
    const module = Promise.all([bytes.then(({ buf }) => WebAssembly.compile(buf)), checked])
      .then(([m]) => { info.ms = performance.now() - t0; return m; });
    const limits = checked.then(() => bytes).then(({ buf }) => ({ ...memoryImportLimits(buf), from: 'module' }));
    module.catch(() => {}); limits.catch(() => {});
    return { module, limits, info: () => info };
  }

  // ---- the import -------------------------------------------------------------------
  /**
   * Check a picked folder and store it: the profile's checks (default.xbe),
   * then (on the site) the game build, then the store. scan: () => entries
   * ({ path, size, file() }, relative to the game root: scanHandle /
   * scanFileList). onPhase('validating' | 'importing' | 'done', text);
   * onProgress({ file, files, path, done, total, copied, mbps }). Throws an
   * Error for the player (a BuildError for the build). Resolves with
   * { files, bytes, copied, skipped, secs, mbps, persisted, sha, build }.
   */
  async importFolder(scan, { skipMovies = false, onProgress = () => {}, onPhase = () => {}, log = () => {} } = {}) {
    const p = this.profile, msg = p.local?.messages ?? {};
    onPhase('validating', 'Checking the folder…');
    const entries = await scan();
    const hashes = await runChecks(p, entries);
    const sha = hashes[p.local.checks[0].path];
    log(`[loader] ${msg.checked ?? 'checked'} (SHA-256 ${sha.slice(0, 16)}…); ${entries.length} files`);
    if (entries.skippedSaves) log(`[loader] left out ${entries.skippedSaves} files in the folder's UDATA/TDATA/CACHE: ` +
      "saves are not game files (Saves > Import the Windows build's save folder brings saves in)");
    let build = null;
    if (SITE) {
      onPhase('validating', 'This is ATV Quad Power Racing 2 (USA). Checking your game build (atv2.wasm)…');
      build = await checkBuild(entries);
      log(`[loader] atv2.wasm is builder ${build.match.builder}'s build (SHA-256 ${build.sha256.slice(0, 16)}…, ${build.size} bytes)`);
    }
    // Catalog paths by the profile's layout; the build's files only on the site, the optional files only when wanted.
    const files = [];
    for (const e of entries) {
      const lp = layoutPath(p, e.path);
      if (lp.prefix !== 'game/' && !SITE) continue;
      if (lp.prefix === 'game/' && skipMovies && optional(p, 'skipMovies', e.path)) continue;
      files.push({ path: lp.path, file: await e.file() });
    }
    const game = files.filter((f) => f.path.startsWith('game/'));
    const total = game.reduce((a, f) => a + f.file.size, 0);
    // Room for what is not stored yet (an earlier import of the same files is reused).
    const old = await this.store.loadCatalog();
    const have = new Set((old?.files ?? []).map((f) => `${f.path}\0${f.size}`));
    const need = files.reduce((a, f) => a + (have.has(`${f.path}\0${f.file.size}`) ? 0 : f.file.size), 0);
    const est = await navigator.storage.estimate?.().catch(() => null);
    if (est?.quota && est.quota - est.usage < need) throw new Error(`Not enough browser storage: ${MB(need)} MB needed, ` +
      `${MB(est.quota - est.usage)} MB available. Free some disk space and try again.`);
    const persisted = await navigator.storage.persist?.().catch(() => false);

    onPhase('importing', 'This is ATV Quad Power Racing 2 (USA). Copying the files into this browser…');
    const extra = { game: p.title, xbeSha256: sha, skipMovies, importedAt: Date.now(),
      ...(build ? { build: { sha256: build.sha256, size: build.size, builder: build.match.builder, atvrecomp: build.match.atvrecomp,
        xboxrecomp: build.match.xboxrecomp, manifest: build.manifest, storedAt: Date.now() } } : {}) };
    // Progress over the game files (the build's few MB are not counted, as before).
    let gameDone = 0;
    const backend = new LocalFilesBackend({ files, strip: false, hashIn: 'worker', reuse: true, title: p.id, entry: SITE ? p.entry : null, extra,
      onProgress: (q) => { gameDone = Math.min(total, q.done); onProgress({ ...q, path: String(q.path ?? '').replace(/^game\//, ''), done: gameDone, total }); } });
    const m = new AssetManager({ ns: this.ns, backend });
    this.statusP = null;
    try {
      await m.open();                                  // stores every file, then writes the catalog
      await m.gc();                                    // what an earlier import had and this one has not
    } catch (e) {
      throw e instanceof DeliveryError && e.cause ? e.cause : e;
    } finally { m.close(); }
    const r = backend.result;
    const out = { files: game.length, bytes: total, copied: Math.min(total, r.copied), skipped: r.skipped, secs: r.secs,
      mbps: r.copied / 1048576 / Math.max(0.001, r.secs), persisted };
    if (build) log(`[loader] kept the game build in this browser (delivery/${this.ns}, builder ${build.match.builder})`);
    log(`[loader] imported ${out.files} files, ${MB(out.bytes)} MB (${MB(out.copied)} MB copied, ${out.skipped} already there) ` +
      `in ${out.secs.toFixed(1)} s, ${out.mbps.toFixed(0)} MB/s; persistent storage ${persisted ? 'granted' : 'not granted'}`);
    onPhase('done', 'Done.');
    return { ...out, sha, build: build && { builder: build.match.builder, sha256: build.sha256, size: build.size } };
  }

  // ---- the older layout ------------------------------------------------------------------
  /**
   * atv2-game/ (+ atv2-build/) from before the shared store: moved into it
   * once, by the delivery worker (hash in place, move into blobs/, mark),
   * then the old folders are deleted. One tab at a time (Web Lock).
   */
  migrate() {
    return (this.migrateP ??= this.migrateOnce().catch((e) => { this.migrateP = null; throw e; }));
  }
  async migrateOnce() {
    const leg = this.profile.local?.legacy;
    if (!leg) return null;
    const run = async () => {
      const root = await navigator.storage.getDirectory();
      let top;
      try { top = await root.getDirectoryHandle(leg.game); } catch { return null; }
      if ((await this.store.loadCatalog())?.source === 'local') { await this.dropLegacy(); return null; }
      let man;
      try { man = JSON.parse(await (await (await top.getFileHandle('.import.json')).getFile()).text()); } catch { man = null; }
      if (!man?.complete) return null;                 // an unfinished import of the old page: the player picks the folder again
      const files = [];
      for (const f of man.files) {
        let d = top;
        const parts = f.path.split('/');
        for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s);
        const h = await d.getFileHandle(parts.at(-1));
        const file = await h.getFile();
        if (file.size !== f.size) return null;
        files.push({ path: layoutPath(this.profile, f.path).path, file, adopt: h });
      }
      let build = null;
      try {
        const bd = await root.getDirectoryHandle(leg.build);
        const rec = JSON.parse(await (await (await bd.getFileHandle('.build.json')).getFile()).text());
        const h = await bd.getFileHandle(this.profile.local.build.module);
        const file = await h.getFile();
        if (file.size === rec.size) { files.push({ path: this.profile.entry, file, adopt: h }); build = rec; }
      } catch { /* no build kept (the local page) */ }
      const extra = { game: man.game ?? this.profile.title, xbeSha256: man.xbeSha256, skipMovies: !!man.skipMovies, importedAt: man.importedAt,
        migratedAt: Date.now(), ...(build ? { build: { sha256: build.sha256, size: build.size, builder: build.builder, atvrecomp: build.atvrecomp,
          xboxrecomp: build.xboxrecomp, manifest: build.manifest ?? null, storedAt: build.storedAt } } : {}) };
      const backend = new LocalFilesBackend({ files, strip: false, hashIn: 'worker', title: this.profile.id, entry: build ? this.profile.entry : null, extra });
      const m = new AssetManager({ ns: this.ns, backend });
      const t0 = performance.now();
      try { await m.open(); } finally { m.close(); }
      // A build whose bytes are not what its old record said is not kept as a build.
      const cat = await this.store.loadCatalog();
      if (build && cat.files.find((f) => f.path === this.profile.entry)?.sha256 !== build.sha256) { delete cat.build; await this.store.saveCatalog(cat); }
      await this.dropLegacy();
      return { files: files.length, ms: Math.round(performance.now() - t0) };
    };
    const r = navigator.locks ? await navigator.locks.request(`delivery:${this.ns}:migrate`, run) : await run();
    if (r) this.migrated = r;
    return r;
  }
  async dropLegacy() {
    const root = await navigator.storage.getDirectory();
    for (const n of [this.profile.local.legacy.game, this.profile.local.legacy.build]) {
      try { await root.removeEntry(n, { recursive: true }); } catch { /* gone or in use */ }
    }
  }

  /** Delete the stored game files and build (and the dev cache, and an older layout). Saves stay. */
  async forget(log = () => {}) {
    this.statusP = null; this.migrateP = Promise.resolve(null);
    const m = storedManager(this.ns);
    const root = await navigator.storage.getDirectory();
    const had = await root.getDirectoryHandle('delivery').then((d) => d.getDirectoryHandle(this.ns)).then(() => true, () => false);
    // The previous page's I/O worker may still hold its file handles for a moment.
    try {
      for (let tries = 0; ; tries++) {
        try { await m.forget(); break; } catch (e) {
          if (tries > 40) throw new Error(`could not delete delivery/${this.ns}: ${e.message}`);
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } finally { m.close(); }
    if (had) log(`[loader] deleted delivery/${this.ns} (the game files and the game build) from this browser's storage`);
    for (const n of [CACHE_DIR, this.profile.local.legacy.game, this.profile.local.legacy.build]) {
      try { await root.removeEntry(n, { recursive: true }); log(`[loader] deleted ${n} from this browser's storage`); }
      catch (e) { if (e.name !== 'NotFoundError') throw new Error(`could not delete ${n}: ${e.message}`); }
    }
    this.migrateP = null;
  }
  /** Is anything of the game (a store, an older layout, the dev cache) in OPFS? */
  async hasData() {
    const root = await navigator.storage.getDirectory();
    for (const n of [CACHE_DIR, this.profile.local.legacy.game, this.profile.local.legacy.build]) { try { await root.getDirectoryHandle(n); return true; } catch { /* none */ } }
    try { await (await root.getDirectoryHandle('delivery')).getDirectoryHandle(this.ns); return true; } catch { return false; }
  }
}

/** The dev server's game folder (serve.mjs --game, /data/) and module (/wasm/); local page only. */
export class DevServerSource {
  constructor(profile, base = '/data') { this.kind = 'dev'; this.profile = profile; this.base = base; }
  get id() { return `dev:${this.base}`; }
  async status() { return { ready: true, reason: null, record: null, build: null }; }
  module(wasmUrl) { return loadWasm(wasmUrl); }
  ioGame() { return { source: 'server', base: this.base }; }
  async files() { const r = await fetch(`${this.base}/manifest.json`, { cache: 'no-store' }); return r.ok ? (await r.json()).files : []; }
  async file(path) { const r = await fetch(`${this.base}/${path.replace(/^game\//, '')}`); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return new File([await r.blob()], path); }
  groups() { return {}; }
  async loadGroup() { return { fetched: 0 }; }
  static async available(base = '/data') {
    if (SITE) return false;
    const r = await fetch(`${base}/manifest.json`, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
    return !!r?.ok;
  }
}

let localP = null;
/** The page's one LocalImportSource (ATV 2's profile). */
export const localSource = () => (localP ??= gameProfile().then((p) => new LocalImportSource(p)));
