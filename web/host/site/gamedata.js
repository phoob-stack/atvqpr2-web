// "Game data": the player's imported game files in this browser's storage
// (OPFS, the shared delivery store: assetsource.js), how much space this site
// uses, whether the browser keeps it (persist()), checking/preloading the
// files, and "Forget game files".
import { importedGame, forgetGame, hasGameData, GAME_DIR, CACHE_DIR } from '../loader.js';
import { localSource } from '../assetsource.js';
import { AssetManager, LocalFilesBackend } from '../delivery/assets.js';

const MB = (n) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

/** Bytes and file count under an OPFS directory (null when it does not exist). */
export async function dirSize(name) {
  let dir;
  try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name); } catch { return null; }
  let bytes = 0, files = 0;
  const walk = async (d) => {
    for await (const h of d.values()) {
      if (h.kind === 'directory') await walk(h);
      else { bytes += (await h.getFile()).size; files++; }
    }
  };
  await walk(dir);
  return { bytes, files };
}

/** What is stored: { estimate, persisted, dirs: { name: {bytes, files} } }. */
export async function storageReport() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  const root = await navigator.storage.getDirectory();
  const dirs = {};
  for await (const h of root.values()) {
    if (h.kind === 'directory') dirs[h.name] = await dirSize(h.name);
    else dirs[h.name] = { bytes: (await h.getFile()).size, files: 1 };
  }
  return { estimate: est, persisted, dirs };
}

export async function requestPersist() {
  return navigator.storage?.persist?.().catch(() => false) ?? false;
}

/**
 * Read every stored file once and hash it again against the catalog's
 * SHA-256 (the delivery client's full verify: warms the disk cache, finds
 * missing or damaged files, and deletes damaged ones so that the next import
 * replaces them). onProgress({ done, total, path }).
 * Returns { ok, files, bytes, secs, problems: [] }.
 */
export async function checkGame(onProgress = () => {}) {
  const m = await importedGame();
  if (!m) return { ok: false, problems: ['No imported game in this browser.'] };
  const src = await localSource();
  const cat = await src.catalog();
  const am = new AssetManager({ ns: src.ns, backend: new LocalFilesBackend({ files: null }) });
  const total = cat.files.reduce((a, f) => a + f.size, 0);
  const problems = [];
  let done = 0;
  const t0 = performance.now();
  try {
    await am.open();
    for (const f of cat.files) {
      onProgress({ done, total, path: f.path });
      const v = await am.verifyStore({ paths: [f.path], full: true });
      if (v.missing.length) problems.push(`${f.path} is missing`);
      if (v.bad.length) problems.push(`${f.path} is damaged (its SHA-256 no longer matches)`);
      done += f.size;
      onProgress({ done, total, path: f.path });
    }
  } finally { am.close(); src.statusP = null; }
  return { ok: !problems.length, files: cat.files.length, bytes: total, secs: (performance.now() - t0) / 1000, problems };
}

export { importedGame, forgetGame, hasGameData, GAME_DIR, CACHE_DIR, MB };
