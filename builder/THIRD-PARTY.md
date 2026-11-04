# What is in this package, and whose it is

The package holds source code only. No game file, nothing lifted or compiled
from the game, and no toolchain binary is in it; `verify-package.mjs` checks
that (see README).

## sources/atvrecomp (this project)

`git archive` of atvrecomp `0923f0f` (master), paths `.gitattributes`,
`LICENSE`, `README.md`, `THIRD-PARTY.md`, `CMakeLists.txt`, `config/`, `src/`
(without `src/recomp/`), `web/`.

- The game project: native and browser entry points, GPU recorder and shader
  generators, the web host page and its tools.
- `src/main.c`, `src/recomp_manual.c` and `CMakeLists.txt` started from
  xboxrecomp's `templates/new-game` (MIT, see below).
- `config/seed_functions.json`: addresses of 14 function entry points in the
  game's code, found by this project. These are facts about the program
  (numbers), not code from it.
- **MIT**, Copyright (c) 2026 the ATV QPR2 recomp contributors:
  `sources/atvrecomp/LICENSE` (also `LICENSE` at the package root, for the
  builder itself).

## sources/xboxrecomp (recompiler and runtime)

`git archive` of xboxrecomp `975ef5f` (branch `atv2-local`: upstream
https://github.com/sp00nznet/xboxrecomp plus this project's local commits),
paths `LICENSE`, `LICENSES/`, `NOTICE`, `CONTRIBUTORS.md`, `README.md`,
`include/`, `src/`, `templates/runtime/`, `tools/__init__.py` and the five
pipeline tools `tools/{xbe_parser,disasm,func_id,abi_analysis,recomp}`, without
their `test_*.py`. Left out: `tests/`, `docs/`, the other tools (among them
`tools/conformance/test.xbe` and its Docker/MSVC wrappers, and
`tests/wma_decoder/fixtures/sine.wma`), and the untracked `game_files/`.

- **MIT**, Copyright (c) 2026 sp00nz: `sources/xboxrecomp/LICENSE`.
  Contributors: `sources/xboxrecomp/CONTRIBUTORS.md`.
- **LGPL-2.1-or-later**, extracted from xemu (https://github.com/xemu-project/xemu),
  full list and copyright lines in `sources/xboxrecomp/NOTICE`, licence text in
  `sources/xboxrecomp/LICENSES/LGPL-2.1.txt`:
  - `src/apu/apu_core.c`, `apu_dsp.c`, `apu_vp.c`, `apu_regs.h`, `apu_state.h`,
    `apu_debug.h`, `fpconv.h`, `apu.h`, and `apu_shim.h` (project file under
    the same licence) - (c) 2012 espes; 2018-2019 Jannik Vogel;
    2019-2025 Matt Borgerson;
  - `src/nv2a/nv2a_regs.h`, `nv2a_core.c`, `nv2a_state.h` - (c) 2012 espes;
    2015 Jannik Vogel; 2018-2025 Matt Borgerson.
  The LGPL asks that these notices stay, that the source stays available (it
  is: the package is source) and that a user can rebuild against a modified
  copy (the builder compiles from these sources on the user's machine).
- Credited algorithms, own implementations (no licence obligation; NOTICE):
  `src/d3d/d3d8_swizzle.h` (Fabian Giesen's Morton technique, xemu cited),
  `src/d3d/d3d8_combiners.h` (xemu cited for NV2A combiner behaviour).
- No other third-party code was found in the archived paths (searched for
  copyright/licence/SPDX lines; only the files above carry them).

## Not in the package (the user installs or the builder downloads)

| Component | Licence | How it gets there |
|---|---|---|
| wasi-sdk 34 (clang/LLVM, wasi-libc) | Apache-2.0 WITH LLVM-exception (LLVM), wasi-libc: MIT/Apache-2.0/BSD-style parts | `--wasi-sdk <dir>`, or the builder downloads the official release after asking, SHA-256 checked |
| Python 3.10+ | PSF | user installs |
| capstone 5.0.7 (pip) | BSD-3-Clause | user installs (`pip install --user capstone==5.0.7`) |
| Node.js 22+ | MIT | user installs |
| Git for Windows (Git Bash) | GPL-2.0 | user installs (Windows only) |
| Edge or Chrome | proprietary / BSD | already on the machine |
| The game | (c) its rights holders | the player's own USA retail disc, extracted by the player |
