// profile.js - game profiles: what a launcher needs to know about a game, as
// data, so that adding a game needs a profile and its build, and no loader
// changes.
//
//   { "format": "game-profile/1",
//     "id": "boxquad",                       short name: [a-z0-9][a-z0-9-]*, also the OPFS namespace (delivery/<id>)
//     "title": "Box Quad",
//     "derivedFromRetail": false,            true: built from a retail game's files (ATV 2); a remote
//                                            source is then refused, here and by the pipeline
//     "sources": ["remote"],                 "local" (the player's own files), "remote" (a versioned bucket)
//     "remote": { "prefix": "games/boxquad/" },   always games/<id>/: <prefix>latest.json, <prefix>v/<version>/
//                                            ("fallbackPrefix": "" while a title moves from the bucket root:
//                                            the root's latest.json is read when the prefix has none yet)
//     "entry": "title.wasm",                 the module (a catalog path)
//     "app": "boxquad",                      the page code that runs it (the runner's app/<app>.js), optional
//     "mounts": [ { "at": "/game", "from": "game/" } ],   catalog path prefix -> the runtime's file system (optional)
//     "required": ["title.wasm", ...],       fetched (or checked) before the start
//     "groups": { "sand": ["textures/sand.rgba"] },       on-demand groups, fetched on first use
//     "local": { ... }                       the local source's rules (see below)
//     "titleVersion": "1.1.0",               pipeline: the version's N.N.N
//     "build": { "dir": "title" }            pipeline: the folder whose build.mjs builds the title
//   }
//
// The pipeline (pipeline/build.mjs) reads the same file for the manifest's
// required files and groups. A profile that says derivedFromRetail can never
// name a remote source: checkProfile() refuses it, so a remote source for such
// a game cannot be configured by accident (in a page, the pipeline or
// upload-r2.mjs, which all call it).

export const PROFILE_FORMAT = 'game-profile/1';
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GROUP = /^[A-Za-z0-9._-]{1,64}$/;
const PATH = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~ -]+)*\/?$/;

export class ProfileError extends Error {
  constructor(message) { super(message); this.name = 'ProfileError'; this.code = 'profile'; }
}

/** Check a profile object; returns it (frozen) or throws a ProfileError. */
export function checkProfile(p, where = 'profile') {
  const bad = (m) => { throw new ProfileError(`${where}: ${m}`); };
  if (!p || typeof p !== 'object') bad('not an object');
  if (p.format !== PROFILE_FORMAT) bad(`format must be "${PROFILE_FORMAT}"`);
  if (!ID.test(p.id ?? '')) bad('id must be a short [a-z0-9-] name');
  if (typeof p.title !== 'string' || !p.title) bad('no title');
  if (!Array.isArray(p.sources) || !p.sources.length || p.sources.some((s) => s !== 'local' && s !== 'remote')) bad('sources must list "local" and/or "remote"');
  if (p.derivedFromRetail !== undefined && typeof p.derivedFromRetail !== 'boolean') bad('derivedFromRetail must be true or false');
  // The rule: a game whose build or files come from a retail game is never served.
  if (p.derivedFromRetail && (p.sources.includes('remote') || p.remote !== undefined))
    bad('this profile is derived from retail content, so it cannot have a remote source (no R2 prefix, no manifest, no upload): its only source is the player\'s own files');
  if (p.sources.includes('remote')) {
    if (p.remote?.prefix !== `games/${p.id}/`) bad(`remote.prefix must be "games/${p.id}/"`);
    // During a move to the prefix: where the title was before (only the bucket root, '').
    if (p.remote.fallbackPrefix !== undefined && p.remote.fallbackPrefix !== '') bad('remote.fallbackPrefix can only be "" (the bucket root, before the move to games/<id>/)');
  } else if (p.remote !== undefined) bad('remote is set but "remote" is not in sources');
  if (p.local !== undefined && !p.sources.includes('local')) bad('local is set but "local" is not in sources');
  if (typeof p.entry !== 'string' || !PATH.test(p.entry)) bad('entry must be a catalog path');
  if (p.app !== undefined && !ID.test(p.app)) bad('app must be a short [a-z0-9-] name');
  if (p.titleVersion !== undefined && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(p.titleVersion)) bad('titleVersion must be N.N.N');
  if (p.build !== undefined && !/^[a-z0-9][a-z0-9/-]*$/.test(p.build?.dir ?? '')) bad('build.dir must be a folder of the delivery repository (pipeline only)');
  for (const m of p.mounts ?? []) if (!/^\/[a-z]+$/.test(m?.at ?? '') || typeof m.from !== 'string' || (m.from && !PATH.test(m.from))) bad(`bad mount ${JSON.stringify(m)}`);
  if (!Array.isArray(p.required ?? []) || (p.required ?? []).some((r) => typeof r !== 'string' || !PATH.test(r))) bad('required must be a list of catalog paths');
  for (const [g, paths] of Object.entries(p.groups ?? {})) {
    if (!GROUP.test(g) || !Array.isArray(paths) || paths.some((r) => typeof r !== 'string' || !PATH.test(r))) bad(`bad group ${g}`);
  }
  return Object.freeze(p);
}

