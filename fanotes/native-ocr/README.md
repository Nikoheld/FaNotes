# Native line OCR runtime

`fanotes-ocr` is the PyLaia sidecar built from `crates/fanotes-ort` in this repository. FaNotes starts it
on the first handwriting conversion and exchanges length-prefixed frames with it over stdin/stdout. Before
it builds its ONNX Runtime session it checks `pylaia-iam.onnx` against the size and SHA-256 in
`public/ocr/manifest.json`. It replaces the former `onnxruntime-node` worker thread with the same session
options (CPU provider, sequential, all graph optimizations, CPU memory arena, 1–4 intra-op threads, one
inter-op thread).

The executables are reproducible from source:

```bash
npm run build:native-ocr               # linux-x64 and win32-x64
npm run build:native-ocr -- linux-x64
```

The Windows executable cross-compiles on Linux with the `x86_64-pc-windows-gnu` Rust target and
mingw-w64. `runtime-manifest.json` records the size and SHA-256 of the executable and of the ONNX Runtime
library it loads. That library is not committed: packaging copies the CPU-only `libonnxruntime.so.1` or
`onnxruntime.dll` from the pinned `onnxruntime-node@1.21.0` package next to the executable.
