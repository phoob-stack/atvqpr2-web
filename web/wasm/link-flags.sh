# link-flags.sh - the link configuration of every wasm32-wasip1-threads
# module (the game, web/wasm/build.sh; the thread tests,
# web/tests/threads/build.sh). Sourced, not run. Owner: wasm-threads; the
# guest span below is wasm-mem's (WASM-MEM.md), see WASM-THREADS.md.
#
# Memory: one shared WebAssembly.Memory, imported (the page creates it before
# any Worker exists and hands the same object to all of them) and exported.
#   [0, WASM_GLOBAL_BASE)            the guest span (wasm-mem): guest
#                                    address = linear address there
#   WASM_GLOBAL_BASE ...             runtime data, then the main thread's C
#                                    stack (--no-stack-first), then the heap
#                                    (malloc; every other thread's C stack
#                                    and TLS come from it)
#   up to WASM_MAX_MEMORY            memory.grow, shared: never moves
# Override any of these in the environment before sourcing.

: "${WASM_GLOBAL_BASE:=0x0C000000}"       # 192 MB: provisional until wasm-mem's span is final
: "${WASM_STACK_SIZE:=8388608}"           # 8 MB C stack for main (the guest main thread)
: "${WASM_MAX_MEMORY:=4294967296}"        # 4 GB, the wasm32 limit
# Initial memory: the guest span, runtime data and stack, and 64 MB of heap.
# Must be a multiple of 64 KB; the page creates the Memory with exactly this
# many pages (build.sh writes it to game.memory.json).
if [ -z "${WASM_INITIAL_MEMORY:-}" ]; then
  WASM_INITIAL_MEMORY=$(( ( (WASM_GLOBAL_BASE + WASM_STACK_SIZE + (128 << 20)) + 65535) / 65536 * 65536 ))
fi

WASM_LDFLAGS="-Wl,--import-memory -Wl,--export-memory -Wl,--shared-memory
  -Wl,--max-memory=$((WASM_MAX_MEMORY)) -Wl,--initial-memory=$((WASM_INITIAL_MEMORY))
  -Wl,--global-base=$((WASM_GLOBAL_BASE)) -Wl,-z,stack-size=$WASM_STACK_SIZE -Wl,--no-stack-first
  -Wl,--export=wasi_thread_start -Wl,--export=malloc -Wl,--export=free
  -Wl,--export=xbox_WasmHostTickWord -Wl,--export=xbox_WasmPollWatchTable
  -lsetjmp
  -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid"

# Writes <out>.memory.json: what the page needs to create the Memory.
wasm_memory_json() {  # out.json
  printf '{ "initialPages": %d, "maximumPages": %d, "globalBase": %d, "stackSize": %d, "shared": true }\n' \
    $((WASM_INITIAL_MEMORY / 65536)) $((WASM_MAX_MEMORY / 65536)) $((WASM_GLOBAL_BASE)) $((WASM_STACK_SIZE)) > "$1"
}
