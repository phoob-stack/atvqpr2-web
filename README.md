# ATV Quad Power Racing 2: static recompilation

A port of the original Xbox game *ATV Quad Power Racing 2* (2003) to Windows
and to the web browser. The game's own x86 program is translated to C ahead of
time by [xboxrecomp](https://github.com/sp00nznet/xboxrecomp) (this project uses the fork
[phoob-stack/xboxrecomp-atv2](https://github.com/phoob-stack/xboxrecomp-atv2)) and compiled for
the target. A runtime stands in for the console's kernel, graphics chip, sound
chip and USB controllers. Nothing is interpreted instruction by instruction.

- **Windows:** a native executable with Direct3D 11. An optional WebGPU back end
  uses wgpu-native.
- **Browser:** WebAssembly with threads, plus WebGPU, in a current Edge or
  Chrome. Project site: https://atvqpr2.com

## Community

Questions, bug reports and news are on the project's Discord:
https://discord.gg/hw5rVfk4gS. Please don't share game files or anything made
from them there.

## The game is not included

This repository contains only this project's own code. It contains no game
files, no recompiled game code and no game assets. To play, you need your own
legally owned copy of the **USA retail disc** of ATV Quad Power Racing 2.
Everything made from the disc is produced on your own computer and must not be
shared. That covers the extracted files, the lifted C in `src/recomp/gen`, the
compiled `atv2.wasm`, shader caches and saves.

## How a build is made

1. Copy the files of your own disc to a folder (`default.xbe`, `ATV.bah`,
   `ATV.bad`, ...). The tools check that `default.xbe` is the USA retail
   version (size and SHA-256).
2. Lift the game. xboxrecomp's pipeline disassembles `default.xbe` and writes C
   into `src/recomp/gen`. This repository's `config/seed_functions.json` gives
   it extra function entry points.
3. Compile:
   - **Browser:** `bash web/wasm/build.sh` with wasi-sdk 34
     (`wasm32-wasip1-threads`). It writes `build-wasm/atv2.wasm`, and the
     build is reproducible.
   - **Windows:** CMake + Ninja with Visual Studio 2022 (MSVC, x64):
     `cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DXBOXRECOMP_DIR=<path to xboxrecomp-atv2>`, then
     `cmake --build build`.

The **builder** (`builder/`) does steps 1 to 3 and starts the local server: one
command (`build-atv2.cmd`, or `node builder.mjs`), about 2 minutes on a fast PC.
Its `make-package.mjs` vendors this repository and the xboxrecomp fork into
`sources/` (not committed). It needs:

| Tool | Version |
|---|---|
| Node.js | 22 or newer |
| Python | 3.10 or newer, with `capstone` 5.0.x (`pip install capstone`) |
| Git for Windows | for Git Bash, which `build.sh` runs under |
| wasi-sdk | 34.0 |

## Running

- **Browser, from your PC:** `node web/host/serve.mjs` serves the game page on
  `http://127.0.0.1:8460`. The page asks once for your game folder and keeps a
  copy in the browser's own storage (OPFS). Nothing is uploaded.
- **Browser, on the project site:** https://atvqpr2.com → *Select local game
  files* → pick the `atv2-play` folder the builder made. The site serves only
  this project's page code. Your game build and files come from your disk and
  stay in your browser.
- **Windows:** run `atv2_recomp.exe` from the build folder, with the game files
  in `game/atv2`.

Controls work with a keyboard or an Xbox/XInput gamepad, and keys can be
rebound in the page's settings. Saves stay in the browser and can be exported
as a zip that the Windows build also reads.

## Online free roam

Free Ride (Freestyle, Stadium, unlimited time) can be shared with other players
through a small WebSocket hub, `web/tools/roamhub.mjs`.
- Each game drives its own quad and sends its pose about 30 times a second.
- Other riders appear in spare rider slots, smoothed, as ghosts by default.
- The hub only carries player names, rider choices and poses, never anything
  from the game.

Hosting notes are in `web/tools/ROAMHUB-HOSTING.md`.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | Native and browser entry points, GPU recorder and shader generators (`src/gpu`), Free Ride and free roam, control channel |
| `src/recomp/gen/` | *Not in the repository.* The lifted game code, made on your machine |
| `web/host/` | The browser game page: loader, OPFS storage, threads, audio, input, settings and saves |
| `web/gpu/` | The WebGPU frame encoder |
| `web/wasm/` | The wasm build script and the prebuilt-runtime packaging |
| `web/tools/` | Test and measurement tools (Edge via CDP), the free-roam hub |
| `config/` | Function seeds for the lifter |
| `builder/` | The bring-your-own-disc builder: checks `default.xbe`, lifts, compiles `atv2.wasm`, writes the play folder |
| `site/` | The project website (https://atvqpr2.com): Play panel, Configs, Stats, Setup; `site/play/` is a copy of `web/host` made by `site/tools/sync-play.mjs` |
| `delivery/` | Asset streaming: manifest, asset server, browser asset manager (server/CDN and local-files sources, OPFS cache), the test title, deploy pipeline |
| `deploy/pterodactyl/` | Pterodactyl egg and steps for hosting the free-roam hub |

## Licence

- This project's code is under the MIT licence, see [LICENSE](LICENSE).
- It builds against xboxrecomp (MIT). xboxrecomp's audio and parts of its NV2A
  code come from xemu and are LGPL-2.1-or-later.
- The browser build uses wasi-sdk (Apache-2.0 WITH LLVM-exception).

Details are in [THIRD-PARTY.md](THIRD-PARTY.md).

## Trademarks

This is an unofficial fan project, not affiliated with or endorsed by the
publishers or developers of ATV Quad Power Racing 2. *ATV Quad Power Racing 2*
and *Xbox* are trademarks of their respective owners.

## Contributing

Issues and pull requests are welcome. Please:

- never attach game files, recompiled output, `atv2.wasm`, captures or
  screenshots taken from the game to issues or pull requests;
- keep changes to the game's behaviour behind an environment switch, off by
  default, as the existing `RECOMP_*` options are;
- say how you tested a change: native and/or browser, and which race or menu.
