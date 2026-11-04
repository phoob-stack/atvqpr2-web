// The R2 path without a browser: the streaming SHA-256, the versioned tree and
// its upload plan (reproducible), the gate's --r2 rule, upload-r2.mjs's
// refusals (always with --dry-run; nothing is ever uploaded), and the asset
// server as the R2 stand-in (CORS from deploy/r2-cors.json, preflights,
// ranges, Cache-Control per object).
//   node --test test/r2.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Sha256, sha256Hex } from '../client/sha256.js';
import { verifyPackage } from '../pipeline/verify-package.mjs';
import { createAssetServer } from '../server/asset-server.mjs';
import { walk } from '../pipeline/lib/util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.test', 'r2unit');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const WASM = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.from('made-up module for the gate test')]);
const node = (args) => { const r = spawnSync(process.execPath, args, { encoding: 'utf8' }); return { status: r.status, out: `${r.stdout}${r.stderr}` }; };
const build = (out) => node([join(ROOT, 'pipeline', 'build.mjs'), '--out', out, '--no-site']);
const treeHashes = (dir) => walk(dir).map((f) => `${f.rel} ${sha(readFileSync(join(dir, f.rel)))}`).sort().join('\n');

before(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
after(() => { if (!process.env.KEEP) rmSync(TMP, { recursive: true, force: true }); });

test('streaming SHA-256 matches node:crypto in any piece sizes, and clone() rolls back', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 70001]) {
    const b = randomBytes(n);
    assert.equal(sha256Hex(b), sha(b), `one-shot ${n}`);
    const h = new Sha256();
    for (let o = 0; o < n;) { const k = Math.min(n - o, 1 + ((o * 7919) % 300)); h.update(b.subarray(o, o + k)); o += k; }
    assert.equal(h.digestHex(), sha(b), `pieces ${n}`);
  }
  const a = randomBytes(5000), junk = randomBytes(777), rest = randomBytes(3000);
  const h = new Sha256().update(a);
  const snap = h.clone();
  h.update(junk);                     // a bad chunk...
  const back = snap.clone().update(rest);   // ...rolled back to the snapshot
  assert.equal(back.digestHex(), sha(Buffer.concat([a, rest])));
});

let OUT;
const BQ = join('r2', 'games', 'boxquad');      // Box Quad's tree in out/ (profiles/boxquad.json: games/boxquad/)
test('the pipeline writes the versioned tree and the upload plan, reproducibly', () => {
  OUT = join(TMP, 'out-a');
  const r1 = build(OUT);
  assert.equal(r1.status, 0, r1.out);
  const r2 = build(join(TMP, 'out-b'));
  assert.equal(r2.status, 0, r2.out);
  assert.equal(treeHashes(join(OUT, 'r2')), treeHashes(join(TMP, 'out-b', 'r2')), 'same inputs, same tree');
  assert.equal(readFileSync(join(OUT, 'r2-upload-plan.json'), 'utf8'), readFileSync(join(TMP, 'out-b', 'r2-upload-plan.json'), 'utf8'));
  const latest = JSON.parse(readFileSync(join(OUT, BQ, 'latest.json'), 'utf8'));
  assert.match(latest.version, /^\d+\.\d+\.\d+-[0-9a-f]{12}$/);
  const m = JSON.parse(readFileSync(join(OUT, BQ, latest.manifest), 'utf8'));
  assert.equal(m.format, 'delivery-manifest/2');
  assert.equal(m.title, 'boxquad');
  assert.equal(sha(readFileSync(join(OUT, BQ, latest.manifest))), latest.sha256);
  assert.deepEqual(m.files.filter((e) => e.required).map((e) => e.path).sort(),
    ['config/title.json', 'meshes/quad.bin', 'meshes/track.bin', 'textures/dirt.rgba', 'textures/grass.rgba', 'title.wasm']);
  assert.deepEqual(m.files.filter((e) => e.group).map((e) => [e.path, e.group]), [['textures/sand.rgba', 'sand']]);
  for (const e of m.files) assert.equal(e.url, e.path);
  const plan = JSON.parse(readFileSync(join(OUT, 'r2-upload-plan.json'), 'utf8'));
  assert.deepEqual(plan.titles.map((t) => [t.id, t.prefix]), [['boxquad', 'games/boxquad/'], ['orbit', 'games/orbit/']]);
  for (const t of plan.titles) {
    const mine = plan.objects.filter((o) => o.title === t.id);
    assert.ok(mine.every((o) => o.key.startsWith(t.prefix)));
    assert.equal(mine.at(-1).key, `${t.prefix}latest.json`);
    assert.equal(mine.at(-1).cacheControl, 'public, max-age=30');
    assert.equal(mine.at(-2).key, `${t.prefix}v/${t.version}/manifest.json`);
    for (const o of mine.slice(0, -1)) assert.equal(o.cacheControl, 'public, max-age=31536000, immutable');
  }
  assert.equal(plan.titles[0].version, latest.version);
  assert.ok(plan.objects.every((o) => !/atv2/i.test(o.key)));
  assert.ok(verifyPackage(join(OUT, 'r2'), { quiet: true, delivery: true, r2: true, sourceRoot: ROOT }).ok);
});

