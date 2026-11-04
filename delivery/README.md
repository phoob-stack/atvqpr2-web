# delivery - server-hosted delivery for browser games

Generic infrastructure to ship a browser game from a server or CDN: an asset
backend, a launcher/loader that streams files into the browser's own storage
(OPFS) and runs offline afterwards, a one-command build pipeline with a hard
no-game-content gate, a free-roam multiplayer hub, and VPS configuration.
It is proven end to end with a placeholder title of our own ("Box Quad": a
box quad on a flat track, C compiled to wasm, procedural textures).

**What this never carries.** This project sits next to a static
recompilation of the retail Xbox game *ATV Quad Power Racing 2*. Its module
(`atv2.wasm`), the generated C (`src/recomp/gen`), the disc files and anything
derived from them never go into a manifest, the asset folder, a CDN/bucket
layout or the pipeline output, and no pipeline step reads them. There is no
target, script or option that packages or serves them; the gate fails the
build if any such file shows up, and the asset server refuses to start on a
folder that holds one. On the public site ATV 2 keeps its existing "player
picks their own files" path, which this repository does not touch.

Everything uses Node built-ins (Node 22+; tested on 24.13.1) and the browser.
No npm packages. MIT licence (`LICENSE`).

## Layout

| path | what |
|---|---|
| `server/asset-server.mjs` | the asset backend (config: `server/config.mjs`, env vars; rate limit: `server/ratelimit.mjs`) |
| `client/assets.js` | the asset manager and its two content sources (`HttpBackend`, `LocalFilesBackend`) |
| `client/asset-worker.js` | downloads, Range resume, SHA-256 checks and OPFS writes (SyncAccessHandle), in a worker |
| `client/launcher.js` | the small API the Play button calls |
| `client/sw.js` | the shell's service worker (page and code offline; assets stay in OPFS) |
| `web/` | the launcher page (`index.html`, `page.js`) and the test title's page code (`app/title.js`, `app/hub.js`) |
| `title/` | the test title: `src/quad.c` (physics, laps, mesh transform), `gen-assets.mjs` (procedural textures, track, mesh), `build.mjs` |
| `hub/hub.mjs` | the free-roam hub: a copy of atvrecomp's `web/tools/roamhub.mjs` (same protocol) with proxy settings |
| `pipeline/build.mjs` | the one-command pipeline |
| `pipeline/manifest.mjs` | manifest + content-addressed layout |
| `pipeline/verify-package.mjs` | the scan: builder's `verify-package.mjs`, copied and extended with `--delivery` / `--assets` |
| `pipeline/caddy-headers.mjs` | the site's `_headers` as a Caddy snippet |
| `deploy/` | Docker Compose, Caddyfile, `.env.example`, `check.mjs`, README (VPS walk-through) |
| `test/` | unit tests (`*.test.mjs`), the Edge end-to-end test (`e2e.mjs`, `cdp.mjs`) |

## Quick start (local, 127.0.0.1)

```
node pipeline/build.mjs                       # -> out/ (gate included)
ASSET_DIR=out/assets WEB_DIR=out/web ASSET_CSP_CONNECT=ws://127.0.0.1:8854 node server/asset-server.mjs
node hub/hub.mjs                              # 127.0.0.1:8854
# open http://127.0.0.1:8853/ and press Play; a second tab shows the other player
```

PowerShell: `$env:ASSET_DIR='out/assets'; $env:WEB_DIR='out/web'; ...` then the same commands.

## Two content sources, one asset manager

The runtime, renderer and multiplayer code see one API; only where files
come from differs.

```js
import { AssetManager, HttpBackend, LocalFilesBackend } from './client/assets.js';
const assets = new AssetManager({ ns: 'boxquad', backend: new HttpBackend({ manifestUrl: './assets/manifest.json' }) });
// or: backend: new LocalFilesBackend({ files: input.files, validate })
await assets.open();                                   // the catalog
const buf = await assets.arrayBuffer('textures/grass.rgba', { onProgress });   // on first use
await assets.prefetch();                               // everything (offline-ready)
await assets.status();                                 // { stored, missing, offlineReady, version }
```

- **Mode 1, server/CDN (`HttpBackend`)**: the manifest is fetched (revalidated
  with its ETag; offline, the copy stored last time is used). Each file is
  fetched the first time the title asks for it, streamed with progress,
  checked against its SHA-256 (per 1 MiB chunk for larger files), and kept in
  OPFS under its hash. Later visits fetch only files whose hash changed.
  Interrupted downloads resume with `Range: bytes=<stored>-` and
  `If-Range: "<sha256>"`, within a session (retries with backoff) and across
  page loads (the partial file stays in OPFS).
