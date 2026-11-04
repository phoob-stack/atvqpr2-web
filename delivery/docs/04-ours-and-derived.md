# 4. What is ours, and what is derived from the retail game

Facts only. Which of these may be distributed, and how, is the owner's
decision; nothing here describes a release of anything in the second table.

## Ours (written in this project, independent of the game's files)

| Part | Where | Notes |
|---|---|---|
| The runtime (kernel, NV2A/GPU recorder, APU, USB, threads, paths) | xboxrecomp `src/` (MIT, xemu-derived parts LGPL-2.1+), atvrecomp `src/` except `src/recomp/gen` | the Xbox-side runtime the generated code runs on |
| The prebuilt engine kit | `rt.a` + flags from `web/wasm/package-runtime.sh` / `kit-build.mjs` | our runtime compiled for wasm32, without any generated game code |
| The browser host and renderer | atvrecomp `web/host/*.js` (page, workers, WASI, VFS, saves, input, audio, roam, asset source), `web/gpu/*.js` (the WebGPU encoder) | the site's `play/host` is a copy |
| The JS loader and delivery client | delivery `client/*.js` (asset manager, worker, SHA-256, launcher, profiles) | copied into the game page and the site |
| The site | `site/` | page code, styles, docs; no game data (its scan enforces it) |
| The free-roam hub | atvrecomp `web/tools/roamhub.mjs`, delivery `hub/` | protocol and server code only |
| The builder | `builder/` | tooling that builds on the player's PC from their own disc |
| The test titles | delivery `title/` (Box Quad), `titles/orbit/` (Orbit), `web/app/*.js` | our C, our procedural assets |
| Profiles and pipeline | delivery `profiles/`, `pipeline/`, `server/`, `deploy/`; atvrecomp `web/host/profiles/atv2.json` | data and tooling (the ATV 2 profile holds hashes, sizes and messages, no game bytes) |

## Derived from `default.xbe` or the disc

| Item | Made from | Where it exists |
|---|---|---|
| Generated C (`src/recomp/gen`, `recomp_*.c`, `recomp_funcs.h`) | `default.xbe`'s code, lifted by xboxrecomp | the developer's tree; the builder's work folder on the player's PC |
| `atv2.wasm` | the generated C + our runtime | `build-wasm/` (developers), the player's play folder, the player's browser storage (`delivery/atv2/blobs/`) |
| `pipelines.json` and the generated WGSL in it | the game's shaders, translated by our GPU code during a run | `build-wasm/` (developer page only) |
| The native shader cache (`shadercache/`) | the game's shaders, compiled by the native D3D11 renderer | the working directory of a native run |
| The disc files (`default.xbe`, `ATV.bah`, `ATV.bad`, `ATV.exe`, `user.xml`, `Fonts/`, `Licensed/`, `Movies/`, `Music/`, `Sound/`) | the retail disc | the player's disc copy, play folder and browser storage |
| Saves | the game, while it runs | the player's browser (`atv2-saves/`) or save folder |

Enforcement (already in place): the site scan (`builder/verify-package.mjs
--site`), the delivery gate (`pipeline/verify-package.mjs --delivery`,
`--assets`, `--r2`: rules 1-18, including the known SHA-256s of the
reference `atv2.wasm` and the retail `default.xbe`, lifter markers, generated
WGSL, ATV 2 storage paths, and never an ATV 2 prefix in the bucket), the
profile rule (a retail-derived profile has no remote source), and
`upload-r2.mjs`, which refuses an ATV 2 title before anything else.
