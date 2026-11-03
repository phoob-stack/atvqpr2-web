#!/usr/bin/env bash
# First wasm32-wasip1-threads build of the game (nfsu2-web's flags, see
# notes/nfsu2-web.md). Not a playable build yet: it compiles every generated
# shard, the portable runtime and the GPU recorder, then does a trial link and
# lists what is still undefined -- the porting work list.
#
#   web/wasm/build.sh [wasi-sdk dir]      (bash; outputs in build-wasm/)
#
# Also builds web/tools/wgsl_fuzz.c for wasm32-wasip1 and checks under Node's
# WASI that it writes the same WGSL as the native build (web/wasm/run-wasi.mjs).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
GAME=$(cd "$HERE/../.." && pwd)
RT=$(cd "$GAME/../xboxrecomp" && pwd)
SDK=${1:-$(cd "$GAME/../../../third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows" 2>/dev/null && pwd)}
CC="$SDK/bin/clang"
OUT="$GAME/build-wasm"
GEN="$GAME/src/recomp/gen"
mkdir -p "$OUT/gen" "$OUT/rt" "$OUT/fuzz"

CFLAGS="--target=wasm32-wasip1-threads -pthread -msimd128 -mbulk-memory -mnontrapping-fptoint -mtail-call
  -O2 -fno-delete-null-pointer-checks -mllvm -wasm-enable-sjlj
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -Wno-everything"
# Link configuration (memory, threads, exports): web/wasm/link-flags.sh.
# The guest span ends below 0x84100000 (wasm-mem, WASM-MEM.md); runtime data,
# the main C stack and the heap start there.
WASM_GLOBAL_BASE=${WASM_GLOBAL_BASE:-0x84100000}
WASM_INITIAL_MEMORY=${WASM_INITIAL_MEMORY:-$(( 0x84100000 + (128 << 20) ))}
. "$HERE/link-flags.sh"

INC="-I$GEN -I$RT/include -I$RT/src -I$RT/src/kernel -I$RT/src/d3d -I$RT/src/platform -I$RT/src/usb
  -I$RT/src/nv2a -I$RT/src/apu -I$RT/src/audio -I$RT/src/video -I$RT/src/input -I$GAME/src -I$GAME/src/gpu"

compile() {  # dir src -> prints OK/FAIL line
  local o="$1/$(basename "$2" .c).o" e="$1/$(basename "$2" .c).err"
  if $CC $CFLAGS $INC -c "$2" -o "$o" 2>"$e"; then echo "OK   $(basename "$2")"
  else rm -f "$o"; echo "FAIL $(basename "$2"): $(grep -m1 'error:' "$e" | sed 's/.*error: //' | cut -c1-100)"; fi
}

echo "== generated shards"
# Stores go through MEMn_ST(addr, value) on wasm, where a device register is an
# explicit check rather than a page fault (recomp_types.h, xboxrecomp
# tools/recomp/store_form.py). The rewrite goes to build-wasm/gen-src; files
# whose output is unchanged keep their timestamp. Headers still come from $GEN.
if command -v py >/dev/null 2>&1; then PY="py -3"; else PY=python3; fi
(cd "$RT" && $PY -m tools.recomp.store_form "$GEN" "$OUT/gen-src") || exit 1
n=0; for f in "$OUT"/gen-src/*.c; do compile "$OUT/gen" "$f" & n=$((n+1)); [ $((n % 8)) = 0 ] && wait; done; wait
echo "== runtime and game sources"
# Skipped on purpose: the D3D8->D3D11 HLE (d3d8_*), SDL and Win32-only input/video
# back ends, and the D3D11 GPU consumer -- the web build replaces them.
for f in "$RT"/src/{apu,audio,kernel,nv2a,platform,usb,video,input}/*.c "$GAME"/src/*.c \
         "$GAME"/src/control/*.c "$GAME"/src/wasm/*.c "$GAME"/src/gpu/gpu_rec.c "$GAME"/src/gpu/gpu_shadergen*.c \
         "$GAME"/src/gpu/gpu_wgsl_tap.c; do
  case "$(basename "$f")" in *sdl*|d3d8_*|mkb_input.c|xinput_device.c) continue;; esac
  compile "$OUT/rt" "$f"
done
echo "== trial link (everything kept, so every missing symbol shows)"
$CC --target=wasm32-wasip1-threads -pthread "$OUT"/gen/*.o "$OUT"/rt/*.o -o "$OUT/game.wasm" \
  -Wl,--no-entry -Wl,--export-all -Wl,--no-gc-sections -Wl,--error-limit=0 \
  $WASM_LDFLAGS 2> "$OUT/link.err"
wasm_memory_json "$OUT/game.memory.json"
grep "undefined symbol: " "$OUT/link.err" | sed 's/.*undefined symbol: //' | sort -u > "$OUT/undefined.txt"
echo "$(wc -l < "$OUT/undefined.txt") undefined symbols (build-wasm/undefined.txt):"
tr '\n' ' ' < "$OUT/undefined.txt"; echo
[ -f "$OUT/game.wasm" ] && ls -la "$OUT/game.wasm"

echo "== WGSL generator in wasm vs native"
$CC --target=wasm32-wasip1 -O2 -Wno-everything -I"$GAME/src/gpu" "$GAME/web/tools/wgsl_fuzz.c" \
  "$GAME/src/gpu/gpu_shadergen_wgsl.c" "$GAME/src/gpu/gpu_shadergen.c" -o "$OUT/fuzz/wgsl_fuzz.wasm" &&
  node "$HERE/run-wasi.mjs" "$OUT/fuzz/wgsl_fuzz.wasm" "$OUT/fuzz/out" 200