/** A copy of out/r2 (+ plan) to break. */
function copyOut(name) {
  const d = join(TMP, name);
  rmSync(d, { recursive: true, force: true });
  cpSync(join(OUT, 'r2'), join(d, 'r2'), { recursive: true });
  cpSync(join(OUT, 'r2-upload-plan.json'), join(d, 'r2-upload-plan.json'));
  return d;
}
const version = () => JSON.parse(readFileSync(join(OUT, BQ, 'latest.json'), 'utf8')).version;

test('gate --r2 refuses game files, unlisted or changed objects and a bad pointer', () => {
  const v = version();
  const cases = [
    ['atv2.wasm dropped into the version', (d) => writeFileSync(join(d, BQ, 'v', v, 'atv2.wasm'), WASM), [/atv2\.wasm: .*named like the game module/, /not an object listed/]],
    ['a .xbe', (d) => writeFileSync(join(d, BQ, 'v', v, 'default.xbe'), Buffer.concat([Buffer.from('XBEH'), Buffer.alloc(60)])), [/forbidden file type \.xbe/, /XBE header/]],
    ['src/recomp/gen in the tree', (d) => { mkdirSync(join(d, 'r2', 'src', 'recomp', 'gen'), { recursive: true }); writeFileSync(join(d, 'r2', 'src', 'recomp', 'gen', 'recomp_0001.c'), 'x'); }, [/inside src\/recomp\/gen/, /named like lifter output/]],
    ['a listed file changed', (d) => { const f = join(d, BQ, 'v', v, 'meshes', 'quad.bin'); const b = readFileSync(f); b[20] ^= 1; writeFileSync(f, b); }, [/quad\.bin: SHA-256 differs/]],
    ['the manifest lists default.xbe', (d) => {
      const f = join(d, BQ, 'v', v, 'manifest.json'); const m = JSON.parse(readFileSync(f, 'utf8'));
      m.files.push({ ...m.files[0], path: 'default.xbe', url: 'default.xbe' }); writeFileSync(f, JSON.stringify(m)); }, [/default\.xbe: forbidden file type \.xbe/, /latest\.json: size\/SHA-256 differ/]],
    ['a wasm that is not declared', (d) => {
      const f = join(d, BQ, 'v', v, 'manifest.json'); const m = JSON.parse(readFileSync(f, 'utf8'));
      for (const e of m.files) delete e.artifact; writeFileSync(f, JSON.stringify(m)); }, [/wasm without an artifact record/, /not a declared artifact/]],
    ['latest.json points nowhere', (d) => writeFileSync(join(d, BQ, 'latest.json'), JSON.stringify({ format: 'delivery-latest/1', version: '9.9.9-000000000000', manifest: 'v/9.9.9-000000000000/manifest.json', sha256: '0'.repeat(64), size: 1 })), [/games\/boxquad\/latest\.json: points at v\/9\.9\.9/]],
  ];
  for (const [what, make, want] of cases) {
    const d = copyOut(`gate-${what.replace(/\W+/g, '-')}`);
    make(d);
    const r = verifyPackage(join(d, 'r2'), { quiet: true, delivery: true, r2: true, sourceRoot: ROOT });
    const text = r.problems.map((p) => `${p.file}: ${p.why}`).join('\n');
    assert.ok(!r.ok, `${what}: should fail`);
    for (const re of want) assert.match(text, re, what);
  }
});

