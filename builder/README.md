# ATV: Quad Power Racing 2 in the browser - build it from your own disc

This package turns **your own copy** of *ATV: Quad Power Racing 2* (USA retail,
Xbox) into a browser game on your own PC. It contains only this project's
source code. Everything made from the game - the lifted C, the compiled
`atv2.wasm`, caches - is produced on your machine, in a work folder and a
play folder outside this package, and never leaves it (the project site reads
the play folder inside your browser; nothing is uploaded).

**The game is not included.** You must supply the files from your own legally
owned USA retail disc. This package's own code is MIT (`LICENSE`); the bundled
recompiler is MIT and its xemu-derived parts LGPL-2.1+ (`THIRD-PARTY.md`).

What it does, in order:

1. checks the tools listed below are installed;
2. checks your game folder: `default.xbe` must be the USA retail one (size
   1,904,640 bytes and SHA-256 `1e3c2fce...3bd22f`), and `ATV.bah` and
   `ATV.bad` must be there;
3. copies its sources into the work folder;
4. lifts the game's code to C with xboxrecomp (`xbe_parser`, `disasm`,
   `func_id`, `abi_analysis`, `recomp`);
5. compiles it with wasi-sdk 34 into `atv2.wasm`. The build is reproducible
   (the work folder's path is mapped out with `-ffile-prefix-map`), so every
   player's `atv2.wasm` is byte-identical to the reference build in
   `config/build-expected.json`, and the builder says whether it is;
6. writes your **play folder**, `atv2-play` (see below): your game files,
   `atv2.wasm` and `atv2-build.json`, the one folder to pick on the project
   site;
7. starts a local web server on `http://127.0.0.1:8460` (this PC only) and
   opens Edge on it.

The next run skips every stage whose inputs did not change and goes straight
to steps 6 and 7.

## Two ways to play

- **On the project site.** Open the site, Play, **Select local game files**,
  and choose the play folder. The site sends only its own page code; the page
  checks `default.xbe` (USA retail) and that `atv2.wasm` is exactly the build
  the site's page was made for (size and SHA-256 of this builder version's
  reference build), copies both into the browser's own storage once, and runs
  the game from there. Later visits start without a pick. The site's page and
  the module must come from the same builder version (they share the host
  ABI): when the site moves to a newer builder, it says which version to run,
  and you run it once and pick the folder again.
- **On this computer.** The builder's own server (`http://127.0.0.1:8460`),
  as before; nothing goes through the site.

### The play folder

Default `%LOCALAPPDATA%\atv2-builder\atv2-play` (next to the work folder;
`~/.local/share/atv2-builder/atv2-play` on Linux, `~/Library/Application
Support/atv2-builder/atv2-play` on macOS), or `--play-dir <dir>`. The builder
prints its path; paste it into the folder window's address bar on the site.

| | |
|---|---|
| your game files | **hard links** to the files in your game folder when the play folder is on the same drive (no extra space), else copies. Your game folder is only ever read: a changed file is deleted and linked again, never written through. Save folders (`UDATA`, `TDATA`, `CACHE`, `TitleCache`) and system files are left out. |
| `atv2.wasm` | a copy of the build in the work folder |
| `atv2-build.json` | builder version, the atvrecomp/xboxrecomp commits, wasi-sdk version, size and SHA-256 of `atv2.wasm` (and whether it is the reference build), size and SHA-256 of `default.xbe`, file count |
| `atv2-play.txt` | what the folder is for |

It is remade on every run (files the game folder no longer has are removed).
The builder refuses to write into a folder that has other files and no
`atv2-build.json`, and the play, work and game folders must all be separate.
It is made from your game: don't share it.

## You need

Versions are the ones this was built and tested with (Windows 11, 2026-11-03).

| What | Version tested | Notes |
|---|---|---|
| Your game | USA retail disc, extracted | the folder with `default.xbe`, `ATV.bah`, `ATV.bad` (42 files, ~725 MB). Extract the disc yourself; the builder does not read ISO images. Other regions/versions are refused. |
| Node.js | 24.13.1 (22 LTS or newer) | runs the builder and the local server. https://nodejs.org |
| Python | 3.10.6 (3.10 or newer) | runs the lifter. On Windows install the `py` launcher too. |
| capstone (pip) | 5.0.7 | the only package the lifter imports outside the standard library: `py -3 -m pip install --user capstone==5.0.7` |
| bash | Git Bash 5.2.15 (Git for Windows 2.42) | runs `web/wasm/build.sh`. On Windows this must be **Git Bash**: the `bash.exe` in System32 is WSL and will not work. The builder finds Git Bash itself, or pass `--bash`. |
| wasi-sdk | 34.0 (`wasi-sdk-34.0-x86_64-windows`, clang 23.1.0-rc3) | the C-to-wasm compiler. Pass `--wasi-sdk <dir>` if you have it; otherwise the builder offers to download the official release from github.com/WebAssembly/wasi-sdk (590 MB, SHA-256 checked) into its toolchains folder. |
| Browser | Microsoft Edge 156.0.4314.58 (any current Edge or Chrome) | needs WebGPU. Firefox/Safari are not tested. |

