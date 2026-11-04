# 2. How the ATV 2 runtime gets its files: the local source

ATV 2's game page (`atvrecomp/web/host`, on the site as `play/host`) starts
from one asset-source interface, `web/host/assetsource.js`, built on the same
delivery client as the test titles (`web/host/delivery/`, an allow-listed copy
of delivery's `client/assets.js`, `asset-worker.js`, `sha256.js`,
`profile.js`, made by `web/tools/sync-delivery.mjs` from committed bytes).
Its only provider is the player's own files. The full trace with file and
function references is `notes/ATV2-LOADER-TRACE.md`.

## The profile

`web/host/profiles/atv2.json` (format `game-profile/1`):

- `derivedFromRetail: true`, `sources: ["local"]`: no remote source, no R2
  prefix, no manifest anywhere. `delivery/client/profile.js checkProfile()`
  refuses a remote source for such a profile, so one cannot be configured by
  accident (the page, the pipeline and `upload-r2.mjs` all go through it);
- `entry: "build/atv2.wasm"`, `mounts: [{ at: "/game", from: "game/" }]`;
- `local`: the root file (`default.xbe`), the save folders left out, the
  layout (`build/` for the module and its record, `game/` for the rest), the
  optional movies, the checks (default.xbe size and SHA-256, ATV.bah/ATV.bad)
  and the player-facing messages.

## The interface (`assetsource.js`)

```
const src = await localSource();             // LocalImportSource for the profile
await src.status()     -> { ready, reason: 'none'|'stale'|'nobuild'|'damaged', record, build }
await src.quick()      -> a catalog with an accepted build? (no file checks; starts status())
src.module()           -> { module, limits, info() }   (the stored build, hashed again, compiled)
src.ioGame()           -> { source: 'store', ns: 'atv2', mounts }   (what the I/O worker mounts)
await src.files('/game'), await src.file('game/user.xml')
src.groups(), src.loadGroup(name)            (none for a local import)
await src.importFolder(scan, { skipMovies, onPhase, onProgress, log })
await src.forget()
```

`DevServerSource` (the local page's `serve.mjs --game`, never on the site)
implements the same calls over `/data/` and `/wasm/`.

`main.js` asks `loader.js peekGame()` / `prepareGame()` for a source and then
runs one start-up for whichever it is: memory, thread Workers, WASI and the
I/O worker, GPU, audio, input, saves, roam.

## Storage and verification

- One namespace, `delivery/atv2/`: `catalog.json` (`delivery-manifest/2`,
  source `local`), `blobs/<sha256>` + `.ok` marks, `local-index.json`.
- Import: every file is hashed while it is written (one read, in the asset
  worker; WebCrypto for files up to 128 MiB, the incremental hash above
  that), written as `.part` with `createWritable()`, renamed, marked. The
  catalog is written last, so a half import is never "ready".
- Every start: the catalog's build must be on the page's list (`deploy.js`),
  the module is hashed again while it compiles (the Module is used only if
  the hash is listed), and every file's mark is checked in parallel with the
  start (the I/O worker mounts the files only after that check passes) (a changed file is hashed again, and deleted if wrong; the page then
  asks for the folder again and copies only what is missing).
- Saves live in their own OPFS folders (`atv2-saves/`), untouched by imports,
  forget and migration.
- Older imports (`atv2-game/` + `atv2-build/`) are moved into the store once,
  without a second copy, and the old folders are removed.
