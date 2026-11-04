#!/usr/bin/env node
// make-package.mjs - (maintainers) refresh the vendored source snapshots in
// sources/ from the two repositories, at the commits pinned in PINNED.json.
//
//   node make-package.mjs [--atvrecomp <repo>] [--xboxrecomp <repo>]
//        (defaults: ../atvrecomp and ../xboxrecomp next to this folder)
//
// Each snapshot is `git archive <commit> -- <allow-listed paths>` (with
// core.autocrlf off, so the bytes are the committed ones), unpacked into
// sources/<name>/. Only committed files at the pinned commit can come in, and
// only under the listed paths: a working tree's generated C, builds, game
// files, captures or caches never do. The repositories are only read.
// verify-package.mjs runs at the end.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tarExe, ensureDir, walk, fmtBytes } from './lib/util.mjs';

const PKG = dirname(fileURLToPath(import.meta.url));
const pinned = JSON.parse(readFileSync(join(PKG, 'PINNED.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

function archive(repo, spec, dest) {
  const pathspec = [...spec.paths, ...(spec.exclude ?? []).map((x) => `:(exclude,glob)${x}`)];
  return new Promise((res, rej) => {
    const git = spawn('git', ['-C', repo, '-c', 'core.autocrlf=false', 'archive', '--format=tar', spec.commit, '--', ...pathspec],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    const tar = spawn(tarExe(), ['-x', '-f', '-', '-C', dest], { stdio: ['pipe', 'inherit', 'inherit'] });
    git.stdout.pipe(tar.stdin);
    let gitCode;
    git.on('close', (c) => { gitCode = c; });
    tar.on('close', (c) => (c === 0 && gitCode === 0 ? res() : rej(new Error(`git archive ${gitCode} / tar ${c} for ${repo}`))));
    git.on('error', rej); tar.on('error', rej);
  });
}

for (const name of ['atvrecomp', 'xboxrecomp']) {
  const repo = resolve(opt(`--${name}`, join(PKG, '..', name)));
  if (!existsSync(join(repo, '.git'))) throw new Error(`${repo} is not a git repository`);
  const dest = join(PKG, 'sources', name);
  rmSync(dest, { recursive: true, force: true });
  ensureDir(dest);
  await archive(repo, pinned[name], dest);
  const files = walk(dest);
  console.log(`sources/${name}: ${files.length} files, ${fmtBytes(files.reduce((a, f) => a + (f.size ?? 0), 0))} ` +
    `(${name} ${pinned[name].commit.slice(0, 7)})`);
}

const { verifyPackage } = await import('./verify-package.mjs');
process.exit(verifyPackage(PKG).ok ? 0 : 1);