Nothing is installed by the builder except wasi-sdk, and only after it asks
(or with `--yes`). It uses no npm packages.

Disk space (measured):

| | |
|---|---|
| this package | 5.3 MB (322 files) |
| work folder after a build | 217 MB (lifted C 38 MB, build 102 MB, pipeline databases 72 MB); allow 1 GB |
| wasi-sdk 34, unpacked | 1.56 GB (17,216 files); 2.2 GB at the peak of a download (archive + unpacked) |

Time: about 2 minutes for a first build on a Ryzen 9 9950X3D (16 cores), most
of it the disassembler and the C compile (stage times below). A slower PC can
take a few times longer. Later runs start in a few seconds.

## Use it

Windows: double-click `build-atv2.cmd` and choose your game folder, or

```
build-atv2.cmd "D:\Games\ATV QPR2"
```

Any OS with the tools above:

```
node builder.mjs "/path/to/ATV QPR2"
```

Then play in the browser window that opens. Click the page (or press a key)
once to start the sound. Keys: Enter = START, Z = A, X = B, arrows = d-pad;
or plug in a gamepad. Press Ctrl+C in the builder window to stop the server.

Options (`--help` lists them all):

| | |
|---|---|
| `--work <dir>` | work folder (default `%LOCALAPPDATA%\atv2-builder\work`; `~/.local/share/atv2-builder/work` on Linux, `~/Library/Application Support/atv2-builder/work` on macOS) |
| `--wasi-sdk <dir>` | use an installed wasi-sdk 34 (`WASI_SDK_PATH` works too) |
| `--toolchains <dir>` | where a downloaded wasi-sdk goes (default `<data dir>/toolchains`) |
| `--wasi-sdk-mirror <url>` | download wasi-sdk from this base URL (http, https or file) instead of GitHub; the SHA-256 is still checked |
| `--yes` | download wasi-sdk without asking |
| `--port <n>` | server port (default 8460) |
| `--import` | serve without your game folder: the page asks for it once and keeps a copy in the browser's own storage |
| `--play-dir <dir>` | where the play folder goes (default `<data dir>/atv2-play`) |
| `--no-play-dir` | don't write the play folder |
| `--no-serve`, `--no-open` | build only / don't open the browser |
| `--rebuild` | redo every stage |
| `--verify-only` | only check the tools and the game folder |
| `--python <cmd>`, `--bash <path>` | choose the interpreter / bash |

The work folder holds `tree/` (sources, generated C in
`tree/atvrecomp/src/recomp/gen`, the build in `tree/atvrecomp/build-wasm`),
`lift/` (the pipeline's databases and a copy of `default.xbe`), `logs/` (one
log per step), `timings.json` and `state.json`. Delete it to start over. It is
yours: it is made from your game, so don't share it. The play folder is
separate (above).

## Stage times (clean build, this PC)

Measured 2026-11-04 from a clean unpack of the 0.3.0 package, Windows 11, Ryzen 9
9950X3D (16 cores / 32 threads), Python 3.10.6, wasi-sdk 34 given with
`--wasi-sdk`. Other test jobs were running on the PC at the same time, so
these are upper bounds.

| Stage | Time |
|---|---|
| 1. tools | 0.4 s |
| 2. game files (SHA-256 of default.xbe) | 0.0 s |
| 3. sources | 0.6 s |
| 4a. lift: xbe_parser | 0.2 s |
| 4b. lift: disasm | 38.5 s |
| 4c. lift: func_id | 1.1 s |
| 4d. lift: abi_analysis | 0.9 s |
| 4e. lift: recomp | 23.5 s |
| 5. compile (103 files, link, strip, WGSL check) | 59.9 s |
| 6. play folder (hard links) | 0.1 s |
| **total** | **2 min 05 s** |
| second run (everything up to date) | 0.8 s, then the server |
| wasi-sdk download, if needed (not timed over the internet; from a local mirror: copy + SHA-256 + unpack) | 61 s + download time |

The result: 36 lifted C files, 8,952 functions (8,953 dispatch entries), all
40 generated files byte-identical to the project's own reference lift, and an
`atv2.wasm` of 21.1 MB that ran a Dunes: Lagoon race in headless Edge at
60.4 fps average (web/tools/race.mjs).

Builder 0.2.0 (reproducible builds, play folder), 2026-11-03, same PC: a
clean build took 9 min 42 s (disasm 6 min 52 s, compile 1 min 41 s, with
other jobs running); the same lift compiled again in a second work folder at
another path gave the same `atv2.wasm`, 22,080,481 bytes, SHA-256
`a211cd18...c75ed4181e`. Writing the play folder (42 game files as hard links
+ the module) took 0.1 s. From that folder the project site's page (served
locally with its `_headers`) imported the files into Edge's storage in about
20 s and ran a Dunes: Lagoon race at 60.6 fps average (min 60) at 2x
resolution with 4x MSAA.

