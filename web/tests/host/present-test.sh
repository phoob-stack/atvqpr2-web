#!/usr/bin/env bash
# Present-path check in headless Edge (see present_test.c):
#   web/tests/host/present-test.sh <captures dir> [cap_<n>.gpf]
# Captures are game-derived: the dir is served on 127.0.0.1 only and the
# picture lands in build-wasm/ (outside git).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd); GAME=$(cd "$HERE/../../.." && pwd); RT=$(cd "$GAME/../xboxrecomp" && pwd)
SDK=${WASI_SDK:-$(cd "$GAME/../../../third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows" && pwd)}
OUT="$GAME/build-wasm"; mkdir -p "$OUT"
"$SDK/bin/clang" --target=wasm32-wasip1-threads -pthread -O2 -Wall -Wno-unused-function \
  -I"$GAME/src/gpu" -I"$GAME/src/web" "$HERE/present_test.c" "$GAME/src/web/web_present.c" \
  -o "$OUT/present_test.wasm" -Wl,--import-memory,--export-memory,--shared-memory,--max-memory=4294967296 \
  -Wl,--allow-undefined -Wl,-z,stack-size=1048576
node "$GAME/web/tools/boot.mjs" 15 --wasm present_test.wasm --game "$1" ${2:+--args "$2"} --out "$OUT/present-test"
