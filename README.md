# ATV Quad Power Racing 2: static recompilation

A PC (Windows, D3D11) and browser (WebAssembly + WebGPU) port of the original
Xbox game ATV Quad Power Racing 2, made by statically recompiling the game's
own program with [xboxrecomp](https://github.com/sp00nznet/xboxrecomp).

**The game is not included.** This repository holds only this project's own
code: entry points, GPU recorder and shader generators, the web host page and
tools. You must supply the files from your own legally owned USA retail disc.
Everything made from those files (the lifted C in `src/recomp/gen`, builds,
`atv2.wasm`, shader caches, pipeline lists) is produced on your own machine,
is not covered by the licence below, and must not be shared.

## Licence

This project's own code is under the MIT licence, see [LICENSE](LICENSE).
It builds against xboxrecomp (MIT) and its xemu-derived parts (LGPL-2.1+);
see [THIRD-PARTY.md](THIRD-PARTY.md).

ATV Quad Power Racing 2 and its trademarks belong to their owners. This is an
unofficial fan project.
