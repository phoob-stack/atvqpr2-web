# 1. The R2 provider: bucket structure and manifest format

The bucket (`atvqpr2-assets`, public at `https://assets.atvqpr2.com`) holds one
versioned tree per title, under the prefix its game profile names
(`profiles/<id>.json`, `remote.prefix` = `games/<id>/`). Only titles of ours
are ever in it: a profile derived from retail content cannot have a remote
source (see 4 and 5), and the gate refuses an ATV 2 prefix.

```
games/<id>/latest.json                    public, max-age=30               the pointer: which version is current
games/<id>/v/<version>/manifest.json      public, max-age=31536000, immutable
games/<id>/v/<version>/<path>             public, max-age=31536000, immutable   one object per file, by its path
```

- `version` is `<titleVersion>-<12 hex>`: the hex is the SHA-256 of everything
  the manifest says about the files and the title (no clock, no commit), so
  the same inputs give the same version and the same bytes, and any change
  gives a new version.
- A release uploads the version's files, then its manifest, then
  `latest.json`; older versions stay. Rollback = put `latest.json` back to a
  kept version.
- Before the move to prefixes, Box Quad 1.1.0 lived at the bucket root
  (`latest.json`, `v/1.1.0-c230f2d0b4ba/`). The same build now comes out
  byte for byte under `games/boxquad/`; the root objects stay until the owner
  removes them, and Box Quad's profile reads the root's `latest.json` while
  `games/boxquad/latest.json` does not exist yet (`remote.fallbackPrefix: ""`).

## latest.json (`delivery-latest/1`)

Real, Box Quad:

```json
{
 "format": "delivery-latest/1",
 "title": "boxquad",
 "version": "1.1.0-c230f2d0b4ba",
 "manifest": "v/1.1.0-c230f2d0b4ba/manifest.json",
 "sha256": "92dfe2812ea96b92b8fe6e468f3b7f854cf2d5919f7413c7ce1a48c6a4bbe795",
 "size": 3413
}
```

`manifest` is relative to the title's prefix; `sha256`/`size` are the
manifest's bytes (the client checks them before trusting it).

## manifest.json (`delivery-manifest/2`)

```
{ format: 'delivery-manifest/2', title, name, version, entry,
  build: { titleVersion, pipeline: 'delivery-pipeline/2' },
  files: [ { path, size, sha256, url, type,
             required: true|false,          // fetched before the title starts
             group?: '<name>',              // an on-demand group, fetched on first use
             compress?: true,               // worth gzip/brotli on the wire
             chunkSize?, chunks?: [sha256], // per 1 MiB chunk, files over 1 MiB
             artifact?: { source: [{ path, sha256 }], toolchain, command } } ] }   // compiled modules
```

Real, Box Quad 1.1.0-c230f2d0b4ba (three of its seven files):

```json
{
 "format": "delivery-manifest/2",
 "title": "boxquad",
 "name": "Box Quad (delivery test title)",
 "version": "1.1.0-c230f2d0b4ba",
 "entry": "title.wasm",
 "build": { "titleVersion": "1.1.0", "pipeline": "delivery-pipeline/2" },
 "files": [
  { "path": "config/title.json", "size": 284,
    "sha256": "6d0ed2b3049092f01537127a8d5c817354fafb2094721873e4ec170e1a7da523",
    "type": "application/json", "required": true, "url": "config/title.json" },
  { "path": "textures/sand.rgba", "size": 2359312,
    "sha256": "c7bb64ed44f06b1787e5851d14c4929ab075b1caf1187fc2e3d5cdf99fae3b65",
    "type": "application/octet-stream", "required": false, "group": "sand", "compress": true,
    "chunkSize": 1048576,
    "chunks": ["36faba0208c4abc6b70f5d9c4372c67a97c31730e23bf299bf04c2083bc8b1ea",
               "09b7cf88dcc58ade5adc758c2229e11f835a25951f2697e352c4ec03932a6b33",
               "3b9b670879524c41cdd2b73d9100e6e2fa8a8bf0dc5e853aa47a2c5666dac1a4"],
    "url": "textures/sand.rgba" },
  { "path": "title.wasm", "size": 4897,
    "sha256": "84966b410c1d482d801d190d66f8ad8d9cde402a020de389e19a22ec0450ad49",
    "type": "application/wasm", "required": true, "compress": true,
    "artifact": {
      "source": [{ "path": "title/src/quad.c", "sha256": "b8f9f31ecf82df285061a057bf472b6e8a421a6705b26203a241ea11f16bea80" }],
      "toolchain": "wasi-sdk wasi-sdk-34.0-x86_64-windows (clang version 23.1.0-rc3 (...))",
      "command": "clang --target=wasm32 -O2 -nostdlib -fno-builtin-memset -Wall -Werror -ffile-prefix-map=<repo>=. -Wl,--no-entry -Wl,--export-dynamic -Wl,--strip-debug -Wl,--initial-memory=1048576 -Wl,--max-memory=67108864 title/src/quad.c -o title.wasm" },
    "url": "title.wasm" }
 ]
}
```

All seven: `config/title.json` 284, `meshes/quad.bin` 1,108, `meshes/track.bin`
2,064, `textures/dirt.rgba` 1,048,592 (2 chunks), `textures/grass.rgba`
4,194,320 (5 chunks), `title.wasm` 4,897 (all required), `textures/sand.rgba`
2,359,312 (group `sand`). The second title, Orbit, is `1.0.0-71c55f93118c`
under `games/orbit/`: `orbit.wasm` 989, `config/orbit.json`, `palette.bin`
(required), `sky/stars.bin` (group `sky`).

## The upload plan (`delivery-upload-plan/2`)

`out/r2-upload-plan.json`, written by `pipeline/build.mjs`, read by
`pipeline/upload-r2.mjs`: `bucket`, `publicBase`, `titles: [{ id, prefix,
version }]`, and `objects: [{ key, title, file, size, sha256, contentType,
cacheControl }]`, per title in upload order (files, manifest, `latest.json`).

## How a client reads it (`client/assets.js HttpBackend`)

1. `GET <assets>/games/<id>/latest.json` (public, max-age=30, CORS, no credentials);
   offline: the catalog stored last time;
2. same version as stored: done (no manifest request); else
   `GET .../v/<version>/manifest.json` (immutable: the HTTP cache may answer),
   SHA-256 checked against the pointer;
3. files into OPFS `delivery/<id>/blobs/<sha256>` (see 3): the required set
   at start, groups on first use, the rest in the background.
