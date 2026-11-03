// "Game data": the player's imported game files in this browser's storage
// (OPFS, loader.js), how much space this site uses, whether the browser keeps
// it (persist()), checking/preloading the files, and "Forget game files".
import { importedGame, forgetGame, hasGameData, GAME_DIR, CACHE_DIR } from '../loader.js';

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
 * Read every imported file once (warms the disk cache, finds missing or
 * short files) and re-hash default.xbe. onProgress({ done, total, path }).
 * Returns { ok, files, bytes, secs, problems: [] }.
 */
export async function checkGame(onProgress = () => {}) {
  const m = await importedGame();
  if (!m) return { ok: false, problems: ['No imported game in this browser.'] };
  const top = await (await navigator.storage.getDirectory()).getDirectoryHandle(GAME_DIR);
  const total = m.files.reduce((a, f) => a + f.size, 0);
  const problems = [];
  let done = 0;
  const t0 = performance.now();
  for (const f of m.files) {
    let file;
    try {
      let d = top;
      const parts = f.path.split('/');
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
      file = await (await d.getFileHandle(parts.at(-1))).getFile();
    } catch { problems.push(`${f.path} is missing`); done += f.size; continue; }
    if (file.size !== f.size) problems.push(`${f.path} is ${file.size} bytes, expected ${f.size}`);
    if (f.path.toLowerCase() === 'default.xbe') {
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      if (m.xbeSha256 && sha !== m.xbeSha256) problems.push('default.xbe has changed since the import');
      done += f.size;
    } else {
      // Stream through it in 8 MiB pieces.
      for (let at = 0; at < file.size; at += 8 << 20) {
        const n = (await file.slice(at, Math.min(file.size, at + (8 << 20))).arrayBuffer()).byteLength;
        done += n;
        onProgress({ done, total, path: f.path });
      }
    }
    onProgress({ done, total, path: f.path });
  }
  return { ok: !problems.length, files: m.files.length, bytes: total, secs: (performance.now() - t0) / 1000, problems };
}

export { importedGame, forgetGame, hasGameData, GAME_DIR, CACHE_DIR, MB };
