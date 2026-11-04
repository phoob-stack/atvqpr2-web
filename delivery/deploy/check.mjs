#!/usr/bin/env node
// check.mjs - validate the VPS config without Docker (nothing is deployed,
// pulled or started remotely):
//
//   node deploy/check.mjs [--out ../out] [--dry-run]
//
// - .env.example: placeholders only, secrets empty; deploy/.env not tracked by git
// - docker-compose.yml: images pinned, no privileged/host network, ports only
//   on the caddy front door, test hooks / scan bypass never set, every
//   ${VAR} documented in .env.example, mounts point at pipeline output
// - Caddyfile: balanced braces, upstreams match the compose services/ports,
//   the site's header snippet is mounted where it is imported
// - --out: the pipeline output has what the mounts need, is configured for
//   the /demo/ + /hub/ routes, and passes the no-game-content scan
// - --dry-run: runs the asset server and hub locally (127.0.0.1:8853/8854)
//   with the compose environment, checks /healthz, the manifest and the hub
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { verifyPackage } from '../pipeline/verify-package.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const OUT = argv.includes('--out') ? resolve(argv[argv.indexOf('--out') + 1]) : null;
const problems = [];
const ok = [];
const check = (cond, good, bad) => (cond ? ok.push(good) : problems.push(bad));

