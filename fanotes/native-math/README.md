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

The non-commercial PosFormer Q4 model is deliberately **not** bundled. FaNotes
downloads it only after explicit CC BY-NC-SA 3.0 acceptance and verifies the
published 10,316,032-byte file against its fixed SHA-256 digest.
