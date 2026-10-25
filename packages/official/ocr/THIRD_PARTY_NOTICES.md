# Third-party components

- ImageReader 1.0.2, xland, selected under the user's confirmed authorization: https://github.com/xland/ImageReader/tree/896830aad60f574a39fdbd9f7967177eb149cb0b
- TinyOCR, xland: https://github.com/xland/TinyOCR/tree/1a8516a055328bd15c7d428f29ffdf2893b047ec
- Ling, xland, MIT: https://github.com/xland/Ling/tree/2ae45005b2863b004b4432bfe85d6e63d7ee44ca
- ONNX Runtime 1.23.2, Microsoft, MIT: https://github.com/microsoft/onnxruntime/tree/v1.23.2
- OpenCV 4.14.0, Apache-2.0: https://github.com/opencv/opencv/tree/0654a42e19215ef25b1d367d822f3c630447e7c7
- Clipper2 and embedded model notices remain in the selected native source tree.

This package does not grant a new license to ImageReader or its models. The agreed project authorization remains applicable. Native preparation retains the exact source notices; distribution must retain the accompanying legal files along with this attribution.

## Microsoft Visual C++ V14 Redistributable and Runtime

The CPU ONNX Runtime DLL requires the app-local x64 Microsoft Visual C++ release
runtime. This package includes only the pinned redistributable MSVCP140,
MSVCP140_1, VCRUNTIME140 and VCRUNTIME140_1 DLLs, version 14.51.36247, obtained
from Microsoft's official Visual Studio payload. No runtime installer runs on
the user's machine. Copyright Microsoft Corporation. All rights reserved.

The original Microsoft license and a plain-text reading copy are in
`legal/Microsoft-VC-Runtime-LICENSE.docx` and
`legal/Microsoft-VC-Runtime-LICENSE.txt`. Exact download URLs, version and
SHA-256 records are in `legal/Microsoft-VC-Runtime-provenance.json`.

Official license link: <https://aka.ms/VCRedistLicense>.