test('upload-r2.mjs --dry-run: the commands for a clean build; refusals print no command', () => {
  const ok = node([join(ROOT, 'pipeline', 'upload-r2.mjs'), '--out', OUT, '--dry-run']);
  assert.equal(ok.status, 0, ok.out);
  const cmds = ok.out.split('\n').filter((l) => l.startsWith('$ '));
  assert.equal(cmds.length, JSON.parse(readFileSync(join(OUT, 'r2-upload-plan.json'), 'utf8')).objects.length);
  assert.match(cmds[0], /^\$ npx wrangler r2 object put atvqpr2-assets\/games\/boxquad\/v\/[^ ]+ --file "?[^"]+"? --cache-control "public, max-age=31536000, immutable" --content-type [^ ]+ --remote$/);
  assert.match(cmds.at(-1), /atvqpr2-assets\/games\/orbit\/latest\.json .*--cache-control "public, max-age=30" --content-type application\/json --remote$/);
  // one title only
  const one = node([join(ROOT, 'pipeline', 'upload-r2.mjs'), '--out', OUT, '--title', 'orbit', '--dry-run']);
  assert.equal(one.status, 0, one.out);
  assert.ok(one.out.split('\n').filter((l) => l.startsWith('$ ')).every((l) => l.includes('atvqpr2-assets/games/orbit/')));
  // an ATV 2 title is refused before anything else
  for (const t of ['atv2', 'atvqpr2']) {
    const r = node([join(ROOT, 'pipeline', 'upload-r2.mjs'), '--out', OUT, '--title', t, '--dry-run']);
    assert.notEqual(r.status, 0); assert.match(r.out, /nothing of it is ever uploaded/); assert.ok(!r.out.includes('$ npx'));
  }
  const v = version();
  const refusals = [
    ['an extra atv2.wasm in out/r2', (d) => writeFileSync(join(d, BQ, 'v', v, 'atv2.wasm'), WASM), /atv2\.wasm.*(not in the plan|named like the game module)/],
    ['a file changed after the build', (d) => { const f = join(d, BQ, 'v', v, 'title.wasm'); const b = readFileSync(f); b[b.length - 1] ^= 1; writeFileSync(f, b); }, /title\.wasm: size\/SHA-256 differ from the plan/],
    ['a key outside games/<id>/v/<version>/', (d) => { const p = JSON.parse(readFileSync(join(d, 'r2-upload-plan.json'), 'utf8')); p.objects[0].key = 'game/atv2.wasm'; p.objects[0].file = 'r2/game/atv2.wasm'; writeFileSync(join(d, 'r2-upload-plan.json'), JSON.stringify(p)); }, /game\/atv2\.wasm: not games\/<id>\/latest\.json or games\/<id>\/v\/<version>\/<path>/],
    ['an ATV 2 prefix', (d) => { const p = JSON.parse(readFileSync(join(d, 'r2-upload-plan.json'), 'utf8')); p.titles.push({ id: 'atv2', prefix: 'games/atv2/', version: '1.0.0-000000000000' }); writeFileSync(join(d, 'r2-upload-plan.json'), JSON.stringify(p)); }, /bad title .*atv2/],
    ['a versioned object marked no-cache', (d) => { const p = JSON.parse(readFileSync(join(d, 'r2-upload-plan.json'), 'utf8')); p.objects[0].cacheControl = 'no-cache'; writeFileSync(join(d, 'r2-upload-plan.json'), JSON.stringify(p)); }, /Cache-Control must be "public, max-age=31536000, immutable"/],
  ];
  for (const [what, make, re] of refusals) {
    const d = copyOut(`up-${what.replace(/\W+/g, '-')}`);
    make(d);
    const r = node([join(ROOT, 'pipeline', 'upload-r2.mjs'), '--out', d, '--dry-run']);
    assert.notEqual(r.status, 0, `${what}: should be refused\n${r.out}`);
    assert.match(r.out, re, what);
    assert.match(r.out, /refusing to upload/);
    assert.ok(!r.out.includes('$ npx'), `${what}: no command may be printed`);
  }
  // rollback from a local copy of a kept version
  const rb = node([join(ROOT, 'pipeline', 'upload-r2.mjs'), '--out', join(TMP, 'rb'), '--rollback', v, '--title', 'boxquad', '--from', join(OUT, 'r2'), '--dry-run']);
  assert.equal(rb.status, 0, rb.out);
  assert.match(rb.out, /\$ npx wrangler r2 object put atvqpr2-assets\/games\/boxquad\/latest\.json .*--cache-control "public, max-age=30"/);
  assert.equal(readFileSync(join(TMP, 'rb', 'rollback', 'boxquad', 'latest.json'), 'utf8'), readFileSync(join(OUT, BQ, 'latest.json'), 'utf8'));
  // a rollback names its title, and only that title's versions
  assert.notEqual(node([join(ROOT, 'pipeline', 'upload-r2.mjs'), '--out', join(TMP, 'rb'), '--rollback', v, '--from', join(OUT, 'r2'), '--dry-run']).status, 0);
  assert.notEqual(node([join(ROOT, 'pipeline', 'upload-r2.mjs'), '--out', join(TMP, 'rb'), '--rollback', v, '--title', 'orbit', '--from', join(OUT, 'r2'), '--dry-run']).status, 0);
  assert.notEqual(node([join(ROOT, 'pipeline', 'upload-r2.mjs'), '--out', join(TMP, 'rb'), '--rollback', 'v1', '--dry-run']).status, 0);
});

