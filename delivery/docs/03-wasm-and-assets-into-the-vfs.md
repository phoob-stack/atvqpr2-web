# 3. How wasm modules and assets get to where the code reads them

Both kinds of title use the same OPFS store, `delivery/<ns>/`, written only by
the delivery asset worker (`client/asset-worker.js`):

```
delivery/<ns>/catalog.json        the catalog the page served last (manifest format 2)
delivery/<ns>/blobs/<sha256>      a file, by content; only ever appears by a rename after its SHA-256 matched
delivery/<ns>/blobs/<sha256>.ok   its mark: { size, lastModified } when last verified
delivery/<ns>/blobs/<sha256>.part a download or store in progress (resumable)
```

## Test titles (remote, `site/test-title/`)

1. `runner.js` loads the profile (`?game=<id>`, `profiles/<id>.json`), its
   page code (`app/<app>.js`) and calls `Launcher.useProfile(profile, assets
   base)` (`client/launcher.js`): an `HttpBackend` on `games/<id>/`.
2. `Launcher.prepare()`: the catalog (latest.json -> manifest), the start-up
   clean-up and mark check (`verifyStore`), the required files
   (`download`, 3 at a time, Range resume, SHA-256 as bytes arrive, per-chunk
   checks), then `WebAssembly.compile(await assets.arrayBuffer(entry))`.
3. `Launcher.play(app)`: `app.start({ assets, module, canvas, ... })`. The
   title instantiates the module itself and reads its assets with
   `assets.json/arrayBuffer/get(path)` (an OPFS-backed `File`), and on-demand
   groups with `assets.loadGroup(name)` (a read that waits for its fetch).

## ATV 2 (local)

1. The import stores each file of the play folder as a blob (hashed while
   written) and lists it in the catalog under `game/<disc path>` or
   `build/atv2.wasm`.
2. The module: `LocalImportSource.module()` reads `build/atv2.wasm`'s blob,
   hashes it, checks the accepted builds, `WebAssembly.compile`s it once; the
   `Module` goes to every thread Worker by `postMessage` (`threads.js`); the
   shared memory's limits come from the module's import section
   (`wasm-load.js memoryImportLimits`).
3. The files: the I/O worker (`io-worker.js`) mounts the profile's mounts with
   `vfs.js Vfs.mountStore({ ns, mounts })`: every catalog file under `game/`
   becomes a read-only node under `/game`, backed by a `SyncAccessHandle` on
   its blob (one handle per blob). The guest's WASI calls (`path_open`,
   `fd_read`, `fd_pread`, ...) from any thread go through `io.js` to that one
   I/O worker, which reads the handles synchronously. The C runtime maps
   `D:\` and `\Device\CdRom0\` to `/game` and the hard-disk paths to `/save`
   (xboxrecomp `src/kernel/kernel_path.c`; table in the trace).

On-demand groups for ATV 2 would need reads that wait for a fetch; with a
local import everything is on disk, so the profile has no groups and the I/O
worker never waits on the network.
