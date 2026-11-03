cmake_minimum_required(VERSION 3.20)

# ============================================================================
# YOUR_GAME_NAME - Static Recompilation
#
# Copy this template to your game project root and customize:
#   1. Change the project name below
#   2. Set XBOXRECOMP_DIR to where you cloned xboxrecomp
#   3. Adjust source file lists as you add game-specific code
#   4. Add any game-specific compile definitions or link libraries
# ============================================================================

project(atv2_recomp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Common definitions
add_compile_definitions(
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)

# ── xboxrecomp toolkit ──────────────────────────────────────────
#
# Option A: xboxrecomp as a subdirectory (simplest)
#   Place xboxrecomp/ next to your game project and use a relative path.
#
# Option B: find_package (if you install xboxrecomp system-wide)
#   find_package(xboxrecomp REQUIRED)
#
# Adjust this path to point to your xboxrecomp clone:
set(XBOXRECOMP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../xboxrecomp" CACHE PATH
    "Path to the xboxrecomp toolkit root directory")

# Add xboxrecomp as a subdirectory -- this builds all 6 runtime libraries
# and provides the 'xboxrecomp' umbrella target to link against.
add_subdirectory(${XBOXRECOMP_DIR} ${CMAKE_BINARY_DIR}/xboxrecomp)

# ── Recompiled game executable ──────────────────────────────────

# Collect generated recompiled code.
# The recomp pipeline outputs files into src/recomp/gen/.
# With --split 1000, you get gen_0000.c, gen_0001.c, etc.
# CONFIGURE_DEPENDS so re-running the recompiler picks up added/removed files
# without a manual re-configure. A plain GLOB is evaluated once at configure
# time, so a newly generated file (an extra chunk, recomp_stubs_unresolved.c)
# is silently left out of the build and shows up as unresolved externals.
file(GLOB RECOMP_GEN_SOURCES CONFIGURE_DEPENDS "src/recomp/gen/*.c")

# Core game sources
set(GAME_SOURCES
    src/main.c
    src/recomp_manual.c
    # Free Ride (RECOMP_FREERIDE=1): straight into Freestyle, Unlimited Time
    src/freeride.c
    # GPU renderer (RECOMP_GPU=1): recorder -> frame packets -> D3D11 consumer
    src/gpu/gpu_rec.c
    src/gpu/gpu_shadergen.c
    src/gpu/gpu_d3d11.c
    # WebGPU path: WGSL twin of the shader generator, the tap (WGSL dump,
    # frame captures for web/replay.html, back-end selector at the flip)
    src/gpu/gpu_shadergen_wgsl.c
    src/gpu/gpu_wgsl_tap.c
    # Test control channel (RECOMP_CONTROL=<port>; src/control, CONTROL.md)
    src/control/control.c
    src/control/control_png.c
    # Add game-specific sources here, e.g.:
    # src/asset_loader.c
    # src/custom_renderer.c
)

# The recomp pipeline also generates a dispatch header and function declarations.
# These are included by the generated .c files:
#   src/recomp/gen/recomp_funcs.h    - extern declarations for all recompiled functions
#   src/recomp/recomp_dispatch.h     - binary search dispatch table
#   src/recomp/recomp_types.h        - register model, ICALL macros, MEM helpers

add_executable(${PROJECT_NAME} WIN32
    ${GAME_SOURCES}
    ${RECOMP_GEN_SOURCES}
)

# Optional native WebGPU back end (RECOMP_GPU_BACKEND=wgpu). OFF by default:
# it needs a webgpu.h implementation (wgpu-native or Dawn) that is not in the
# tree. See WEBGPU.md for the exact download.
option(ATV2_WGPU "Build the WebGPU back end (src/gpu/gpu_wgpu.c) against wgpu-native" OFF)
set(WGPU_NATIVE_DIR "" CACHE PATH "wgpu-native release folder (include/webgpu/webgpu.h, lib/wgpu_native.dll.lib), e.g. third_party/wgpu-native/v29.0.1.1")
if(ATV2_WGPU)
    target_sources(${PROJECT_NAME} PRIVATE src/gpu/gpu_wgpu.c)
    target_compile_definitions(${PROJECT_NAME} PRIVATE ATV2_WGPU=1)
    target_include_directories(${PROJECT_NAME} PRIVATE ${WGPU_NATIVE_DIR}/include)
    set(WGPU_NATIVE_LIB ${WGPU_NATIVE_DIR}/lib/wgpu_native.dll.lib)   # import library of the DLL
    target_link_libraries(${PROJECT_NAME} PRIVATE ${WGPU_NATIVE_LIB})
    # The exe loads wgpu_native.dll from its own folder.
    add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${WGPU_NATIVE_DIR}/lib/wgpu_native.dll $<TARGET_FILE_DIR:${PROJECT_NAME}>)
endif()

# Link against the xboxrecomp umbrella target (all 6 runtime libraries)
target_link_libraries(${PROJECT_NAME} PRIVATE xboxrecomp)
if(NOT WIN32)
    target_link_options(${PROJECT_NAME} PRIVATE -rdynamic)
endif()

# Include paths for generated recomp headers
target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/src/recomp
    ${XBOXRECOMP_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src/gpu
    ${XBOXRECOMP_DIR}/src/kernel   # nv2a_backend.h
    ${XBOXRECOMP_DIR}/src/d3d      # d3d8_swizzle.h
    ${XBOXRECOMP_DIR}/src/usb      # usb_gamepad.h (control channel input)
)

if(WIN32)
# Windows SDK libraries needed at link time
target_link_libraries(${PROJECT_NAME} PRIVATE
    d3d11
    dxgi
    dxguid
    d3dcompiler
    $<IF:$<BOOL:${MINGW}>,xinput1_4,xinput>   # see src/input/CMakeLists.txt
    winmm
    # Lets the fault handler resolve the host RIP back to the generated
    # function's symbol, i.e. to the guest function that faulted.
    dbghelp
    # control channel: sockets, PNG screenshots through WIC
    ws2_32
    windowscodecs
    ole32
)
endif()

# MSVC-specific: large address aware, increase section limit for big generated files
if(MSVC)
    target_link_options(${PROJECT_NAME} PRIVATE
        /LARGEADDRESSAWARE
    )
    # The generated code files can be very large. Increase object file section limit.
    target_compile_options(${PROJECT_NAME} PRIVATE /bigobj)
endif()

# ── Game-specific additions ─────────────────────────────────────
#
# Add any game-specific libraries, loaders, or custom renderers below.
# Examples:
#
# # Custom texture loader for your game's format
# target_sources(${PROJECT_NAME} PRIVATE src/texture_loader.c)
#
# # If your game uses RenderWare, you may need a RW bridge layer
# target_sources(${PROJECT_NAME} PRIVATE src/rw_bridge.c)
#
# # Additional compile definitions for debugging
# target_compile_definitions(${PROJECT_NAME} PRIVATE
#     ENABLE_ICALL_TRACE=1
#     VERBOSE_KERNEL_LOG=1
# )
