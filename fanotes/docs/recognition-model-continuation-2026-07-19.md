# TrOCR continuation audit — 2026-07-19

This audit tested whether the existing bilingual checkpoint should replace the
currently shipped FaNotes model after one additional low-learning-rate epoch.
The NAS handwriting images and GlyphenWerk ZIP were not used for training,
checkpoint selection, or interpolation.

## Resource isolation

- IAM train: 6,482 lines
- IAM validation: 976 lines
- ScaDS German train: 4,886 writer-split lines, repeated twice for language balance
- ScaDS German validation: 517 writer-disjoint lines
- batch size: 1
- gradient accumulation: 16
- encoder learning rate: `4e-6`
- decoder learning rate: `1e-5`
- CPU data-loader workers: 0
- observed training-process high-water RSS: 1,539,168 KiB
- observed process swap: approximately 1 MiB at the end of training
- invalid/non-finite batches: 0

IAM images were extracted once from 100-row parquet groups into a size-checked,
source-fingerprinted cache. The warm cache contains exactly 7,458 images and
prevents all image bytes from being retained in host memory. The first attempt
without this cache was stopped before completing an epoch when host memory PSI
rose above the safety threshold; it produced no checkpoint.

## Same-runtime validation

All rows below were generated with the same Transformers 4.51.3 runtime,
preprocessing, decoding, and validation order.

- shipped base SHA-256: `ca035f573155a8bcd07cc0e690308fef324a9f6025513a100efc108ef930227d`
- continued epoch SHA-256: `703c78d7b13da7f74f5311d116461d8b9a29301124db31dfaf95ca9b3bbe1d07`
- 25% interpolation SHA-256: `d195e8fe1e723f0da53ee30add1688bfb5b5c262e41b34ada79bb6db4826950f`
- 10% interpolation SHA-256: `a1038e4a62b08c964e018d7d2f420a825dcc3db1c1ed5507da0852378bca8a5a`

| Checkpoint | English CER | German CER | Balanced CER | English exact | German exact |
|---|---:|---:|---:|---:|---:|
| shipped base | 3.3798% | 9.2944% | 6.3371% | 51.6393% | 15.0870% |
| continued epoch | 3.4986% | 9.4741% | 6.4864% | 51.0246% | 16.0542% |
| 75% base / 25% continued | 3.4154% | 9.2944% | 6.3549% | 51.6393% | 15.4739% |
| 90% base / 10% continued | 3.3916% | 9.3257% | 6.3587% | 51.5369% | 15.2805% |

The continued checkpoint and both deterministic interpolations have worse
balanced CER than the shipped base. They are rejected and must not be exported,
quantized, released, or evaluated against the untouched test split. The shipped
model remains authoritative.