- **Mode 2, the player's own files (`LocalFilesBackend`)**: a folder from
  `<input type=file webkitdirectory>` (or any `File` list) is read in the
  browser, hashed, checked (against a `manifest.json` in the folder if there
  is one, and by an optional title-specific `validate(entries)` hook), and
  kept in OPFS in its own namespace, so later visits need no pick.

A backend is `{ kind, catalog(store) -> { catalog, offline }, fetch(entry, ctx) }`,
so other sources plug in the same way. **ATV 2's existing flow** (`site/play/host/loader.js`
+ `gamebuild.js`, "Select local game files") maps onto `LocalFilesBackend`
without changing what it accepts: its `default.xbe` retail check and
`checkBuild()` become the `validate` hook, its 8 MiB-chunk OPFS import becomes
`fetch` (large files would use the size/mtime key instead of hashing every
byte; `hashLimit` marks where), and its stored-import check becomes
`catalog()` with no files. That port is for the site's owners to do in
atvrecomp/site; this repository does not modify either, and mode 1 is only
ever used with our own test title.

Errors are `DeliveryError`s with a `code` the page can act on: `offline`
(first visit without a connection), `manifest`, `missing`, `hash` (failed its
check twice), `network` (gave up; the partial file is kept), `http`, `opfs`
(storage blocked or full), `pick-needed`, `invalid` (the picked folder failed
its check), `unknown-file`. Messages say what happened and what to do.

### The launcher API (the Play button)

```js
import { Launcher, registerShell } from './client/launcher.js';
registerShell('./sw.js');
const l = new Launcher({ ns: 'boxquad' }).useServer('./assets/manifest.json');   // or .useLocalFiles(files)
l.addEventListener('state', (e) => ...);      // catalog / downloading / compiling / ready / running / error
l.addEventListener('progress', (e) => ...);   // { loaded, total, percent, path } over the start set
await l.prepare({ start: async (a) => (await a.json('config/title.json')).start });
await l.play(titleModule, { canvas });        // titleModule.start({ assets, module, ... })
l.prefetchRest();                             // the rest in the background (offline-ready)
```

## Manifest and layout

`out/assets/` is what the asset server serves and what a CDN bucket holds:

```
manifest.json                  { format: 'delivery-manifest/1', title, version, entry, files: [...] }
objects/<aa>/<sha256>          each file by content: immutable, cacheable forever
```

A file entry: `path`, `size`, `sha256`, `url` (`objects/aa/<sha256>`), `type`,
`compress` (worth gzip/brotli; measured at build time), `chunkSize` + `chunks`
(SHA-256 per chunk, files over 1 MiB), and for compiled modules `artifact`
(`source`: every source file with its SHA-256, `toolchain`, `command`).
`version` is the hash of the (path, sha256) list.

## The asset server

`node server/asset-server.mjs`, configured by environment (`server/config.mjs`):
binds 127.0.0.1:8853 by default (anything else needs `ASSET_ALLOW_PUBLIC=1`),
`ASSET_DIR` (manifest + objects at `/assets/`), `WEB_DIR` (static root),
`ASSET_CDN_BASE` + `ASSET_CDN_MODE=redirect|proxy`, `ASSET_CORP`,
`ASSET_RATE_RPS`/`ASSET_RATE_BURST`, `ASSET_TRUST_PROXY(_HOPS)`, `ASSET_COMPRESS`.

- Range requests (single range, suffix, `If-Range`, 416), strong ETags
  (`"<sha256>"` for objects), `Cache-Control: public, max-age=31536000,
  immutable` for content-addressed paths and `no-cache` for the manifest and
  page files, 304s.
- gzip/brotli via `node:zlib` for whole-body responses of compressible files
  (cached in memory), never for ranges, so resume offsets are identity bytes.
  Trade-off: a resumed remainder travels uncompressed.
- COOP `same-origin`, COEP `require-corp`, CORP on every response; a CSP on
  HTML.
- Only objects listed in the current manifest are served; the manifest is
  re-read when it changes.
- Path traversal: one decode, then segments must match `[A-Za-z0-9._~-]+`;
  dot segments, encoded slashes/backslashes, NUL, control characters and
  dotfiles are refused, and resolved paths (also after symlinks) must stay in
  their root.
- Token-bucket rate limit per client (429 + `Retry-After`).
- Refuses to start when `ASSET_DIR` or `WEB_DIR` fails the scan.
- `ASSET_TEST_HOOKS=1` (loopback only): `/__test/stats`, `cut`, `corrupt`,
  `throttle` for the tests.

