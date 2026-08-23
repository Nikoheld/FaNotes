# Native formula recognition runtime

FaNotes builds the optional desktop math runtime from a pinned
[CrispEmbed](https://github.com/CrispStrobe/CrispEmbed) source revision. Run:

```bash
npm run stage:enhanced-math-runtime
```

The script builds two CPU-only executables for the current platform: an AVX2
path for modern Intel/AMD systems and a baseline x64 fallback. It reuses the
same build tree, uses one compiler job by default, disables host-specific
`-march=native`, and writes a source/commit/SHA-256 manifest for both files.
FaNotes tries the optimized child process first and can fall back without
crashing the app on old CPUs. Linux and Windows release commands run this
staging step automatically.

A Linux release host can cross-build the Windows pair with a pinned LLVM-MinGW
toolchain instead of accepting an unrelated prebuilt executable:

```bash
FANOTES_NATIVE_TARGET_PLATFORM=win32 \
FANOTES_LLVM_MINGW_ROOT=/absolute/path/to/llvm-mingw \
FANOTES_CRISPEMBED_SOURCE=/absolute/path/to/pinned/CrispEmbed \
FANOTES_NATIVE_BUILD_ROOT=/disk-backed/build-cache \
node scripts/stage-enhanced-math-runtime.cjs
```

The script refuses an unsupported host/target pair or an incomplete toolchain.
The resulting manifest still records and hashes the exact pinned CrispEmbed and
ggml revisions used for both Windows executables. `FANOTES_NATIVE_BUILD_ROOT`
keeps temporary compiler objects off a RAM-backed system `/tmp` when needed.

The non-commercial PosFormer Q4 model is deliberately **not** bundled. FaNotes
downloads it only after explicit CC BY-NC-SA 3.0 acceptance and verifies the
published 10,316,032-byte file against its fixed SHA-256 digest.
