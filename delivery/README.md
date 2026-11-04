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
No npm packages (the one outside tool is Cloudflare's `wrangler`, which `pipeline/upload-r2.mjs` runs through `npx` with your own login). MIT licence (`LICENSE`).

## Layout

| path | what |
|---|---|
| `server/asset-server.mjs` | the asset backend (config: `server/config.mjs`, env vars; rate limit: `server/ratelimit.mjs`) |
| `client/assets.js` | the asset manager and its two content sources (`HttpBackend`: asset server or versioned bucket; `LocalFilesBackend`) |
| `client/asset-worker.js` | downloads (Range resume, retries with backoff), streaming SHA-256 checks, atomic OPFS writes (`.part` + `createWritable`, verify, rename, mark), start-up verify and clean-up, in a worker |
| `client/sha256.js` | a small incremental SHA-256 (WebCrypto cannot hash a stream) |
| `client/launcher.js` | the small API the Play button calls |
| `client/sw.js` | the shell's service worker (page and code offline; assets stay in OPFS) |
| `web/` | the launcher page (`index.html`, `page.js`) and the test title's page code (`app/title.js`, `app/hub.js`) |
| `title/` | the test title: `src/quad.c` (physics, laps, mesh transform), `gen-assets.mjs` (procedural textures, track, mesh), `build.mjs`, `delivery.json` (required files, on-demand groups, title version) |
| `hub/hub.mjs` | the free-roam hub: a copy of atvrecomp's `web/tools/roamhub.mjs` (same protocol) with proxy settings |
| `pipeline/build.mjs` | the one-command pipeline |
| `pipeline/manifest.mjs` | manifest (format 2) + the asset server's layout + the versioned bucket tree (R2) |
| `pipeline/upload-r2.mjs` | puts `out/r2` into the R2 bucket with wrangler (`--dry-run`, `--rollback`, `--check`); never run by the pipeline |
| `pipeline/verify-package.mjs` | the scan: builder's `verify-package.mjs`, copied and extended with `--delivery` / `--assets` |
| `pipeline/caddy-headers.mjs` | the site's `_headers` as a Caddy snippet |
| `deploy/` | Docker Compose, Caddyfile, `.env.example`, `check.mjs`, README (VPS walk-through); `r2-cors.json` + `R2.md` (the R2 bucket) |
| `test/` | unit tests (`*.test.mjs`), the Edge end-to-end tests (`e2e.mjs`: VPS layout; `r2-e2e.mjs`: the site + R2 stand-in), `cdp.mjs`, `site-serve.mjs` |

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
// or: new HttpBackend({ base: 'https://assets.atvqpr2.com' })     (a versioned bucket: latest.json -> v/<version>/manifest.json)
// or: backend: new LocalFilesBackend({ files: input.files, validate })
await assets.open();                                   // the catalog
await assets.verifyStore();                            // clean up leftovers, check what OPFS holds
await assets.download(assets.required(), { concurrency: 3, onProgress });   // the start set
await assets.loadGroup('sand');                        // an on-demand group, on first use
const buf = await assets.arrayBuffer('textures/grass.rgba', { onProgress });   // on first use
await assets.prefetch();                               // everything (offline-ready)
await assets.status();                                 // { stored, missing, offlineReady, version }
```

- **Mode 1, server/CDN (`HttpBackend`)**: the manifest (or `latest.json`
  and, when the version changed, its manifest) is fetched; offline, the copy
  stored last time is used. Files are streamed into OPFS with progress,
  checked with SHA-256 as they arrive, and kept under their hash; later
  visits fetch only files whose hash changed. Interrupted downloads resume
  with Range, within a session and across page loads. Details: "The
  downloader" below.
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
`fetch` (large files might use a size/mtime key instead of hashing every
byte), and its stored-import check becomes
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

## Manifest and layouts

```
{ format: 'delivery-manifest/2', title, name, version, entry,
  build: { titleVersion, pipeline },
  files: [ { path, size, sha256, url, type,
             required: true|false,          // needed before the title starts
             group?: 'sand',                // fetched together on first use (on-demand)
             compress?, chunkSize?, chunks?, artifact? } ] }
```

- `version` is the build version: `<titleVersion>-<12 hex>`, the hex being
  the SHA-256 of everything the manifest says about the files and the title.
  No clock or commit goes in: the same inputs give the same version and the
  same bytes (the pipeline is reproducible; `test/r2.test.mjs` builds twice
  and compares), any change gives a new version.
- `required` and `group` come from `title/delivery.json`; files that are
  neither are fetched in the background after start.
- `chunks`: SHA-256 per 1 MiB chunk (files over 1 MiB), so a bad chunk is
  caught and fetched again as it arrives. `artifact` (compiled modules):
  every source file with its SHA-256, the toolchain and the command.

Two layouts of the same manifest:

```
out/assets/  (the asset server, VPS)              out/r2/  (the R2 bucket, assets.atvqpr2.com)
manifest.json            no-cache                  latest.json                  no-cache   { format: 'delivery-latest/1', title, version,
objects/<aa>/<sha256>    immutable                                                           manifest: 'v/<version>/manifest.json', sha256, size }
  (url = objects/aa/<sha256>)                      v/<version>/manifest.json    immutable
                                                   v/<version>/<path>           immutable  (url = <path>)
```

The bucket keeps every version (immutable trees); `latest.json` is the only
object that changes. A release uploads `v/<version>/` first and
`latest.json` last; rollback points `latest.json` back at a kept version.
`out/r2-upload-plan.json` lists every key with its file, size, SHA-256,
Content-Type and Cache-Control (`public, max-age=31536000, immutable` for
`v/`, `no-cache` for `latest.json`). See `deploy/R2.md`.

### The downloader (asset-worker.js)

- The launcher reads `latest.json` (no-cache), and the version's manifest
  only when the version changed (checked against the pointer's SHA-256);
  then `verifyStore()` cleans up and checks OPFS, `download()` fetches
  the required files that are missing or bad (`concurrency` at a time, 3 by
  default), with progress in bytes and percent per file and in total.
- Every byte goes through the incremental SHA-256 as it arrives; whole files
  are never held in memory (chunked files: the current 1 MiB chunk is).
- Atomic writes: a download goes to `blobs/<sha256>.part` with
  `createWritable()`, committed at checkpoints (4 MiB, then every half of
  what is there, only at verified chunk boundaries), checked, then renamed to
  `blobs/<sha256>` and marked (`<sha256>.ok`: its size and lastModified). A
  file is never "cached" before that.
- Cached files: a blob is trusted while its mark matches; anything that
  writes to it changes lastModified, so it is hashed again and, if wrong,
  deleted and fetched again. `prepare({ fullVerify: true })` hashes all.
- Start-up clean-up (`scrub`): `.part` files of other versions, of files
  already stored, or of small unchunked files go; a chunked `.part` has its
  complete chunks checked and is cut back before the first bad one; swap
  files (`*.crswap`), marks without files and unknown names go. Files
  another tab is downloading (Web Lock held) are left alone.
- Resume: `Range: bytes=<length of .part>-`, with `If-Range` when the
  server gave a strong ETag for the identity bytes; within a page (retries
  with backoff and jitter, `Retry-After` honoured) and across page loads
  (the `.part` stays).
- Errors keep their codes (`offline`, `manifest`, `missing`, `hash`,
  `network`, `http`, `opfs`, ...), with messages that say what to do.

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
- **R2 stand-in** (`ASSET_BUCKET_DIR=out/r2`): serves the versioned tree at
  `/<key>` the way R2 does: only the upload plan's keys, its Cache-Control
  and Content-Type, an MD5 ETag, Range/If-Range, no compression, no
  COOP/COEP/CORP, and CORS (preflights too) from `deploy/r2-cors.json`
  (`ASSET_BUCKET_CORS_ORIGINS` adds the local site's origin for tests).
  Refuses a tree that fails the scan.

## The pipeline and the gate

`node pipeline/build.mjs [--out out] [--hub-url ws://127.0.0.1:8854/ | /hub/] [--site ../site] [--no-site] [--variant N]`

1. scans its inputs (`title client web server hub pipeline deploy test`) with
   the delivery rules; any problem stops the build before anything is read;
2. builds the test title: `title.wasm` with wasi-sdk 34 (`--target=wasm32
   -nostdlib`, reproducible paths) and the procedural assets; records the
   artifact (sources with hashes, toolchain, command) in `artifacts.json`;
3. writes the manifest (`title/delivery.json`: required files, groups,
   title version), the asset server's layout (`out/assets`), the versioned
   R2 tree (`out/r2`) and its upload plan (`out/r2-upload-plan.json`);
4. the web shell (`out/web`: launcher, client, title page code, `sw.js` with
   its shell list and version stamped in, `config.json`);
5. the site, exactly as committed: `git archive <ref>` of `../site`, unpacked
   by the pipeline (links refused) into `out/site`, plus `out/site.caddy`;
6. the servers (`out/app`: asset server, hub, and the scan they run);
7. **the gate** over the whole output (`--delivery`), the asset layout
   (`--assets`), the R2 tree (`--r2`), the upload plan against the tree,
   and the site (`--site`); and every wasm in the output must be one this
   run built. Any problem fails the build; it ran in
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
18. `--r2`: `latest.json` required, well formed, pointing at an existing
    `v/<version>/manifest.json` with that size and SHA-256; every version's
    manifest well formed (rule 17's entry checks, url = path, version = its
    folder); every other file is a listed `v/<version>/<path>` with that
    size and hash; nothing else.

`pipeline/upload-r2.mjs` runs rule 18 (and the name rules on every key)
again on exactly what it would upload, checks every file against the plan,
and refuses on any problem before a single command runs. There is no target,
option or key layout for anything but the test title.

## The project site and the test title (R2)

The site (`../site`) has one Play panel with two content sources:

- **ATV 2**: "Select local game files", unchanged. The player picks the play
  folder their builder made; the game page (`play/host/`) imports it into
  OPFS on their machine. Nothing of the game is ever downloaded.
- **Test title** (Box Quad, ours), "streamed from assets.atvqpr2.com": the
  delivery client (`client/*.js`, copied to `site/test-title/lib/` by the
  site's `tools/sync-delivery.mjs`, with an allow-list and from committed
  bytes only) streams it from the R2 bucket into OPFS, and it runs on its own
  small page, `site/test-title/`, with a service worker for its shell
  (offline starts). The bucket address is the site setting `assets_base`
  (default `https://assets.atvqpr2.com`); on a local copy only (localhost,
  127.0.0.1, [::1]) `?assets=<url>` overrides it for tests.

Why a separate runner page and not the ATV 2 game page (design B, not A):
`play/host` boots only modules built against the ATV host ABI (WASI threads
on a shared memory, the `env.web_host_ready` host block, the GpFrame GPU
queue, the I/O worker's VFS over `atv2-game/`), and before that it requires
a retail `default.xbe` and an `atv2.wasm` whose size and SHA-256 are on its
build list. Rebuilding the test title against that ABI means writing a
second Xbox-shaped program (host block, GPU command stream, boot stages), and
then teaching the page to accept it; that is not moderate. Design B keeps one
asset system (the delivery client and its OPFS layout) and one Play panel,
and leaves `play/` and atvrecomp untouched.

What running a remote build through `play/host` would still need (runtime
integration only; whether anything of ATV 2 may ever be distributed is a
separate question this repository does not answer, and nothing here does it):

1. A source for the module: `main.js`/`gamebuild.js` read `atv2.wasm` from
   `atv2-build/` in OPFS (site mode) or `/wasm/` (dev). A third mode would
   get it from the delivery client (`AssetManager.get()` -> `File`) and
   compile it the same way (`loadStoredWasm` shape: `{ module, limits,
   info }`; the memory limits from the module bytes or a manifest field).
2. Accepted builds: `gamebuild.js` accepts only builds listed in
   `deploy.js` (written by `tools/sync-play.mjs` from the builder's
   `build-expected.json`). A remote module would need its own list entry
   (size, SHA-256, the atvrecomp/xboxrecomp commits it shares the ABI with),
   checked against the manifest's `artifact` record.
3. Game files: `vfs.js` mounts `atv2-game/` (paths as on the disc, an
   `.import.json` record, 8 MiB chunked import). Serving files to the I/O
   worker from the delivery client's content-addressed `blobs/` would need a
   path -> blob map in `vfs.js` (or an import step that copies/links blobs
   into `atv2-game/`), plus on-demand reads for groups (movies, music).
4. The retail check: `loader.js` validates `default.xbe` before anything
   else; a remote source would need its own validation path.
5. Headers: `play/host` needs COOP/COEP (already on the site); CORS-mode
   fetches from the bucket work under COEP (see `deploy/R2.md`).
6. Tests: `work/siteplay/test-play-live.mjs` style boots for the new mode.

These are changes in atvrecomp (`web/host`) and the builder, then a
`tools/sync-play.mjs` run; none of them is made here.

## Tests

All local: servers on 127.0.0.1 ports 8853-8859, Edge headless via CDP with
the profile in `.test/edge-profile`, output under `.test/` (git-ignored).

```
node --test test/*.test.mjs     # server (15), gate (22), deploy (2), r2 (5)
node test/e2e.mjs [--profile <dir>]          # the VPS path in Edge; .test/e2e/results.json + shots/
node test/r2-e2e.mjs [--site ../site] [--profile <dir>] [--results <dir>]   # the site's test title from the R2 stand-in
node deploy/check.mjs --out out --dry-run
node pipeline/upload-r2.mjs --dry-run         # the upload commands, after every check
```

`test/r2-e2e.mjs` serves the site folder with its own `_headers`
(`test/site-serve.mjs`; the CSP's connect-src gets the stand-in's origin,
nothing else changes) on 127.0.0.1:8849 and `out/r2` from the R2 stand-in
on 127.0.0.1:8855, and drives the site's test title page
(`test-title/?assets=http://127.0.0.1:8855`): the Play panel's two sources,
first start (bytes, time, progress), the on-demand group, relaunch with 0
downloads, offline (both servers stopped), resume after cut connections
(within a page and across page loads), corrupted bodies, a corrupted cached
file, `.part` clean-up, and `?verify=full`.

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
