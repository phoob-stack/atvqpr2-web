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
# Default SDK: atv2-web\third_party, from the main copy (atv2-web\atvrecomp) or a
# worker worktree (atv2-web\work\<name>\atvrecomp).
SDK=${1:-$( { cd "$GAME/../third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows" 2>/dev/null \
          || cd "$GAME/../../../third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows" 2>/dev/null; } && pwd )}
CC="$SDK/bin/clang"
OUT="$GAME/build-wasm"
GEN="$GAME/src/recomp/gen"
mkdir -p "$OUT/gen" "$OUT/rt" "$OUT/fuzz"

# Flags, path map, include path and runtime source list: runtime-flags.sh,
# shared with package-runtime.sh (the prebuilt runtime kit).
. "$HERE/runtime-flags.sh"
CFLAGS="$WASM_CFLAGS_COMMON -include $GAME/src/web/wasm_compat.h $WASM_PREFIX_MAP"
# WASM_CFLAGS_EXTRA: more flags for every compile, e.g. -fno-inline for a
# profiling build whose CPU profiles name each C function (not for shipping).
CFLAGS="$CFLAGS ${WASM_CFLAGS_EXTRA:-}"
# Link configuration (memory, threads, exports): web/wasm/link-flags.sh, with
# the game module's memory map from runtime-flags.sh.
. "$HERE/link-flags.sh"

INC="-I$GEN $RUNTIME_INC"

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
# SKIP_GEN=1 reuses the shard objects of the last run (they take most of the time).
if [ "${SKIP_GEN:-0}" != 1 ]; then
n=0; for f in "$OUT"/gen-src/*.c; do compile "$OUT/gen" "$f" & n=$((n+1)); [ $((n % 8)) = 0 ] && wait; done; wait
fi
echo "== runtime and game sources"
# What is in the runtime, and what is left out and why: runtime_sources in
# runtime-flags.sh.
rm -f "$OUT"/rt/main.o "$OUT"/rt/control*.o
for f in $(runtime_sources); do
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

echo "== game module for the page (build-wasm/atv2.wasm, loaded by web/host)"
# The runtime goes in through an archive, so only what the game reaches is
# linked (nv2a_pb_replay & co. drop out, as in the native static libraries).
# --allow-undefined is bring-up only: whatever is still missing becomes an
# "env" import, and web/host stubs each one with a function that logs its name
# when called -- so a run shows exactly which missing piece it reached first.
rm -f "$OUT/rt.a"; "$SDK/bin/llvm-ar" rcs "$OUT/rt.a" "$OUT"/rt/*.o
# Memory, threads and exports: link-flags.sh (wasm-threads; the global base is
# wasm-mem's map, WASM-MEM.md). --allow-undefined stays for bring-up.
$CC --target=wasm32-wasip1-threads -pthread "$OUT"/gen/*.o "$OUT/rt.a" -o "$OUT/atv2.wasm" \
  $WASM_LDFLAGS -Wl,--allow-undefined -Wl,--error-limit=0 2> "$OUT/link-web.err"
wasm_memory_json "$OUT/atv2.memory.json"
# The page needs no DWARF (traps are named from the name section, which
# stays): 0.5 MB less to fetch. WASM_KEEP_DEBUG=1 keeps it.
if [ "${WASM_KEEP_DEBUG:-0}" != 1 ] && [ -f "$OUT/atv2.wasm" ]; then
  "$SDK/bin/llvm-strip" --strip-debug "$OUT/atv2.wasm" -o "$OUT/atv2.wasm.tmp" && mv -f "$OUT/atv2.wasm.tmp" "$OUT/atv2.wasm"
fi
grep -v "^$" "$OUT/link-web.err" | head -20
[ -f "$OUT/atv2.wasm" ] && ls -la "$OUT/atv2.wasm"

echo "== WGSL generator in wasm vs native"
$CC --target=wasm32-wasip1 -O2 -Wno-everything -I"$GAME/src/gpu" "$GAME/web/tools/wgsl_fuzz.c" \
  "$GAME/src/gpu/gpu_shadergen_wgsl.c" "$GAME/src/gpu/gpu_shadergen.c" -o "$OUT/fuzz/wgsl_fuzz.wasm" &&
  node "$HERE/run-wasi.mjs" "$OUT/fuzz/wgsl_fuzz.wasm" "$OUT/fuzz/out" 200
