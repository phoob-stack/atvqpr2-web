// manifest.mjs - the asset manifest and the two layouts it is served from.
//
// manifest.json (format delivery-manifest/2):
//   { format, title, name, version, entry, build: { titleVersion, pipeline },
//     files: [ { path, size, sha256, url, type,
//                required: true|false,            // needed before the title starts
//                group?: 'name',                  // fetched together, on first use
//                compress?: true,                 // worth gzip/brotli on the wire
//                chunkSize?, chunks?: [sha256..], // per-chunk hashes (files > chunkSize)
//                artifact?: { source: [{path, sha256}], toolchain, command } } ] }
// version is '<titleVersion>-<12 hex>': the hex is the SHA-256 of everything
// the manifest says about the files (paths, sizes, hashes, flags, groups,
// chunk lists, artifacts) and the title fields. No clock or commit goes in,
// so the same inputs give the same version and the same bytes (reproducible),
// and any change gives a new version.
//
// 1. Asset-server layout (writeLayout; what server/asset-server.mjs serves at /assets/):
//      manifest.json                 the catalog (no-cache)
//      objects/<aa>/<sha256>         every file by content (immutable)
// 2. Versioned bucket layout (writeVersionedTree; what goes to R2), one per
//    title under its profile's prefix games/<id>/ (client/profile.js):
//      latest.json                   { format: 'delivery-latest/1', title, version,
//                                      manifest: 'v/<version>/manifest.json', sha256, size }   (public, max-age=30)
//      v/<version>/manifest.json     the catalog of that version (immutable)
//      v/<version>/<path>            every file by its path (immutable; url = <path>)
//    A release uploads v/<version>/ first and latest.json last; older v/ trees
//    stay, so rollback is pointing latest.json at one of them again.
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as Z } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { SAFE_REL, nameProblems } from './verify-package.mjs';

export const FORMAT = 'delivery-manifest/2';
export const LATEST_FORMAT = 'delivery-latest/1';
export const DEFAULT_CHUNK = 1 << 20;
// Cache-Control of the bucket's objects: versioned ones never change; the pointer is revalidated on every visit.
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_POINTER = 'public, max-age=30';   // short: updates and rollbacks reach browsers and the edge within 30 s
export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$/;
const TYPES = { '.wasm': 'application/wasm', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8' };
export const typeOf = (path) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * files: [{ path, abs, artifact? }] (path = logical, posix).
 * delivery: { title, name, titleVersion, entry, required: [path], groups: { name: [path] } } (title/delivery.json).
 * Returns { manifest, bodies: Map(path -> Buffer) } with url left to the layout.
 */
export function buildManifest(files, delivery, { chunkSize = DEFAULT_CHUNK } = {}) {
  const required = new Set(delivery.required ?? []);
  const groupOf = new Map();
  for (const [g, paths] of Object.entries(delivery.groups ?? {})) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(g)) throw new Error(`bad group name ${g}`);
    for (const p of paths) { if (groupOf.has(p)) throw new Error(`${p} is in two groups`); groupOf.set(p, g); }
  }
  const known = new Set(files.map((f) => f.path));
  for (const p of [...required, ...groupOf.keys(), delivery.entry].filter(Boolean)) if (!known.has(p)) throw new Error(`the profile names ${p}, which the build did not make`);
  for (const p of required) if (groupOf.has(p)) throw new Error(`${p} is required and in a group`);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(delivery.titleVersion ?? '')) throw new Error('the profile: titleVersion must be N.N.N');
  const entries = [];
  const bodies = new Map();
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!SAFE_REL.test(f.path)) throw new Error(`unsafe asset path: ${f.path}`);
    if (f.path === 'manifest.json' || f.path === 'latest.json') throw new Error(`${f.path} is a reserved name in the asset layouts`);
    const why = nameProblems(f.path, { allowWasm: !!f.artifact });
    if (why.length) throw new Error(`refused asset ${f.path}: ${why.join('; ')}`);
    const body = readFileSync(f.abs);
    const sum = sha(body);
    const e = { path: f.path, size: body.length, sha256: sum, type: typeOf(f.path), required: required.has(f.path) || f.path === delivery.entry };
    if (groupOf.has(f.path)) e.group = groupOf.get(f.path);
    // Worth compressing on the wire? (a quick brotli; the asset server compresses on the fly)
    if (body.length >= 1024) {
      const probe = body.length > 2 << 20 ? body.subarray(0, 2 << 20) : body;
      const c = brotliCompressSync(probe, { params: { [Z.BROTLI_PARAM_QUALITY]: 4 } });
      if (c.length < probe.length * 0.9) e.compress = true;
    }
    if (body.length > chunkSize) {
      e.chunkSize = chunkSize;
      e.chunks = [];
      for (let o = 0; o < body.length; o += chunkSize) e.chunks.push(sha(body.subarray(o, o + chunkSize)));
    }
    if (f.artifact) e.artifact = { source: f.artifact.source, toolchain: f.artifact.toolchain, command: f.artifact.command };
    entries.push(e);
    bodies.set(f.path, body);
  }
  const head = { format: FORMAT, title: delivery.title, name: delivery.name ?? delivery.title, entry: delivery.entry,
    build: { titleVersion: delivery.titleVersion, pipeline: 'delivery-pipeline/2' } };
  const version = `${delivery.titleVersion}-${sha(JSON.stringify({ head, entries })).slice(0, 12)}`;
  return { manifest: { format: FORMAT, title: head.title, name: head.name, version, entry: head.entry, build: head.build, files: entries }, bodies };
}