## The pipeline and the gate

`node pipeline/build.mjs [--out out] [--hub-url ws://127.0.0.1:8854/ | /hub/] [--site ../site] [--no-site] [--variant N]`

1. scans its inputs (`title client web server hub pipeline deploy test`) with
   the delivery rules; any problem stops the build before anything is read;
2. builds the test title: `title.wasm` with wasi-sdk 34 (`--target=wasm32
   -nostdlib`, reproducible paths) and the procedural assets; records the
   artifact (sources with hashes, toolchain, command) in `artifacts.json`;
3. writes the manifest and the content-addressed layout (`out/assets`);
4. the web shell (`out/web`: launcher, client, title page code, `sw.js` with
   its shell list and version stamped in, `config.json`);
5. the site, exactly as committed: `git archive <ref>` of `../site`, unpacked
   by the pipeline (links refused) into `out/site`, plus `out/site.caddy`;
6. the servers (`out/app`: asset server, hub, and the scan they run);
7. **the gate** over the whole output (`--delivery`), the asset layout
   (`--assets`) and the site (`--site`); and every wasm in the output must be
   one this run built. Any problem fails the build; it ran in
   `<out>.staging`, which is deleted, and `out/` is left as it was.

Paths of the game's build trees (`atvrecomp`, `xboxrecomp`, `builder`,
`work`, `atv2rewrite`, the builder's `%LOCALAPPDATA%` folders,
`src/recomp/gen`, `build-wasm`, `atv2-play`, ...) are refused as inputs or
outputs.

**The ATV 2 runtime.** The task allowed an optional, default-off hook for the
prebuilt ATV runtime package as an opaque input, but only if a
`verify-runtime` of ours proved it holds no game content. No such tool exists
in this workspace, so it is left out: `--with-atv-runtime` is refused with an
explanation. If it is ever added, it must be a separate, default-off input
that this gate still scans in full.

### Scan rules (`pipeline/verify-package.mjs`)

Rules 1-11 are the builder's, unchanged (forbidden extensions `.xbe .iso .bah
.bad .xpr .wav .wasm ...`, files over 5 MB, `src/recomp/gen` and lifter file
names, lifter banners and lifted-function definitions by content, XBE / disc
image / wasm / RIFF-WAVE magic numbers, and the `--site` rules). `--delivery`
adds:

12. a `.wasm` (by name or by magic number) only if its SHA-256 is a declared
    artifact (`artifacts.json`, or the manifest's `artifact` record) with a
    recorded source and toolchain; with `--source-root`, each source must
    exist unchanged and be clean itself; never `atv2*.wasm`, declared or not;
13. known game files by SHA-256 (the reference `atv2.wasm`, the retail
    `default.xbe`; hashes only), whatever the name;
14. lifter markers in every file, binaries too, and more than 20
    `sub_XXXXXXXX` names (a lifted module's name section or symbol map);
15. generated WGSL from the game (the shader generator's uniform blocks) in
    any text file;
16. the game's build/storage paths (`build-wasm`, `atv2-play`, `atv2-game`,
    ...) and save files (`.xbx`);
17. `--assets`: `manifest.json` required and well formed; every file is a
    listed object with that size and hash; every logical path passes the name
    rules.

## Tests

All local: servers on 127.0.0.1 ports 8853-8859, Edge headless via CDP with
the profile in `.test/edge-profile`, output under `.test/` (git-ignored).

```
node --test test/*.test.mjs     # server (15), gate (22), deploy (2)
node test/e2e.mjs               # the whole path in Edge; .test/e2e/results.json + shots/
node deploy/check.mjs --out out --dry-run
```

`test/gate.test.mjs` drops a made-up `atv2.wasm`, a generated-looking
`recomp_0001.c`, a `.xbe` (and `.wav .bah .bad .xpr .iso`, a wasm under an
innocent name, generated WGSL, `src/recomp/gen` and `build-wasm` paths,
symbol tables) into the pipeline's inputs, and a committed `atv2.wasm` into a
site fixture, and checks the build fails and leaves `--out` untouched. No game
data is read: the forbidden files are a few bytes in the right shape.

`test/e2e.mjs` steps: first load, on-demand fetch, second visit, one changed
asset, resume after a cut socket, corrupted bodies, offline second load,
mode 2 (picked folder, then no pick), the hub with two tabs, the VPS route
layout (`/demo/` + `/hub/` behind one origin), and a throttled progress
screenshot.
