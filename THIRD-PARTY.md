# Third-party code

This repository contains only this project's own code (MIT, see LICENSE).
`src/main.c`, `src/recomp_manual.c` and `CMakeLists.txt` started from
xboxrecomp's `templates/new-game` (MIT).

It is built against, but does not contain:

- **xboxrecomp** (https://github.com/sp00nznet/xboxrecomp): the recompiler
  and runtime. MIT, Copyright (c) 2026 sp00nz; see its `LICENSE` and
  `CONTRIBUTORS.md`.
- **xemu-derived parts of xboxrecomp** (https://github.com/xemu-project/xemu):
  the APU (`src/apu/*`) and parts of the NV2A code (`nv2a_regs.h`,
  `nv2a_core.c`, `nv2a_state.h`). LGPL-2.1-or-later; the full file list and
  copyright lines are in xboxrecomp's `NOTICE`, the licence text in its
  `LICENSES/LGPL-2.1.txt`.
- **wasi-sdk** (https://github.com/WebAssembly/wasi-sdk): the toolchain for
  the browser build. Apache-2.0 WITH LLVM-exception; it is installed
  separately, not bundled.

Not included in any form: the game's files, and anything lifted or compiled
from them. Players supply their own USA retail disc.