test('R2 stand-in: CORS from deploy/r2-cors.json, preflights, ranges, Cache-Control, only planned keys', async () => {
  const srv = await createAssetServer({ port: 8857, bucketDir: join(OUT, 'r2'), rateRps: 0, testHooks: false, bucketCorsOrigins: [] }, {});
  try {
    const v = version();
    const u = (k) => `${srv.url}/${k}`;
    let r = await fetch(u('games/boxquad/latest.json'), { headers: { origin: 'https://atvqpr2.com' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://atvqpr2.com');
    assert.match(r.headers.get('access-control-expose-headers'), /Content-Range.*ETag/);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=30');
    r = await fetch(u('games/boxquad/latest.json'), { headers: { origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await fetch(u(`games/boxquad/v/${v}/textures/grass.rgba`), { headers: { origin: 'https://www.atvqpr2.com', range: 'bytes=100-199' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range').split('/')[0], 'bytes 100-199');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await r.arrayBuffer()).byteLength, 100);
    const etag = r.headers.get('etag');
    assert.match(etag, /^"[0-9a-f]{32}"$/);   // MD5, as R2
    r = await fetch(u(`games/boxquad/v/${v}/textures/grass.rgba`), { headers: { range: 'bytes=100-', 'if-range': '"stale"' } });
    assert.equal(r.status, 200, 'If-Range that does not match: the whole file');
    await r.arrayBuffer();
    const pre = (headers) => fetch(u(`games/boxquad/v/${v}/title.wasm`), { method: 'OPTIONS', headers: { origin: 'https://atvqpr2.com', 'access-control-request-method': 'GET', ...headers } });
    r = await pre({ 'access-control-request-headers': 'range,if-range' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-max-age'), '86400');
    assert.equal((await pre({ 'access-control-request-headers': 'x-secret' })).status, 403);
    assert.equal((await fetch(u(`games/boxquad/v/${v}/title.wasm`), { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })).status, 403);
    assert.equal((await fetch(u('r2-upload-plan.json'))).status, 404);
    assert.equal((await fetch(u(`games/boxquad/v/${v}/nothing.bin`))).status, 404);
    assert.equal((await fetch(u('games/boxquad/latest.json'), { method: 'PUT' })).status, 405);
  } finally { await srv.close(); }
  // a tree that fails the scan is never served
  const d = copyOut('srv-bad');
  writeFileSync(join(d, BQ, 'v', version(), 'atv2.wasm'), WASM);
  await assert.rejects(createAssetServer({ port: 8857, bucketDir: join(d, 'r2'), rateRps: 0 }, {}), /refusing to serve: the scan failed/);
});
void existsSync; void readdirSync;

test('profiles: a retail-derived profile can never have a remote source; the gate refuses an ATV 2 prefix in the bucket tree', async () => {
  const { checkProfile, remoteBase } = await import('../client/profile.js');
  const base = { format: 'game-profile/1', id: 'demo', title: 'Demo', entry: 'demo.wasm' };
  assert.ok(checkProfile({ ...base, sources: ['remote'], remote: { prefix: 'games/demo/' } }));
  assert.equal(remoteBase(checkProfile({ ...base, sources: ['remote'], remote: { prefix: 'games/demo/' } }), 'https://assets.example'), 'https://assets.example/games/demo/');
  assert.throws(() => checkProfile({ ...base, sources: ['remote'], remote: { prefix: 'v/' } }), /remote\.prefix must be "games\/demo\/"/);
  assert.throws(() => checkProfile({ ...base, derivedFromRetail: true, sources: ['local', 'remote'], remote: { prefix: 'games/demo/' } }), /derived from retail content/);
  assert.throws(() => checkProfile({ ...base, derivedFromRetail: true, sources: ['local'], remote: { prefix: 'games/demo/' } }), /derived from retail content/);
  const local = checkProfile({ ...base, derivedFromRetail: true, sources: ['local'] });
  assert.throws(() => remoteBase(local, 'https://assets.example'), /has no remote source/);
  // the game page's own profile (atvrecomp web/host/profiles/atv2.json has the same shape): local only
  for (const f of readdirSync(join(ROOT, 'profiles'))) {
    const p = checkProfile(JSON.parse(readFileSync(join(ROOT, 'profiles', f), 'utf8')), f);
    assert.ok(!p.derivedFromRetail && !/^atv/i.test(p.id), `${f}: only our own titles live in profiles/`);
  }
  // the tree: an ATV 2 prefix (any name of it) fails rule 18 even when its files look harmless
  for (const id of ['atv2', 'atvqpr2']) {
    const d = copyOut(`atvprefix-${id}`);
    cpSync(join(d, BQ), join(d, 'r2', 'games', id), { recursive: true });
    const r = verifyPackage(join(d, 'r2'), { quiet: true, delivery: true, r2: true, sourceRoot: ROOT });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => p.file === `games/${id}` && /ATV 2 prefix/.test(p.why)), JSON.stringify(r.problems.slice(0, 3)));
  }
});
