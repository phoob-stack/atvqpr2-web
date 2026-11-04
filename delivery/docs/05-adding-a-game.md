# 5. Adding an independently developed browser game

A game is a profile and its build. No loader, launcher, pipeline or site code
changes. Orbit (`titles/orbit`) was added this way; its whole diff is:

```
profiles/orbit.json          the profile
titles/orbit/build.mjs       its build (exports buildTitle(outDir))
titles/orbit/src/orbit.c     its C
web/app/orbit.js             its page code (start({ assets, module, canvas, hud }))
```

(and the test steps that exercise it in `test/r2-e2e.mjs`). `client/`,
`pipeline/`, `server/`, `site/test-title/runner.js` and the site's sync tool
did not change for it.

## 1. The profile (`profiles/<id>.json`)

```json
{
 "format": "game-profile/1",
 "id": "orbit",
 "title": "Orbit (second delivery test title)",
 "derivedFromRetail": false,
 "sources": ["remote"],
 "remote": { "prefix": "games/orbit/" },
 "entry": "orbit.wasm",
 "app": "orbit",
 "titleVersion": "1.0.0",
 "required": ["orbit.wasm", "config/orbit.json", "palette.bin"],
 "groups": { "sky": ["sky/stars.bin"] },
 "build": { "dir": "titles/orbit" }
}
```

- `id`: `[a-z0-9-]`, also the OPFS namespace and the file name; never an
  ATV 2 name (`atv*`, `atvqpr*`, `quad-power*` are refused).
- `remote.prefix` must be `games/<id>/`.
- `derivedFromRetail: true` makes `remote` impossible: only our own titles
  are served.
- `required` are fetched before the start, `groups` on first use, the rest in
  the background. `mounts` (optional) map catalog prefixes into a runtime's
  file system (ATV 2: `game/` -> `/game`).
- Bump `titleVersion` for a release; the 12-hex part of the version follows
  the content anyway.

## 2. The build (`<build.dir>/build.mjs`)

`export function buildTitle(outDir, { wasiSdk, variant })` writes every file
of the title into `outDir` and returns `{ files, artifacts: { '<x>.wasm':
{ size, sha256, source: [{ path, sha256 }], toolchain, command } } }`. Every
wasm must have an artifact record (sources of this repository with their
hashes); the gate refuses any other wasm. Builds must be deterministic (same
inputs, same bytes): seeded generators, `-ffile-prefix-map`, no clocks.

## 3. The page code (`web/app/<app>.js`)

`export async function start({ assets, module, canvas, hud })` -> `{ state(),
stop() }`; optional `export const help`. Read files with
`assets.json/arrayBuffer/get(path)` and groups with
`assets.loadGroup(name)`. The site picks it up with
`node tools/sync-delivery.mjs` (profiles and app modules by pattern) and
lists it in `test-title/profiles/index.json`; it runs at
`test-title/?game=<id>`.

## 4. The pipeline and the gate

`node pipeline/build.mjs` builds every remote profile, writes
`out/r2/games/<id>/...` and one upload plan, then runs the gate. Expect it to
fail the build (and leave `out/` untouched) for: any file named or shaped like
game content (`.xbe .iso .bah .bad .xpr .wav`, XBE/disc-image/RIFF headers,
`recomp_*.c`, lifter banners, more than 20 `sub_XXXXXXXX` names, generated
WGSL), a wasm without an artifact record or named `atv2*.wasm`, the game's
build or storage paths (`build-wasm`, `atv2-play`, `atv2-game`, ...), files
over 5 MB, an inputs folder inside the game's trees, a profile derived from
retail content with a remote source, and an ATV 2 id or prefix.

## 5. Test it

`node --test test/*.test.mjs`, then `node test/r2-e2e.mjs --site ../site`
(first load, relaunch with 0 downloads, offline, resume, corruption, the
groups) with a step for the new title, as `orbit` there.