const json = (o) => JSON.stringify(o, null, 1) + '\n';

/** Layout 1 (asset server): manifest.json + objects/<aa>/<sha256>.
 *  built: buildManifest()'s result, or (as before) a files list + { title, entry, chunkSize }. */
export function writeLayout(outDir, built, opts = {}) {
  if (Array.isArray(built)) built = buildManifest(built, { title: opts.title, titleVersion: '0.0.0', entry: opts.entry ?? null, required: [] }, opts);
  const files = built.manifest.files.map((e) => ({ ...e, url: `objects/${e.sha256.slice(0, 2)}/${e.sha256}` }));
  for (const e of files) {
    mkdirSync(join(outDir, 'objects', e.sha256.slice(0, 2)), { recursive: true });
    writeFileSync(join(outDir, e.url), built.bodies.get(e.path));
  }
  const manifest = { ...built.manifest, files };
  writeFileSync(join(outDir, 'manifest.json'), json(manifest));
  return manifest;
}

/** Layout 2 (versioned bucket): <prefix>latest.json + <prefix>v/<version>/manifest.json + <prefix>v/<version>/<path>.
 *  prefix: 'games/<id>/' (a title's profile), or '' (the old single-title root). Returns { manifest, latest, keys }. */
export function writeVersionedTree(outDir, built, { prefix = '' } = {}) {
  if (prefix && !/^games\/[a-z0-9][a-z0-9-]{0,31}\/$/.test(prefix)) throw new Error(`bad bucket prefix ${prefix}`);
  const v = built.manifest.version;
  if (!VERSION_RE.test(v)) throw new Error(`bad version ${v}`);
  const files = built.manifest.files.map((e) => ({ ...e, url: e.path }));
  const keys = [];
  for (const e of files) {
    const key = `${prefix}v/${v}/${e.path}`;
    mkdirSync(dirname(join(outDir, key)), { recursive: true });
    writeFileSync(join(outDir, key), built.bodies.get(e.path));
    keys.push({ key, path: e.path, size: e.size, sha256: e.sha256, type: e.type });
  }
  const manifest = { ...built.manifest, files };
  const mbody = Buffer.from(json(manifest));
  const mkey = `${prefix}v/${v}/manifest.json`;
  writeFileSync(join(outDir, mkey), mbody);
  keys.push({ key: mkey, size: mbody.length, sha256: sha(mbody), type: 'application/json' });
  const latest = latestFor(built.manifest.title, v, mbody);
  const lbody = Buffer.from(json(latest));
  writeFileSync(join(outDir, `${prefix}latest.json`), lbody);
  keys.push({ key: `${prefix}latest.json`, size: lbody.length, sha256: sha(lbody), type: 'application/json' });
  return { manifest, latest, keys };
}

/** The version pointer for a manifest's bytes. */
export function latestFor(title, version, manifestBody) {
  return { format: LATEST_FORMAT, title, version, manifest: `v/${version}/manifest.json`, sha256: sha(manifestBody), size: manifestBody.length };
}