// ---- .env.example ----------------------------------------------------------------
const envText = readFileSync(join(HERE, '.env.example'), 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const documented = new Set([...envText.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
check(env.TUNNEL_TOKEN === '', '.env.example: TUNNEL_TOKEN is empty', '.env.example: TUNNEL_TOKEN must be empty (a placeholder file)');
check(/example\.(com|invalid)$/.test(env.DOMAIN ?? ''), '.env.example: DOMAIN is a placeholder', '.env.example: DOMAIN should be an example.com placeholder');
check(/@example\.(com|invalid)$/.test(env.ACME_EMAIL ?? ''), '.env.example: ACME_EMAIL is a placeholder', '.env.example: ACME_EMAIL should be a placeholder');
check(!/[A-Za-z0-9+/_-]{40,}/.test(envText.replace(/https?:\/\/\S+/g, '')), '.env.example: nothing that looks like a token or key', '.env.example: something that looks like a secret');
try {
  const tracked = execFileSync('git', ['-C', join(HERE, '..'), 'ls-files'], { encoding: 'utf8' }).split('\n');
  check(!tracked.some((f) => /(^|\/)\.env$/.test(f)), 'git: no .env tracked', 'git: a .env file is tracked');
} catch { ok.push('git: not a repository here (skipped)'); }

// ---- docker-compose.yml -------------------------------------------------------------
const compose = readFileSync(join(HERE, 'docker-compose.yml'), 'utf8');
const code = compose.split('\n').map((l) => l.replace(/\s#.*$/, '')).join('\n');
for (const m of code.matchAll(/image:\s*(\S+)/g)) {
  check(/:[\w.-]*\d[\w.-]*(@sha256:[0-9a-f]{64})?$/.test(m[1]) && !/:latest$/.test(m[1]), `compose: image ${m[1]} is pinned`, `compose: image ${m[1]} is not pinned to a version`);
}
check(!/privileged:\s*true|network_mode:\s*host|pid:\s*host|docker\.sock/.test(code), 'compose: no privileged/host-network/docker.sock', 'compose: privileged, host network or docker.sock');
check(!/ASSET_TEST_HOOKS|HUB_TEST_HOOKS|ASSET_SKIP_SCAN/.test(code), 'compose: test hooks and scan bypass never set', 'compose: sets a test hook or ASSET_SKIP_SCAN');
// ports: only in the caddy service
const services = {};
let cur = null, inServices = false;
for (const line of code.split('\n')) {
  if (/^\S/.test(line)) { inServices = /^services:/.test(line); cur = null; continue; }
  const s = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
  if (s && inServices) { cur = s[1]; services[cur] = ''; continue; }
  if (cur) services[cur] += line + '\n';
}
for (const [name, body] of Object.entries(services)) {
  if (/^\s+ports:/m.test(body)) check(name === 'caddy', `compose: only ${name} publishes ports`, `compose: ${name} publishes ports (only the caddy front door may)`);
  if (name === 'assets' || name === 'hub') check(/:ro$/m.test(body) && !/volumes:[\s\S]*:rw/.test(body), `compose: ${name} mounts read-only`, `compose: ${name} has a writable mount`);
}
check(['assets', 'hub', 'caddy', 'caddy-tunnel', 'cloudflared'].every((s) => s in services), 'compose: services assets, hub, caddy, caddy-tunnel, cloudflared', `compose: services found: ${Object.keys(services).join(', ')}`);
for (const m of new Set([...code.matchAll(/\$\{([A-Z_]+)/g)].map((x) => x[1]))) check(documented.has(m), `compose: \${${m}} documented in .env.example`, `compose: \${${m}} is not in .env.example`);
check(/HUB_ORIGINS:\s*https:\/\/\$\{DOMAIN/.test(code), 'compose: the hub only accepts the site origin', 'compose: HUB_ORIGINS is not the site origin');
check(/TUNNEL_TOKEN:\s*\$\{TUNNEL_TOKEN:-\}/.test(code), 'compose: the tunnel token comes from .env only', 'compose: TUNNEL_TOKEN must come from .env');

// ---- Caddyfile ------------------------------------------------------------------------
const caddy = readFileSync(join(HERE, 'Caddyfile'), 'utf8');
const caddyCode = caddy.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/\{\$[A-Z_]+\}/g, '');   // minus {$ENV} placeholders
check((caddyCode.match(/\{/g) ?? []).length === (caddyCode.match(/\}/g) ?? []).length,
  'Caddyfile: braces balanced', 'Caddyfile: unbalanced braces');
check(/reverse_proxy hub:8854/.test(caddy) && /HUB_PORT: "8854"/.test(code), 'Caddyfile: /hub/ -> hub:8854 matches compose', 'Caddyfile: hub upstream does not match compose');
check(/reverse_proxy assets:8853/.test(caddy) && /ASSET_PORT: "8853"/.test(code), 'Caddyfile: /demo/ -> assets:8853 matches compose', 'Caddyfile: assets upstream does not match compose');
check(/import \/etc\/caddy\/site\.caddy/.test(caddy) && /site\.caddy:\/etc\/caddy\/site\.caddy:ro/.test(code), 'Caddyfile: the site header snippet is mounted where imported', 'Caddyfile: site.caddy import and mount differ');

// ---- the pipeline output ---------------------------------------------------------------
if (OUT) {
  for (const p of ['app/server/asset-server.mjs', 'app/hub/hub.mjs', 'app/pipeline/verify-package.mjs', 'assets/manifest.json', 'web/index.html', 'web/sw.js', 'site/index.html', 'site.caddy'])
    check(existsSync(join(OUT, p)), `out: ${p}`, `out: ${p} missing (run node pipeline/build.mjs --hub-url /hub/)`);
  try {
    const cfg = JSON.parse(readFileSync(join(OUT, 'web', 'config.json'), 'utf8'));
    check(cfg.hub === '/hub/', 'out: web/config.json hub is /hub/ (same origin, via Caddy)', `out: web/config.json hub is ${cfg.hub}; build with --hub-url /hub/ for the VPS`);
    check(/^\.\//.test(cfg.manifest), 'out: manifest URL is relative (works under /demo/)', `out: manifest URL ${cfg.manifest} is not relative`);
  } catch (e) { problems.push(`out: web/config.json unreadable (${e.message})`); }
  const r1 = verifyPackage(OUT, { quiet: true, delivery: true });
  const r2 = verifyPackage(join(OUT, 'assets'), { quiet: true, delivery: true, assets: true });
  check(r1.ok && r2.ok, `out: passes the no-game-content scan (${r1.files} files)`, `out: FAILS the scan: ${[...r1.problems, ...r2.problems].slice(0, 5).map((p) => `${p.file}: ${p.why}`).join('; ')}`);
}

// ---- dry run: the containers' commands with the compose environment, on 127.0.0.1 -------------
if (argv.includes('--dry-run')) {
  if (!OUT) problems.push('--dry-run needs --out');
  else {
    const kids = [];
    const start = (script, e, re) => new Promise((res, rej) => {
      const p = spawn(process.execPath, [join(OUT, 'app', script)], { env: { ...process.env, ...e }, stdio: ['ignore', 'pipe', 'pipe'] });
      kids.push(p);
      let out = '';
      const on = (d) => { out += d; if (re.test(out)) res(p); };
      p.stdout.on('data', on); p.stderr.on('data', on);
      p.on('exit', (c) => rej(new Error(`${script} exited ${c}: ${out}`)));
      setTimeout(() => rej(new Error(`${script} did not start: ${out}`)), 10000);
    });
    try {
      // as in compose, except the bind address (local only) and the ports' host side
      await start('server/asset-server.mjs', { ASSET_HOST: '127.0.0.1', ASSET_PORT: '8853', ASSET_DIR: join(OUT, 'assets'), WEB_DIR: join(OUT, 'web'),
        ASSET_TRUST_PROXY: '1', ASSET_TRUST_PROXY_HOPS: '1', ASSET_RATE_RPS: '50', ASSET_RATE_BURST: '200', ASSET_CDN_MODE: 'redirect', ASSET_CORP: 'same-origin' }, /asset server on/);
      await start('hub/hub.mjs', { HUB_HOST: '127.0.0.1', HUB_PORT: '8854', HUB_ORIGINS: 'https://game.example.com', HUB_MAX_PLAYERS: '64' }, /hub on/);
      const h = await fetch('http://127.0.0.1:8853/healthz');
      check(h.ok, 'dry run: asset server /healthz', `dry run: /healthz ${h.status}`);
      const m = await fetch('http://127.0.0.1:8853/assets/manifest.json');
      check(m.ok && m.headers.get('cross-origin-embedder-policy') === 'require-corp', 'dry run: manifest served with COEP', `dry run: manifest ${m.status}`);
      const page = await fetch('http://127.0.0.1:8853/');
      check(page.ok && /Box Quad/.test(await page.text()), 'dry run: launcher page served', 'dry run: launcher page missing');
      const hub = await (await fetch('http://127.0.0.1:8854/')).json();
      check(Array.isArray(hub.players), 'dry run: hub answers', 'dry run: hub did not answer');
      // a WebSocket from a foreign origin is refused (HUB_ORIGINS)
      const refused = await new Promise((res) => {
        const ws = new WebSocket('ws://127.0.0.1:8854/');   // Node's WebSocket sends no Origin header: not the site's origin
        ws.onopen = () => { ws.close(); res(false); };
        ws.onerror = () => res(true);
      });
      check(refused, 'dry run: hub refuses a WebSocket without the site origin', 'dry run: hub accepted a foreign origin');
    } catch (e) { problems.push(`dry run: ${e.message}`); }
    for (const k of kids) { try { execFileSync('taskkill', ['/PID', String(k.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { k.kill(); } }
  }
}

for (const o of ok) console.log(`ok    ${o}`);
for (const p of problems) console.log(`FAIL  ${p}`);
console.log(problems.length ? `deploy check FAILED: ${problems.length} problem(s)` : `deploy check OK (${ok.length} checks)`);
process.exitCode = problems.length ? 1 : 0;