## Checks for maintainers

- `node verify-package.mjs [folder]` fails if a folder contains game or disc
  files (`.xbe .iso .bah .bad .xpr .wav`, and `.xmv .wma .xiso ...`),
  compiled files (`.wasm .obj .lib .exe .dll .o .a .pdb`), any file over 5 MB,
  anything under `src/recomp/gen` or named like lifter output, or files whose
  content is lifted C (the lifter's banners and per-function header comments,
  or more than 20 lifted function definitions). It also looks at magic numbers
  (XBE, Xbox disc image, wasm, RIFF/WAVE) whatever the file is called. Run it
  on the package before it goes anywhere.
- `node verify-package.mjs --site <folder> [--list]` is the deploy scan for
  the project site: the rules above plus no images, audio, video, fonts or
  archives (a game screen, texture or sound cannot slip in under another
  name; our own art would be passed with `--allow-media <path>` after a look),
  no file over 1 MB, no generated WGSL (the shader generator's uniform blocks,
  or more than 4 entry points in one file), no large base64 blobs, no save
  files, and every file under `play/` exactly as the site's
  `tools/sync-play.mjs` wrote it (`play/sync.json`: path, size, SHA-256).
  `--list` prints every file it looked at.
- `config/build-expected.json`: size and SHA-256 of the `atv2.wasm` this
  builder version makes (the reference build). Only these numbers, never the
  file. The builder compares each build with it; the project site's
  `tools/sync-play.mjs` copies them into its game page, which accepts exactly
  that build. After a re-pin (new commits or version in `PINNED.json`), build
  once from a clean work folder, build again in a second work folder with
  another path, check both give the same SHA-256, and record it here; the
  site's sync refuses a `build-expected.json` that does not match
  `PINNED.json`.
- `node make-package.mjs` refreshes `sources/` from the two repositories at the
  commits in `PINNED.json` with `git archive` and an allow-list of paths, then
  runs `verify-package`.
- `node --test test/*.test.mjs` (set `ATV2_TEST_TMP` to a scratch folder):
  verify-package and game-folder checks, and the wasi-sdk download code against
  a 127.0.0.1 mirror and a `file://` mirror (SHA-256 and size mismatch,
  redirects, 404, refusal without a pinned hash, declined download).
  `ATV2_TEST_REAL_ARCHIVE=<wasi-sdk-34.0-x86_64-windows.tar.gz>` also runs the
  real archive through download, hash, unpack and `clang --version`.
- Pinned SHA-256 of the wasi-sdk archives: `lib/wasi-sdk.mjs`. Only the
  Windows x64 one is filled in (computed from the official archive downloaded
  for this project); the others are TODO and the builder will not download
  them until they are filled in from the release notes.

## Without bash?

`web/wasm/build.sh` is the only part that needs bash. It is a short script:
run the xboxrecomp store-form rewrite (`py -3 -m tools.recomp.store_form`),
compile the 36 generated files and ~60 runtime/game sources with the same
clang flags (8 at a time), put the runtime objects in an archive with
`llvm-ar`, link with the flags in `web/wasm/link-flags.sh`, write
`atv2.memory.json`, strip debug info, and build/check the WGSL generator. A
Node port of those steps (spawning `clang.exe` directly) is about 150 lines and
would drop the Git Bash requirement on Windows. It has not been done here
because it would duplicate atvrecomp's own build script; the right place for
it is atvrecomp (`web/wasm/build.mjs`, with build.sh kept or made a wrapper).

## Not done yet

- **Pre-built WebGPU pipelines** (`build-wasm/pipelines.json`, newer
  atvrecomp only). The page can pre-create the game's WebGPU pipelines from
  this list at boot; without it there is a one-time pause of about 90 ms on a
  fresh browser profile. The list holds WGSL generated from the game's
  shaders, so it must be made on the player's machine, and making it means
  playing the game in the browser (`web/tools/mp.mjs --save-pipes`). The
  builder does not do that yet; `verify-package` rejects the file (by name
  and by content).

## What is in here

- `builder.mjs`, `lib/`, `config/game-usa.json`: the builder. The game check
  holds only the size and SHA-256 of `default.xbe`. `lib/play.mjs` writes the
  play folder.
- `config/build-expected.json`: the reference build's size and SHA-256.
- `build-atv2.cmd`: Windows launcher.
- `sources/atvrecomp`: this project (atvrecomp `0923f0f`), without
  `src/recomp/`.
- `sources/xboxrecomp`: the recompiler and runtime (xboxrecomp `975ef5f`,
  branch atv2-local), only what the build uses.
- `verify-package.mjs`, `make-package.mjs`, `test/`, `PINNED.json`.
- Licences and credits: `THIRD-PARTY.md`.
