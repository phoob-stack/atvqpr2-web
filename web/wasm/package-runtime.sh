#!/usr/bin/env bash
# package-runtime.sh - the prebuilt runtime kit: everything the game module
# needs besides the generated C, built from this project's and xboxrecomp's
# sources only. With it a build compiles just the generated files and links
# them against rt.a -- no runtime sources, no wasi-sdk beyond clang/wasm-ld.
# It is what an in-browser build would fetch, and what lets a runtime-only
# update be a relink.
#
#   web/wasm/package-runtime.sh [wasi-sdk dir]
#
# -> dist/atv2-runtime-<atvrecomp>-<xboxrecomp>/ and the same as a .zip
#    (short commit hashes; "-dirty" when either tree has uncommitted changes
#    under the paths that go in). dist/ is not tracked.
#
#   lib/rt.a                     the runtime: runtime_sources (runtime-flags.sh)
#   include/                     recomp_types.h (the generated C's ABI with
#                                the runtime) and wasm_compat.h (force-included)
#   sysroot/, clang/             the wasi-libc headers the generated C reads,
#                                and the libraries the link pulls in, at their
#                                wasi-sdk paths (--sysroot / -resource-dir)
#   flags.json                   compile and link command lines, as clang
#                                driver arguments and as the cc1/wasm-ld
#                                arguments the driver runs
#   undefined.txt                symbols the runtime leaves undefined
#   manifest.json                every file's size and SHA-256
#   LICENSE, licenses/, THIRD-PARTY.md
#
# Nothing here is read from src/recomp/gen or build-wasm: the generated C is
# the player's, made from their disc. verify-runtime.mjs checks the result.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
GAME=$(cd "$HERE/../.." && pwd)
RT=$(cd "$GAME/../xboxrecomp" && pwd)
SDK=${1:-$( { cd "$GAME/../third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows" 2>/dev/null \
          || cd "$GAME/../../../third_party/wasi-sdk/wasi-sdk-34.0-x86_64-windows" 2>/dev/null; } && pwd )}
CC="$SDK/bin/clang"
if command -v py >/dev/null 2>&1; then PY="py -3"; else PY=python3; fi
. "$HERE/runtime-flags.sh"
. "$HERE/link-flags.sh"

# The kit is named after the two commits it was built from.
dirty() {  # repo paths...
  local repo=$1; shift
  [ -n "$(git -C "$repo" status --porcelain --untracked-files=no -- "$@")" ] && echo 1 || true
}
A=$(git -C "$GAME" rev-parse --short=7 HEAD)
X=$(git -C "$RT" rev-parse --short=7 HEAD)
DIRTY=
[ -n "$(dirty "$GAME" src web/wasm LICENSE)$(dirty "$RT" src include templates/runtime LICENSE NOTICE LICENSES)" ] && DIRTY=-dirty
NAME="atv2-runtime-$A-$X$DIRTY"
DIST="$GAME/dist"
PKG="$DIST/$NAME"
STAGE="$DIST/.build-$NAME"
[ -n "$DIRTY" ] && echo "warning: uncommitted changes; the kit is named $NAME" >&2
rm -rf "$PKG" "$PKG.zip" "$STAGE"
mkdir -p "$PKG/lib" "$PKG/include" "$PKG/licenses" "$STAGE/rt" "$STAGE/probe"

echo "== runtime ($NAME)"
# As build.sh compiles it, minus the generated folder on the include path
# (no runtime source includes a generated header).
CFLAGS="$WASM_CFLAGS_COMMON -include $GAME/src/web/wasm_compat.h $WASM_PREFIX_MAP"
n=0
for f in $(runtime_sources); do
  ( o="$STAGE/rt/$(basename "$f" .c).o"
    $CC $CFLAGS $RUNTIME_INC -c "$f" -o "$o" 2>"$o.err" \
      || { rm -f "$o"; echo "FAIL $(basename "$f"): $(grep -m1 'error:' "$o.err")"; } ) &
  n=$((n+1)); [ $((n % 8)) = 0 ] && wait
done
wait
[ "$(ls "$STAGE"/rt/*.o | wc -l)" = $n ] || { echo "runtime compile failed"; exit 1; }
rm -f "$STAGE"/rt/*.err
"$SDK/bin/llvm-ar" rcs "$PKG/lib/rt.a" "$STAGE"/rt/*.o
echo "$n objects -> lib/rt.a"

echo "== headers"
# The generated C includes recomp_funcs.h (its own), recomp_types.h, and the C
# headers tools/recomp writes into each file (translator.py: math.h; stddef,
# stdio, stdlib in the dispatch and stub files). The kit's copy of
# recomp_types.h is the one the runtime was built for.
tr -d '\r' < "$RT/templates/runtime/recomp_types.h" > "$PKG/include/recomp_types.h"
tr -d '\r' < "$GAME/src/web/wasm_compat.h" > "$PKG/include/wasm_compat.h"
printf '#include "recomp_types.h"\n#include <math.h>\n#include <stddef.h>\n#include <stdio.h>\n#include <stdlib.h>\n' > "$STAGE/probe/probe.c"
$CC $WASM_CFLAGS_COMMON -include "$PKG/include/wasm_compat.h" -I"$PKG/include" -M "$STAGE/probe/probe.c" > "$STAGE/probe/deps.mk"

# A link of nothing but the runtime shows the driver's wasm-ld command line
# (the libraries, crt1, builtins) and, with every runtime object kept, what
# the runtime leaves undefined -- as build.sh's trial link does.
"$CC" --target=wasm32-wasip1-threads -pthread "$STAGE/rt/$(ls "$STAGE/rt" | head -1)" -o "$STAGE/probe/x.wasm" \
  $WASM_LDFLAGS -Wl,--allow-undefined -Wl,--error-limit=0 -### > "$STAGE/probe/link.txt" 2>&1
"$CC" --target=wasm32-wasip1-threads -pthread "$STAGE"/rt/*.o -o "$STAGE/probe/all.wasm" \
  -Wl,--no-entry -Wl,--export-all -Wl,--no-gc-sections -Wl,--error-limit=0 $WASM_LDFLAGS 2> "$STAGE/probe/all.err" || true

echo "== kit"
export PKG STAGE SDK GAME RT NAME CC WASM_CFLAGS_COMMON WASM_LDFLAGS
export WASM_INITIAL_MEMORY WASM_MAX_MEMORY WASM_GLOBAL_BASE WASM_STACK_SIZE
export ATV_COMMIT=$(git -C "$GAME" rev-parse HEAD) XR_COMMIT=$(git -C "$RT" rev-parse HEAD) DIRTY
$PY "$HERE/package-runtime.py"
rm -rf "$STAGE"
ls -la "$PKG.zip"

echo "== verify-runtime"
# Nothing from the game in the kit (the game's XBE, when given as
# VERIFY_XBE, adds the shared-strings check).
node "$HERE/verify-runtime.mjs" "$PKG" --sdk "$SDK" ${VERIFY_XBE:+--xbe "$VERIFY_XBE"} \
  || { echo "verify-runtime failed: $PKG is not fit to ship"; exit 1; }
