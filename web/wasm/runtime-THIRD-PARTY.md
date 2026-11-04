# What is in this kit, and whose it is

Kit `@KIT@`, built by `web/wasm/package-runtime.sh` from
atvrecomp `@ATV@` and xboxrecomp `@XR@` with wasi-sdk @SDK@
(@CLANG@). `manifest.json` lists every file with its SHA-256.

The kit holds the browser runtime of the ATV Quad Power Racing 2 port as
object code, plus the headers and libraries needed to compile the game's
generated C and link it against that runtime. **It contains nothing taken or
generated from the game**: no lifted code, no generated header, no game data.
`web/wasm/verify-runtime.mjs` checks that. The player lifts the generated C
from their own disc.

## lib/rt.a: this project's runtime

Compiled from the two source trees named above (`runtime_sources` in
`web/wasm/runtime-flags.sh` lists every file); each object is named after its
source file.

- **atvrecomp** (this project): `src/web/*`, `src/wasm/*`,
  `src/gpu/gpu_rec.c`, `src/gpu/gpu_shadergen*.c`, `src/gpu/gpu_wgsl_tap.c`,
  `src/recomp_manual.c`, `src/freeride.c`, `src/roam.c`, `src/roam_net.c`.
  **MIT**, Copyright (c) 2026 the ATV QPR2 recomp contributors: `LICENSE`.
- **xboxrecomp** (https://github.com/sp00nznet/xboxrecomp, branch `atv2-local`):
  `src/{apu,audio,kernel,nv2a,platform,usb,video,input}/*.c` (without the
  D3D8, SDL and Win32-only files). **MIT**, Copyright (c) 2026 sp00nz:
  `licenses/xboxrecomp-LICENSE`; contributors in xboxrecomp's
  `CONTRIBUTORS.md`.
- **xemu-derived parts of xboxrecomp** (https://github.com/xemu-project/xemu):
  the objects `apu_core.o`, `apu_dsp.o`, `apu_vp.o` and `nv2a_core.o`, and
  the headers compiled into them (`apu_regs.h`, `apu_state.h`, `apu_debug.h`,
  `fpconv.h`, `apu.h`, `apu_shim.h`, `nv2a_regs.h`, `nv2a_state.h`).
  **LGPL-2.1-or-later**; files and copyright lines in
  `licenses/xboxrecomp-NOTICE`, licence text in `licenses/LGPL-2.1.txt`.
  - The complete source of these objects is xboxrecomp at the commit named
    above.
  - The kit exists to be relinked: the game module is the player's own
    objects linked against `rt.a` with the arguments in `flags.json`, so a
    modified runtime can always be linked in its place (LGPL-2.1 section 6).

## include/: the generated C's interface with the runtime

- `recomp_types.h`: xboxrecomp `templates/runtime/recomp_types.h` (MIT,
  as above), the header tools/recomp copies next to the generated C.
- `wasm_compat.h`: atvrecomp `src/web/wasm_compat.h` (MIT, as above).

## sysroot/ and clang/: from wasi-sdk @SDK@ (https://github.com/WebAssembly/wasi-sdk)

Unmodified copies, at their wasi-sdk paths, of only what the generated C and
the link need: the C headers the generated files include (and the headers
those include), and `crt1-command.o`, `libc.a`, `libpthread.a`,
`libsetjmp.a`, `libwasi-emulated-{getpid,mman,process-clocks,signal}.a` and
`libclang_rt.builtins.a`.

| Part | Upstream | Licence |
|---|---|---|
| `sysroot/` headers and libraries | wasi-libc (https://github.com/WebAssembly/wasi-libc), built into wasi-sdk @SDK@ | wasi-libc's own code: Apache-2.0 WITH LLVM-exception, Apache-2.0, or MIT, at your option. It contains musl libc (MIT), parts of cloudlibc (BSD-2-Clause), dlmalloc (public domain / CC0) and code from FreeBSD (BSD-2-Clause) |
| `clang/include/` (stddef.h, stdint.h, ...) and `clang/lib/.../libclang_rt.builtins.a` | LLVM clang and compiler-rt (https://github.com/llvm/llvm-project), as in wasi-sdk @SDK@ | Apache-2.0 WITH LLVM-exception |

Licence texts: `licenses/Apache-2.0.txt`, `licenses/LLVM-exception.txt`,
`licenses/MIT.txt`, `licenses/BSD-2-Clause.txt` (the standard SPDX texts).
The LLVM exception covers object code from these parts that ends up in a
program: the game module needs no notice for it. Redistributing the files
themselves, as this kit does, needs the notices.

**Before this kit is published:** wasi-sdk's Windows release carries no
licence files, and this kit was made without downloading anything. Add the
upstream notice files verbatim: wasi-libc's `LICENSE-MIT`,
`LICENSE-APACHE` and `LICENSE-APACHE-LLVM`, musl's `COPYRIGHT` (its list of
contributors), and llvm-project's `compiler-rt/LICENSE.TXT` and
`clang/LICENSE.TXT`, all at the commits wasi-sdk @SDK@ was built from
(wasi-libc and llvm commits in the SDK's `VERSION` file).

## Not in the kit

- The game, and anything lifted, compiled or extracted from it: the player
  supplies their own USA retail disc and lifts and compiles the generated C
  on their own machine.
- clang and wasm-ld themselves.
