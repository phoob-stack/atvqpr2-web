/*
 * control_png.c -- write a BGR image to a PNG with WIC (no extra libraries).
 */
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <initguid.h>
#include <wincodec.h>
#include <stdint.h>
#include <stdlib.h>

#include "control_png.h"

/* rows top-down, 3 bytes per pixel B G R, stride bytes per row. */
int atv2_png_write_bgr(const char *path, const uint8_t *bgr, unsigned w,
                       unsigned h, unsigned stride)
{
    IWICImagingFactory *fac = NULL;
    IWICStream *st = NULL;
    IWICBitmapEncoder *enc = NULL;
    IWICBitmapFrameEncode *fr = NULL;
    IPropertyBag2 *props = NULL;
    WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR;
    wchar_t wpath[MAX_PATH * 2];
    HRESULT hr;
    int ok = 0;

    if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, MAX_PATH * 2))
        return -1;
    hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    (void)hr;   /* S_FALSE / RPC_E_CHANGED_MODE: COM is usable either way */
    hr = CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER,
                          &IID_IWICImagingFactory, (void **)&fac);
    if (FAILED(hr)) goto out;
    if (FAILED(IWICImagingFactory_CreateStream(fac, &st))) goto out;
    if (FAILED(IWICStream_InitializeFromFilename(st, wpath, GENERIC_WRITE))) goto out;
    if (FAILED(IWICImagingFactory_CreateEncoder(fac, &GUID_ContainerFormatPng,
                                                NULL, &enc))) goto out;
    if (FAILED(IWICBitmapEncoder_Initialize(enc, (IStream *)st,
                                            WICBitmapEncoderNoCache))) goto out;
    if (FAILED(IWICBitmapEncoder_CreateNewFrame(enc, &fr, &props))) goto out;
    if (FAILED(IWICBitmapFrameEncode_Initialize(fr, props))) goto out;
    if (FAILED(IWICBitmapFrameEncode_SetSize(fr, w, h))) goto out;
    if (FAILED(IWICBitmapFrameEncode_SetPixelFormat(fr, &fmt))) goto out;
    if (!IsEqualGUID(&fmt, &GUID_WICPixelFormat24bppBGR)) goto out;
    if (FAILED(IWICBitmapFrameEncode_WritePixels(fr, h, stride, stride * h,
                                                 (BYTE *)bgr))) goto out;
    if (FAILED(IWICBitmapFrameEncode_Commit(fr))) goto out;
    if (FAILED(IWICBitmapEncoder_Commit(enc))) goto out;
    ok = 1;
out:
    if (props) IPropertyBag2_Release(props);
    if (fr) IWICBitmapFrameEncode_Release(fr);
    if (enc) IWICBitmapEncoder_Release(enc);
    if (st) IWICStream_Release(st);
    if (fac) IWICImagingFactory_Release(fac);
    return ok ? 0 : -1;
}
