// The VPS config, checked without Docker (deploy/check.mjs), and the site
// _headers -> Caddy conversion.
//   node --test test/deploy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headersToCaddy } from '../pipeline/caddy-headers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('deploy/check.mjs passes on the committed config', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'deploy', 'check.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deploy check OK/);
});

test('_headers become inline-matcher Caddy header lines', () => {
  const c = headersToCaddy('/*\n  Content-Security-Policy: default-src \'none\'; script-src \'self\'\n  X-Frame-Options: DENY\n/play/*\n  Cross-Origin-Embedder-Policy: require-corp\n');
  assert.match(c, /^header \/\* Content-Security-Policy "default-src 'none'; script-src 'self'"$/m);
  assert.match(c, /^header \/\* X-Frame-Options "DENY"$/m);
  assert.match(c, /^header \/play\/\* Cross-Origin-Embedder-Policy "require-corp"$/m);
  assert.throws(() => headersToCaddy('  X: y\n'), /before any path/);
  assert.throws(() => headersToCaddy('https://x/*\n  X: y\n'), /unsupported path/);
});
