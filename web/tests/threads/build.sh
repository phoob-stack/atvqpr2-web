#!/usr/bin/env bash
# Builds threads_test.wasm: the runtime's own thread/sync layer (win32_compat.c,
# host_time.c, kernel_guest_cpu.c, kernel_hal.c) for wasm32-wasip1-threads,
# with the game's link flags (web/wasm/link-flags.sh). Run it with
#   node web/tests/threads/run.mjs          (Node worker_threads)
#   node web/tests/threads/run-edge.mjs     (headless Edge, Web Workers)
# and, with the same runtime objects, xboxrecomp's own tests/guest_cpu.
#
#   web/tests/threads/build.sh [wasi-sdk dir]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
GAME=$(cd "$HERE/../../.." && pwd)
RT=$(cd "$GAME/../xboxrecomp" && pwd)
SDK=${1:-$(cd "$GAME/../../../third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows" 2>/dev/null && pwd)}
CC="$SDK/bin/clang"
OUT="$GAME/build-wasm/threads"
mkdir -p "$OUT/obj"

# The test needs no guest span: a small global base, the same flags otherwise.
WASM_GLOBAL_BASE=${WASM_GLOBAL_BASE:-0x10000}
WASM_INITIAL_MEMORY=${WASM_INITIAL_MEMORY:-$((64 << 20))}
. "$GAME/web/wasm/link-flags.sh"

CFLAGS="--target=wasm32-wasip1-threads -pthread -O2 -fno-delete-null-pointer-checks -mllvm -wasm-enable-sjlj
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID
  -Wno-everything -I$RT/include -I$RT/src -I$RT/src/kernel -I$RT/src/platform"

RTSRC="$RT/src/platform/win32_compat.c $RT/src/platform/host_time.c
       $RT/src/kernel/kernel_guest_cpu.c $RT/src/kernel/kernel_hal.c"
objs=""
for f in $RTSRC "$HERE/test_stubs.c"; do
  o="$OUT/obj/$(basename "$f" .c).o"
  $CC $CFLAGS -c "$f" -o "$o"
  objs="$objs $o"
done

link() {  # out.wasm main.c
  $CC $CFLAGS -c "$2" -o "$OUT/obj/$(basename "$2" .c).o"
  $CC --target=wasm32-wasip1-threads -pthread $objs "$OUT/obj/$(basename "$2" .c).o" -o "$1" $WASM_LDFLAGS
  wasm_memory_json "${1%.wasm}.memory.json"
  echo "built $1 ($(wc -c < "$1") bytes)"
}
link "$OUT/threads_test.wasm" "$HERE/threads_test.c"
link "$OUT/guest_cpu_test.wasm" "$RT/tests/guest_cpu/test_main.c"
