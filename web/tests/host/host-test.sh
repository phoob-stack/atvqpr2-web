#!/usr/bin/env bash
# Input + audio back ends in headless Edge (see host_test.c). No game files.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd); GAME=$(cd "$HERE/../../.." && pwd); RT=$(cd "$GAME/../xboxrecomp" && pwd)
SDK=${WASI_SDK:-$(cd "$GAME/../../../third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows" && pwd)}
OUT="$GAME/build-wasm"; mkdir -p "$OUT/host-test/empty"
"$SDK/bin/clang" --target=wasm32-wasip1-threads -pthread -O2 -Wno-everything -D_WASI_EMULATED_SIGNAL \
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -include "$GAME/src/web/wasm_compat.h" \
  -I"$GAME/src/web" -I"$RT/src" -I"$RT/src/platform" -I"$RT/src/input" -I"$RT/src/apu" -I"$RT/src/kernel" -I"$RT/include" \
  "$HERE/host_test.c" "$GAME/src/web/web_input.c" "$GAME/src/web/web_audio.c" \
  "$RT/src/input/keyboard.c" "$RT/src/input/input_map.c" \
  -o "$OUT/host_test.wasm" -Wl,--import-memory,--export-memory,--shared-memory,--max-memory=4294967296 \
  -Wl,--allow-undefined -Wl,-z,stack-size=1048576 -lm
# Enter (VK 13) at 2 s, Z (VK 90) at 3 s, Enter again at 4 s
node "$GAME/web/tools/boot.mjs" 10 --wasm host_test.wasm --game "$OUT/host-test/empty" --keys 2:13,3:90,4:13 \
  ${1:+--audio} --out "$OUT/host-test"
