// Before/after load times taken in the same minutes (other work on the
// machine moves the numbers a lot from one quarter hour to the next).
//
//   node web/tools/loadtime-ab.mjs <baseline checkout> --profile <dir> [--port 8835] [--rounds 5]
//
// <baseline checkout>: e.g. `git worktree add --detach ../baseline <commit>`,
// with junctions build-wasm and game to this copy's (the same module and
// game files; only web/ differs). Runs web/tools/loadtime.mjs:
//   cold:  one run each, alternating, caches cleared before every run (--cold)
//   warm:  blocks of 1 + 3 runs per side (the first of a block re-primes the
//          caches the other side's no-store responses dropped), alternating
// and prints the medians. Both use the game imported into OPFS (--opfs).
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = resolve(argv[0]);
const profile = opt('--profile'), port = opt('--port', '8835'), rounds = Number(opt('--rounds', 5));
const out = join(ROOT, 'build-wasm/loadtime');
mkdirSync(out, { recursive: true });
const tool = join(ROOT, 'web/tools/loadtime.mjs');
const all = { before: { cold: [], warm: [] }, after: { cold: [], warm: [] } };

function run(side, mode, runs, keepFrom) {
  const json = join(out, `ab-${side}-${mode}.json`);
  const args = [tool, '--profile', profile, '--port', port, '--opfs', '--runs', String(runs), '--json', json,
    ...(mode === 'cold' ? ['--cold'] : []), ...(side === 'before' ? ['--root', base] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  process.stdout.write(r.stdout.split('\n').filter((l) => /^run|ERROR/.test(l)).map((l) => `${side.padEnd(6)} ${mode} ${l}`).join('\n') + '\n');
  try { all[side][mode].push(...JSON.parse(readFileSync(json, 'utf8')).results.slice(keepFrom)); } catch { /* run failed */ }
}

for (let i = 0; i < rounds; i++) { run('before', 'cold', 1, 0); run('after', 'cold', 1, 0); }
for (let i = 0; i < Math.ceil(rounds / 3); i++) { run('before', 'warm', 4, 1); run('after', 'warm', 4, 1); }

const med = (rs, k) => { const v = rs.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b); return v.length ? (v[v.length >> 1] / 1000).toFixed(2) : '-'; };
console.log('\nmedians (s from navigation start)      wasm  threads  first frame  PRESS START   runs');
for (const mode of ['cold', 'warm']) for (const side of ['before', 'after']) {
  const rs = all[side][mode].filter((r) => !r.error);
  console.log(`${mode.padEnd(5)} ${side.padEnd(7)}                       ${med(rs, 'wasm').padStart(5)}  ${med(rs, 'pool').padStart(7)}  ` +
    `${med(rs, 'first').padStart(11)}  ${med(rs, 'title').padStart(11)}   ${rs.length}`);
}
