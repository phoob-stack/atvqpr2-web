# runtime-flags.sh - what the game build (web/wasm/build.sh) and the prebuilt
# runtime kit (web/wasm/package-runtime.sh) share: the compile flags, the path
# map, the include path and the runtime's source list. Sourced, not run, with
# GAME (this repository) and RT (xboxrecomp) set to absolute paths.
#
# The runtime is everything but the generated C: xboxrecomp's portable
# runtime and this project's browser sources. It goes into rt.a, and the
# game module is the generated objects linked against it.

# The flags every object of the module is compiled with, generated or not.
# nfsu2-web's set (notes/nfsu2-web.md); wasm_compat.h is force-included.
WASM_CFLAGS_COMMON="--target=wasm32-wasip1-threads -pthread -msimd128 -mbulk-memory -mnontrapping-fptoint -mtail-call
  -O2 -fno-delete-null-pointer-checks -mllvm -wasm-enable-sjlj
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -Wno-everything"

# No local path in any object: an assert's __FILE__ (apu_vp.c, nv2a_core.c)
# embedded the checkout's absolute path, so rt.a named the machine it was
# built on and two checkouts never built the same bytes. The two trees map
# to atv2/atvrecomp and atv2/xboxrecomp, as the builder lays them out (its
# work tree is atv2/{atvrecomp,xboxrecomp}), so a builder build and this one
# make the same objects. Under Git Bash clang sees C:/... paths, so the map
# names that form, with both cases of the drive letter.
wasm_prefix_map() {  # dir virtual-path -> flags
  local w
  if command -v cygpath >/dev/null 2>&1; then
    w=$(cygpath -m "$1")
    printf -- "-ffile-prefix-map=%s=$2 " "$(printf %s "${w:0:1}" | tr a-z A-Z)${w:1}" \
      "$(printf %s "${w:0:1}" | tr A-Z a-z)${w:1}"
  else
    printf -- "-ffile-prefix-map=%s=$2 " "$1"
  fi
}
WASM_PREFIX_MAP="$(wasm_prefix_map "$GAME" atv2/atvrecomp)$(wasm_prefix_map "$RT" atv2/xboxrecomp)"

# The game module's memory, for link-flags.sh (source it after this file).
# The guest span ends below 0x84100000 (wasm-mem, WASM-MEM.md); runtime data,
# the main C stack and the heap start there.
WASM_GLOBAL_BASE=${WASM_GLOBAL_BASE:-0x84100000}
WASM_INITIAL_MEMORY=${WASM_INITIAL_MEMORY:-$(( 0x84100000 + (128 << 20) ))}

# Include path of the runtime sources (the generated C needs only its own
# folder: recomp_funcs.h and recomp_types.h).
RUNTIME_INC="-I$RT/include -I$RT/src -I$RT/src/kernel -I$RT/src/d3d -I$RT/src/platform -I$RT/src/usb
  -I$RT/src/nv2a -I$RT/src/apu -I$RT/src/audio -I$RT/src/video -I$RT/src/input -I$GAME/src -I$GAME/src/gpu"

# The runtime's sources, in rt.a's member order. Skipped on purpose: the
# D3D8->D3D11 HLE (d3d8_*), SDL and Win32-only input/video back ends, and the
# D3D11 GPU consumer -- the web build replaces them. main.c and the control
# channel (winsock) are native only: src/web is the browser's main, libc
# shims and the audio/input/present back ends (web/host is the page).
runtime_sources() {
  local f
  for f in "$RT"/src/{apu,audio,kernel,nv2a,platform,usb,video,input}/*.c "$GAME"/src/recomp_manual.c "$GAME"/src/freeride.c "$GAME"/src/roam.c "$GAME"/src/roam_net.c \
           "$GAME"/src/web/*.c "$GAME"/src/wasm/*.c "$GAME"/src/gpu/gpu_rec.c "$GAME"/src/gpu/gpu_shadergen*.c \
           "$GAME"/src/gpu/gpu_wgsl_tap.c; do
    case "$(basename "$f")" in *sdl*|d3d8_*|mkb_input.c|xinput_device.c) continue;; esac
    echo "$f"
  done
}
