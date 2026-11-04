// Check that a folder is the player's extracted USA retail ATV: Quad Power
// Racing 2: default.xbe by size and SHA-256, plus the two data archives the
// game opens at boot. Nothing is copied or written here.
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const GAME = JSON.parse(readFileSync(join(HERE, '..', 'config', 'game-usa.json'), 'utf8'));

// Case-insensitive lookup (an extracted disc on Linux/macOS may differ in case).
function findEntry(dir, name) {
  const want = name.toLowerCase();
  const e = readdirSync(dir, { withFileTypes: true }).find((x) => x.name.toLowerCase() === want);
  return e ? join(dir, e.name) : null;
}

export class GameError extends Error {}

export async function verifyGameFolder(dir) {
  if (!dir) throw new GameError('no game folder given');
  if (!existsSync(dir)) throw new GameError(`game folder not found: ${dir}`);
  if (!statSync(dir).isDirectory()) {
    const ext = extname(dir).toLowerCase();
    throw new GameError(ext === '.iso' || ext === '.xiso'
      ? `${dir} is a disc image. Extract it to a folder first (the folder with default.xbe, ATV.bah and ATV.bad) and pass that folder.`
      : `${dir} is a file, not a folder. Pass the folder that holds default.xbe.`);
  }
  // A common slip: the parent of the game folder.
  if (!findEntry(dir, GAME.defaultXbe.name)) {
    const sub = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name)).find((d) => findEntry(d, GAME.defaultXbe.name));
    throw new GameError(`no default.xbe in ${dir}` + (sub ? ` (there is one in ${sub}: pass that folder)` : ''));
  }
  const xbe = findEntry(dir, GAME.defaultXbe.name);
  const size = statSync(xbe).size;
  if (size !== GAME.defaultXbe.size)
    throw new GameError(`${xbe} is ${size} bytes; the USA retail ${GAME.title} default.xbe is ${GAME.defaultXbe.size}. ` +
      'Only the USA retail release is supported (other regions and versions are different programs).');
  const sha256 = await sha256File(xbe);
  if (sha256 !== GAME.defaultXbe.sha256)
    throw new GameError(`${xbe} has SHA-256 ${sha256}; expected ${GAME.defaultXbe.sha256} (USA retail ${GAME.title}). ` +
      'The file is modified, damaged or from another release.');
  const missing = GAME.requiredFiles.filter((f) => !findEntry(dir, f));
  if (missing.length) throw new GameError(`the game folder is incomplete: missing ${missing.join(', ')} in ${dir}`);
  return { dir, xbe, size, sha256 };
}
