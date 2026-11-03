#!/usr/bin/env bash
# Guest memory and MMIO on wasm, end to end (web/wasm/test_mem.c): builds the
# test with the memory layout, the access macros and the device models it
# reaches, links it the way the game must be linked (runtime above the guest
# windows), and runs it under Node's WASI.
#
#   web/wasm/test-mem.sh [wasi-sdk dir]      (bash; outputs in build-wasm/memtest)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
GAME=$(cd "$HERE/../.." && pwd)
RT=$(cd "$GAME/../xboxrecomp" && pwd)
SDK=${1:-$(cd "$GAME/../../../third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows" 2>/dev/null && pwd)}
CC="$SDK/bin/clang"
OUT="$GAME/build-wasm/memtest"
GEN="$GAME/src/recomp/gen"
mkdir -p "$OUT"

CFLAGS="--target=wasm32-wasip1-threads -pthread -msimd128 -mbulk-memory -mnontrapping-fptoint -mtail-call
  -O2 -fno-delete-null-pointer-checks -mllvm -wasm-enable-sjlj
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -Wno-everything"
INC="-I$GEN -I$RT/include -I$RT/src -I$RT/src/kernel -I$RT/src/platform -I$RT/src/usb -I$RT/src/apu
  -I$RT/src/audio -I$RT/src/input"

SRCS="$HERE/test_mem.c
  $RT/src/kernel/wasm_mem.c $RT/src/kernel/xbox_memory_layout.c $RT/src/kernel/guest_vmem.c
  $RT/src/kernel/nv2a_flip_hold.c
  $RT/src/usb/ohci.c $RT/src/usb/usb_gamepad.c
  $RT/src/apu/apu_mmio_hook.c $RT/src/apu/apu_core.c $RT/src/apu/apu_vp.c $RT/src/apu/apu_dsp.c
  $RT/src/apu/apu_wav.c
  $RT/src/platform/win32_compat.c $RT/src/platform/host_time.c"
objs=""
for f in $SRCS; do
  o="$OUT/$(basename "$f" .c).o"
  $CC $CFLAGS $INC -c "$f" -o "$o" || { echo "compile failed: $f"; exit 1; }
  objs="$objs $o"
done

# The link the game needs (see xboxrecomp src/kernel/wasm_mem.h):
#   --global-base=2215641088 (0x84100000) --no-stack-first: runtime above the guest windows
#   --max-memory=4 GB, shared, imported         the windows reach 0xFF110000
# --allow-undefined: the rest of the runtime is not linked; run-wasi-threads.mjs
# stubs whatever is called and names it.
$CC --target=wasm32-wasip1-threads -pthread $objs -o "$OUT/test_mem.wasm" \
  -Wl,--global-base=2215641088,--no-stack-first,-z,stack-size=1048576 \
  -Wl,--import-memory,--export-memory,--shared-memory,--max-memory=4294967296 \
  -Wl,--allow-undefined \
  -mllvm -wasm-enable-sjlj -lsetjmp -lwasi-emulated-mman -lwasi-emulated-signal \
  -lwasi-emulated-process-clocks || { echo "link failed"; exit 1; }
cd "$OUT" && node "$HERE/run-wasi-threads.mjs" "$OUT/test_mem.wasm"
