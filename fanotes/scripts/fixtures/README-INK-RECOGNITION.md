# Ink recognition check fixtures

`ink-recognition-cases.json` holds the cases `scripts/check-ink-recognition.mjs` runs through the
full desktop pipeline (WASM grouping/rendering/decoding plus the native `fanotes-ocr` sidecar).

- `iam-ondb-a01-001z-01`: the public IAM On-Line example line `a01-001z-01.xml`
  (`By Trevor Williams. A move`), the same pen trace as `iam-online-a01-001z-01.json`.
- `scads-test-NN`: lines from the ScaDS.AI German Line/Word Handwriting dataset
  (CC BY 4.0, DOI 10.5281/zenodo.18301532), writer-disjoint from training, with each scanned line
  traced into pen strokes. Coordinates are normalized per line and lightly simplified.

The cases are only used by the recognition check and are not shipped in FaNotes packages. A larger
private evaluation set (BRUSH, IAM and ScaDS test splits) is produced by
`scripts/ink-model/make_cases.py` and pointed at with `FANOTES_INK_CASES`.
