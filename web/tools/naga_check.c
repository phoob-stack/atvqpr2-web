/* naga_check.c - every .wgsl file of a folder through wgpu-native, whose
 * WGSL front end is naga: the same parser and validator Firefox's WebGPU
 * uses (Firefox ships wgpu). Chromium's Tint accepting a module says
 * nothing about naga; this does, on this PC, with the already-present
 * third_party/wgpu-native (no download).
 *
 *   node web/tools/naga-check.mjs <folder of .wgsl> [...more folders or files]
 * builds this with MSVC and runs it. By hand:
 *   cl /nologo /I <wgpu>/include naga_check.c <wgpu>/lib/wgpu_native.dll.lib
 *   naga_check.exe <file.wgsl>...   (wgpu_native.dll next to it or on PATH)
 * Output: one line per failing module with naga's message; exit 1 if any.
 * Modules with `enable clip_distances;` need the device feature; the
 * adapter's is requested when it has it (a module needing a missing feature
 * is reported as such, not as a naga failure).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include <webgpu/webgpu.h>
#include <webgpu/wgpu.h>

static WGPUInstance s_inst;
static WGPUAdapter s_adapter;
static WGPUDevice s_dev;
static char s_err[8192];
static int s_nerr;

static void on_adapter(WGPURequestAdapterStatus st, WGPUAdapter a, WGPUStringView m, void *u1, void *u2)
{
    (void)m; if (st == WGPURequestAdapterStatus_Success) *(WGPUAdapter *)u1 = a; *(int *)u2 = 1;
}
static void on_device(WGPURequestDeviceStatus st, WGPUDevice d, WGPUStringView m, void *u1, void *u2)
{
    if (st == WGPURequestDeviceStatus_Success) *(WGPUDevice *)u1 = d;
    else fprintf(stderr, "no device: %.*s\n", (int)m.length, m.data);
    *(int *)u2 = 1;
}
static void on_error(WGPUDevice const *d, WGPUErrorType t, WGPUStringView m, void *u1, void *u2)
{
    (void)d; (void)t; (void)u1; (void)u2;
    s_nerr++;
    snprintf(s_err, sizeof s_err, "%.*s", (int)(m.length > 8000 ? 8000 : m.length), m.data);
}
static int wait(volatile int *done)
{
    for (int i = 0; i < 200000 && !*done; i++) {
        if (s_dev) wgpuDevicePoll(s_dev, 1, NULL);
        wgpuInstanceProcessEvents(s_inst);
        if (!*done && i > 1000) Sleep(0);
    }
    return *done;
}

static char *slurp(const char *path, size_t *n)
{
    FILE *f = fopen(path, "rb");
    char *b;
    long sz;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END); sz = ftell(f); fseek(f, 0, SEEK_SET);
    b = malloc((size_t)sz + 1);
    *n = fread(b, 1, (size_t)sz, f); b[*n] = 0;
    fclose(f);
    return b;
}

int main(int argc, char **argv)
{
    volatile int got = 0;
    WGPURequestAdapterOptions ao = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    WGPUDeviceDescriptor dd = WGPU_DEVICE_DESCRIPTOR_INIT;
    WGPUFeatureName feat[4];
    size_t nf = 0;
    int clip, ok = 0, bad = 0, skipped = 0;

    if (!(s_inst = wgpuCreateInstance(NULL))) { fprintf(stderr, "no instance\n"); return 2; }
    wgpuInstanceRequestAdapter(s_inst, &ao, (WGPURequestAdapterCallbackInfo){
        .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_adapter, .userdata1 = &s_adapter, .userdata2 = (void *)&got });
    if (!wait(&got) || !s_adapter) { fprintf(stderr, "no adapter\n"); return 2; }
    clip = wgpuAdapterHasFeature(s_adapter, WGPUFeatureName_ClipDistances);
    if (clip) feat[nf++] = WGPUFeatureName_ClipDistances;
    if (wgpuAdapterHasFeature(s_adapter, WGPUFeatureName_TextureCompressionBC)) feat[nf++] = WGPUFeatureName_TextureCompressionBC;
    dd.requiredFeatureCount = nf; dd.requiredFeatures = feat;
    dd.uncapturedErrorCallbackInfo.callback = on_error;
    got = 0;
    wgpuAdapterRequestDevice(s_adapter, &dd, (WGPURequestDeviceCallbackInfo){
        .mode = WGPUCallbackMode_AllowSpontaneous, .callback = on_device, .userdata1 = &s_dev, .userdata2 = (void *)&got });
    if (!wait(&got) || !s_dev) return 2;
    {
        uint32_t v = wgpuGetVersion();
        printf("wgpu-native %u.%u.%u.%u (naga), clip-distances %s\n", v >> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255,
               clip ? "yes" : "no");
    }

    for (int i = 1; i < argc; i++) {
        size_t n;
        char *src = slurp(argv[i], &n);
        if (!src) { printf("CANNOT READ %s\n", argv[i]); bad++; continue; }
        if (!clip && strstr(src, "enable clip_distances")) { skipped++; free(src); continue; }
        WGPUShaderSourceWGSL w = { .chain = { .sType = WGPUSType_ShaderSourceWGSL }, .code = { src, n } };
        WGPUShaderModuleDescriptor d = { .nextInChain = &w.chain, .label = { argv[i], strlen(argv[i]) } };
        int before = s_nerr;
        WGPUShaderModule m = wgpuDeviceCreateShaderModule(s_dev, &d);
        wgpuDevicePoll(s_dev, 1, NULL);
        if (s_nerr != before) { printf("FAIL %s\n%s\n", argv[i], s_err); bad++; }
        else ok++;
        if (m) wgpuShaderModuleRelease(m);
        free(src);
    }
    printf("%d modules accepted by naga, %d rejected%s\n", ok, bad, skipped ? " (some clip_distances modules skipped: no feature)" : "");
    return bad ? 1 : 0;
}