/** Fetch and check a profile (a URL relative to the page, or to `base`). */
export async function loadProfile(url, base = globalThis.location?.href) {
  const u = new URL(url, base).href;
  let r;
  try { r = await fetch(u, { cache: 'no-cache' }); } catch (e) { throw new ProfileError(`${u}: ${e.message}`); }
  if (!r.ok) throw new ProfileError(`${u}: HTTP ${r.status}`);
  let p;
  try { p = await r.json(); } catch (e) { throw new ProfileError(`${u}: not JSON (${e.message})`); }
  return checkProfile(p, u);
}

/** The versioned bucket base of a profile's remote source (<assets base>/games/<id>/). */
export function remoteBase(profile, assetsBase) {
  if (!profile.sources.includes('remote') || profile.derivedFromRetail) throw new ProfileError(`${profile.id} has no remote source`);
  const b = assetsBase.endsWith('/') ? assetsBase : `${assetsBase}/`;
  return new URL(profile.remote.prefix, b).href;
}
/** Where the title was before its prefix (the bucket root), during a move; else null. */
export function remoteFallback(profile, assetsBase) {
  if (profile.remote?.fallbackPrefix !== '') return null;
  return assetsBase.endsWith('/') ? assetsBase : `${assetsBase}/`;
}

/** The OPFS namespace of a profile's files (delivery/<ns>). */
export const profileNs = (profile, source = 'remote') => (source === 'local' && profile.sources.includes('remote') ? `${profile.id}-local` : profile.id);

/** Catalog paths under a mount, as the runtime sees them: [{ path (in the mount), entry }]. */
export function mountFiles(profile, catalog, at) {
  const m = (profile.mounts ?? []).find((x) => x.at === at);
  if (!m) return [];
  return catalog.files.filter((f) => f.path.startsWith(m.from)).map((f) => ({ path: f.path.slice(m.from.length), entry: f }));
}

// ---- the local source's rules -------------------------------------------------------
// "local": {
//   "root": "default.xbe",                  the picked folder's game root holds this file (the shallowest one)
//   "skipFolders": ["udata", ...],          top folders of the root left out (case-insensitive)
//   "layout": { "game/": "*", "build/": ["atv2.wasm", ...] }   where the root's files go in the catalog:
//                                           the listed top-level names under their prefix, the rest under "*"
//   "optional": { "movies": "^Movies/[^/]+\\.xmv$" },   files the player may leave out (by option name)
//   "checks": [ { "path": "default.xbe", "size": n, "sha256": "...", "message": "..." },
//               { "anyOf": [...], "nonEmpty": true, "message": "..." } ]   before anything is stored
//   "messages": { name: text with {placeholders} }
// }

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fill = (t, v) => String(t ?? '').replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? `{${k}}`));
const n = (x) => Number(x).toLocaleString('en-US');

/** Is `path` (relative to the root) in a skipped top folder? */
export function skipped(profile, path) {
  const skip = (profile.local?.skipFolders ?? []).map((s) => s.toLowerCase());
  return path.includes('/') && skip.includes(path.split('/')[0].toLowerCase());
}

/** The catalog path of a root-relative file, by local.layout ('game/' + path, or 'build/atv2.wasm'). */
export function layoutPath(profile, path) {
  const layout = profile.local?.layout ?? { '': '*' };
  for (const [prefix, names] of Object.entries(layout)) {
    if (Array.isArray(names) && !path.includes('/') && names.some((x) => x.toLowerCase() === path.toLowerCase())) return { prefix, path: prefix + path };
  }
  const star = Object.entries(layout).find(([, v]) => v === '*');
  return { prefix: star?.[0] ?? '', path: (star?.[0] ?? '') + path };
}

/** Is a root-relative path one of the profile's optional files (local.optional[name])? */
export function optional(profile, name, path) {
  const re = profile.local?.optional?.[name];
  return re ? new RegExp(re, 'i').test(path) : false;
}

/**
 * Run local.checks on entries ({ path, size, file() }, relative to the root);
 * throws an Error with the profile's message, or returns { [path]: sha256 }
 * for the files checked by hash.
 */
export async function runChecks(profile, entries) {
  const find = (p) => entries.find((e) => e.path.toLowerCase() === p.toLowerCase());
  const msg = profile.local?.messages ?? {};
  const out = {};
  for (const c of profile.local?.checks ?? []) {
    if (c.anyOf) {
      const missing = c.anyOf.filter((p) => !(c.nonEmpty ? find(p)?.size : find(p)));
      if (missing.length) throw new Error(fill(msg[c.message], { missing: missing.join(' and '), verb: missing.length > 1 ? 'are' : 'is' }));
      continue;
    }
    const e = find(c.path);
    if (!e) throw new Error(fill(msg[c.missing], { path: c.path }));
    if (c.size !== undefined && e.size !== c.size) throw new Error(fill(msg[c.wrongSize], { path: c.path, size: n(e.size), want: n(c.size) }));
    if (c.sha256) {
      const sha = hex(await crypto.subtle.digest('SHA-256', await (await e.file()).arrayBuffer()));
      if (sha !== c.sha256) throw new Error(fill(msg[c.wrongHash], { path: c.path, sha: sha.slice(0, 16) }));
      out[c.path] = sha;
    }
  }
  return out;
}
